import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import raw from '../crawler/config/external-sources.json';
import { runExternalSources, type ExternalRunDeps } from '../crawler/lib/external/run';
import { parseExternalSettings } from '../crawler/lib/external/sources';
import { ExternalFetchError, type PoliteFetcher } from '../crawler/lib/external/fetch';
import { ALLOW_ALL } from '../crawler/lib/external/robots';
import { CrawlerState } from '../crawler/lib/state';
import { IngestError, sendItem } from '../crawler/lib/ingest';
import type { ExternalPayload } from '../crawler/lib/external/filter';

vi.mock('../crawler/lib/ingest', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/ingest')>(), sendItem: vi.fn() }));

const fixture = (name: string) => readFileSync(new URL(`./fixtures/external/${name}`, import.meta.url), 'utf8');
const pages: Record<string, string | Error | null> = {};
const lookup = async (url: string) => {
  const hit = Object.entries(pages).find(([prefix]) => url.startsWith(prefix));
  if (!hit) throw new ExternalFetchError(`no fixture for ${url}`);
  if (hit[1] instanceof Error) throw hit[1];
  return hit[1] === null ? null : { status: 200, url, text: hit[1] };
};
const getMock = vi.fn(lookup);
const fetcher = { get: getMock, robotsFor: vi.fn(async () => ALLOW_ALL), pace: vi.fn(async () => {}) } as unknown as PoliteFetcher;
const settingsWith = (enable: string[], patch: Record<string, unknown> = {}) => {
  const value = structuredClone(raw) as typeof raw & Record<string, unknown>;
  for (const source of value.sources) source.enabled = enable.includes(source.id);
  return parseExternalSettings({ ...value, ...patch });
};
let dir: string;
let state: CrawlerState;
const log = vi.fn();
const api = new URL('https://ingest.invalid/api/v1/ingest');
const sent = () => vi.mocked(sendItem).mock.calls.map(call => call[2] as ExternalPayload);
const run = (overrides: Partial<ExternalRunDeps> = {}) => runExternalSources({
  settings: settingsWith(['pangpang']), state, api, token: 'offline-token', stopped: () => false, fetcher, dryRun: false, log: log as unknown as ExternalRunDeps['log'],
  now: () => new Date('2026-10-22T00:30:00Z'), ...overrides,
});
beforeEach(async () => {
  for (const key of Object.keys(pages)) delete pages[key];
  pages['https://09pangpang.com/'] = fixture('pangpang.html');
  pages['https://momcalendar.com/'] = fixture('momcalendar.html');
  pages['https://snapup.co.kr/'] = fixture('snapup.html');
  dir = await mkdtemp(join(tmpdir(), 'agamajung-external-'));
  state = await CrawlerState.open(join(dir, 'state.json'));
  vi.mocked(sendItem).mockReset();
  vi.mocked(sendItem).mockResolvedValue(undefined);
  getMock.mockReset(); getMock.mockImplementation(lookup); log.mockClear();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('external items go out as kind external_listing candidates, baby-only, with the source id as seller found_via', async () => {
  const summary = await run();
  expect(sent().map(item => item.source_url)).toEqual(['https://09pangpang.com/deal/101?utm_source=ad&id=7', 'https://09pangpang.com/deal/102']);
  expect(sent().every(item => item.kind === 'external_listing' && item.source === 'pangpang' && item.price_basis === 'external_listing')).toBe(true);
  expect(vi.mocked(sendItem).mock.calls[0].slice(0, 2)).toEqual([api, 'offline-token']);
  expect(summary).toMatchObject({ sources: 1, items_sent: 2, items_skipped: 1, candidates: 1 });
  expect(state.candidates).toEqual([expect.objectContaining({ handle: 'synthetic_seller', found_via: 'pangpang', sample_urls: ['https://09pangpang.com/deal/101?id=7'] })]);
  expect(state.lastExternalRun).toBe('2026-10-22T00:30:00.000Z');
  expect(state.followingHandles).toEqual([]);
});

test('sources run in the priority order and disabled sources make no requests', async () => {
  await run({ settings: settingsWith(['snapup', 'pangpang', 'momcalendar']) });
  expect(getMock.mock.calls.map(call => new URL(call[0]).host)).toEqual(['09pangpang.com', 'momcalendar.com', 'snapup.co.kr']);
  expect(log).toHaveBeenCalledWith('external_skip', { source: 'buyg', reason: 'disabled' });
});

test('with the shipped defaults BUYG is not requested or rendered', async () => {
  const render = vi.fn();
  const shipped = parseExternalSettings(raw);
  await run({ settings: shipped, render });
  expect(getMock.mock.calls.some(call => call[0].includes('buyg.kr'))).toBe(false);
  expect(render).not.toHaveBeenCalled();
});

test('dry-run fetches and parses but never sends, records candidates or saves state', async () => {
  const save = vi.spyOn(state, 'save');
  const add = vi.spyOn(state, 'addCandidate');
  const summary = await run({ dryRun: true });
  expect(getMock).toHaveBeenCalled();
  expect(sendItem).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(state.lastExternalRun).toBeUndefined();
  expect(summary.items_sent).toBe(0);
  expect(log).toHaveBeenCalledWith('external_source', { source: 'pangpang', items: 3, blocked_requests: 0, needs_review: false, dry_run: true });
  expect(log).toHaveBeenCalledWith('external_run', expect.objectContaining({ dry_run: true }));
});

test('a 400 response skips only that item; the next item is still sent', async () => {
  vi.mocked(sendItem).mockRejectedValueOnce(new IngestError('수집 API 요청 실패(400)', 400));
  const summary = await run();
  expect(sendItem).toHaveBeenCalledTimes(2);
  expect(summary.items_sent).toBe(1);
  expect(log).toHaveBeenCalledWith('warn', { scope: 'external', source: 'pangpang', status: 400 });
});

test.each([401, 403, 404, 405, 413, 429, 500, 503, undefined])('ingest status %s stops the run immediately', async status => {
  vi.mocked(sendItem).mockRejectedValue(new IngestError('수집 API 실패', status));
  await expect(run({ settings: settingsWith(['pangpang', 'momcalendar']) })).rejects.toMatchObject({ status });
  expect(sendItem).toHaveBeenCalledTimes(1);
  expect(getMock.mock.calls.some(call => call[0].includes('momcalendar'))).toBe(false);
  expect(state.lastExternalRun).toBeUndefined();
});

test('a fetch or parse failure in one source is logged and the next source still runs', async () => {
  pages['https://09pangpang.com/'] = new ExternalFetchError('boom');
  pages['https://momcalendar.com/'] = '<ul><li><a href="/e/1">조이 유모차 공구 549,000원</a></li></ul>';
  await run({ settings: settingsWith(['pangpang', 'momcalendar']) });
  expect(log).toHaveBeenCalledWith('error', { scope: 'external', source: 'pangpang' });
  expect(sent().map(item => item.source)).toEqual(['momcalendar']);
  expect(state.lastExternalRun).toBeDefined();
});

test('a malformed item_selector is a source error, not a crash', async () => {
  const settings = settingsWith(['pangpang', 'momcalendar']);
  settings.sources[0].item_selector = 'div:nth-child(2)';
  await run({ settings });
  expect(log).toHaveBeenCalledWith('error', { scope: 'external', source: 'pangpang' });
  expect(sent().length).toBeGreaterThan(0);
});

test('stopped() halts before any request, and between items', async () => {
  await run({ stopped: () => true });
  expect(getMock).not.toHaveBeenCalled();
  expect(sendItem).not.toHaveBeenCalled();
  await run({ stopped: () => vi.mocked(sendItem).mock.calls.length >= 1 });
  expect(sendItem).toHaveBeenCalledTimes(1);
});

test('render:auto renders only when static HTML yields nothing; render:true never fetches statically', async () => {
  const render = vi.fn(async () => ({ html: fixture('buyg-rendered.html'), blocked: 0 }));
  pages['https://snapup.co.kr/'] = '<html><body><div id="app"></div></body></html>';
  const settings = settingsWith(['snapup', 'buyg']);
  settings.sources.find(source => source.id === 'snapup')!.origin = 'https://snapup.co.kr';
  await run({ settings, render });
  expect(render).toHaveBeenCalledTimes(2);
  expect(getMock.mock.calls.map(call => new URL(call[0]).host)).toEqual(['snapup.co.kr']);
  const rendered = render.mock.calls as unknown as [string, { origin: string; robots: unknown; pace: unknown }][];
  expect(rendered.map(call => call[0])).toEqual(['https://buyg.kr/', 'https://snapup.co.kr/influencer/calendar']);
  expect(rendered[0][1]).toMatchObject({ origin: 'https://buyg.kr', robots: ALLOW_ALL });
  pages['https://snapup.co.kr/'] = fixture('snapup.html');
  render.mockClear();
  await run({ settings: settingsWith(['snapup']), render });
  expect(render).not.toHaveBeenCalled();
});

test('blocked rendered requests with zero items are flagged needs_review', async () => {
  const render = vi.fn(async () => ({ html: '<html><body></body></html>', blocked: 3 }));
  await run({ settings: settingsWith(['buyg']), render });
  expect(log).toHaveBeenCalledWith('external_source', expect.objectContaining({ source: 'buyg', items: 0, blocked_requests: 3, needs_review: true }));
});

test('a robots-blocked entry page is counted and flagged, without sending anything', async () => {
  pages['https://09pangpang.com/'] = null;
  await run();
  expect(sendItem).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('external_source', expect.objectContaining({ blocked_requests: 1, needs_review: true }));
});

test('follow_detail_links only opens same-origin detail pages for items missing price or dates', async () => {
  pages['https://09pangpang.com/'] = '<ul><li><a href="/d/1">트립트랩 공구</a> 공구 오픈</li></ul>';
  pages['https://09pangpang.com/d/1'] = '<main>기간 10/26~10/28 공구가 390,000원</main>';
  getMock.mockImplementation(async (url: string) => ({ status: 200, url, text: pages[url] as string ?? pages['https://09pangpang.com/'] as string }));
  await run({ settings: settingsWith(['pangpang'], { follow_detail_links: true }) });
  expect(getMock.mock.calls.map(call => call[0])).toEqual(['https://09pangpang.com/search/r/%EC%9C%A1%EC%95%84%ED%85%9C', 'https://09pangpang.com/d/1']);
  expect(sent()[0]).toMatchObject({ price_hint: 390000 });
});

test('no log call carries title, text or seller_name', async () => {
  const render = vi.fn(async () => ({ html: fixture('buyg-rendered.html'), blocked: 1 }));
  vi.mocked(sendItem).mockRejectedValueOnce(new IngestError('x', 400));
  await run({ settings: settingsWith(['pangpang', 'momcalendar', 'buyg', 'snapup']), render });
  const keys = log.mock.calls.flatMap(call => Object.keys((call[1] ?? {}) as object));
  for (const forbidden of ['title', 'text', 'seller_name']) expect(keys).not.toContain(forbidden);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/트립트랩|스토케|390,000/);
});
