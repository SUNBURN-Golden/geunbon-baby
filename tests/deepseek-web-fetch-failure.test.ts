import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { catalogSearchUrls, loadGeunbonCatalog } from '../crawler/src/deepseek-web/catalog';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { emptyMemory, loadMemory, saveMemory } from '../crawler/src/deepseek-web/memory';
import { runDeepSeekWeb, type RunnerOptions } from '../crawler/src/deepseek-web/runner';
import { fixture } from './helpers/collector';

const first = 'https://shop.example/deal';
const sameHost = 'https://shop.example/another';
const other = 'https://other.example/product';
const robots = 'https://shop.example/robots.txt';
const start = Date.parse('2026-11-20T05:35:00Z');
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function setup(reply: (url: string, signal: AbortSignal) => Response | Promise<Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'dsw-fetch-failure-'));
  const f = fixture();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => f.close());
  const config = loadDeepSeekWebConfig();
  config.fetch.min_interval_ms = 0;
  config.fetch.jitter_ms = [0, 0];
  config.fetch.timeout_ms = 200;
  let now = start;
  const complete = vi.fn();
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    requested.push(target);
    return reply(target, init!.signal!);
  };
  const run = (urls: string[], options?: Partial<RunnerOptions>) => runDeepSeekWeb({
    mode: 'once', stateDir: dir, store: f.store, urls, fetchImpl, client: { complete },
    now: () => now, loadConfig: () => config, ...options,
  });
  const outcomeText = () => readFileSync(join(dir, 'outcomes.jsonl'), 'utf8');
  return { dir, config, run, complete, requested, outcomeText, advance: (ms: number) => { now += ms; } };
}

function live(url: string) {
  return new Response(url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : '<main><h1>Other content</h1></main>');
}

test.each([
  { stage: 'page', status: 403, header: '120', delay: 120_000 },
  { stage: 'page', status: 429, header: new Date(start + 45_000).toUTCString(), delay: 45_000 },
  { stage: 'robots', status: 403, header: 'fixture-private-header', delay: 600_000 },
  { stage: 'robots', status: 429, header: new Date(start - 60_000).toUTCString(), delay: 600_000 },
])('$stage $status defers the responding host and retries at the persisted deadline', async ({ stage, status, header, delay }) => {
  let reject = true;
  const s = setup(url => reject && url === (stage === 'robots' ? robots : first)
    ? new Response('fixture-private-body', { status, headers: { 'retry-after': header } })
    : live(url));
  const memory = emptyMemory();
  memory.pending_urls = [first, sameHost];
  await saveMemory(s.dir, memory);

  expect(await s.run([first, sameHost, other])).toMatchObject({ outcome: 'completed', deepseek_calls_attempted: 0, backoff: null });
  expect(s.requested).toEqual([robots, ...(stage === 'page' ? [first] : []), 'https://other.example/robots.txt', other]);
  expect(await loadMemory(s.dir)).toMatchObject({ fetch_retry_after: { 'shop.example': start + delay }, pending_urls: [first, sameHost], gone_urls: {} });
  expect(s.outcomeText().split('\n').filter(Boolean).map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    url: first, outcome: 'fetch_failed',
    detail: { reason: 'http_host_backoff', hostname: 'shop.example', stage, status, retry_after: new Date(start + delay).toISOString() },
  }));
  expect(s.outcomeText()).not.toContain('fixture-private');

  s.advance(delay - 1);
  s.requested.length = 0;
  reject = false;
  expect(await s.run([first])).toMatchObject({ outcome: 'completed', backoff: null });
  expect(s.requested).toEqual([]);
  s.advance(1);
  await s.run([first]);
  expect(s.requested).toEqual([robots, first, sameHost]);
  expect(await loadMemory(s.dir)).toMatchObject({ fetch_retry_after: {}, pending_urls: [] });
  expect(s.complete).not.toHaveBeenCalled();
});

test.each([
  { status: 429, headers: { 'retry-after': '120' }, delay: 120_000 },
  { status: 403, headers: undefined, delay: 600_000 },
])('robots $status cooldown expires at its original deadline within a tick', async ({ status, headers, delay }) => {
  const afterExpiry = 'https://shop.example/after-expiry';
  let robotsRequests = 0;
  const s = setup(url => {
    if (url === robots && ++robotsRequests === 1) return new Response(null, { status, headers });
    if (url === other) s.advance(delay);
    return live(url);
  });
  const memory = emptyMemory();
  memory.pending_urls = [first, sameHost, afterExpiry];
  await saveMemory(s.dir, memory);

  expect(await s.run([first, sameHost, other, afterExpiry])).toMatchObject({ outcome: 'completed', deepseek_calls_attempted: 0, backoff: null });
  expect(s.requested).toEqual([robots, 'https://other.example/robots.txt', other, robots, afterExpiry]);
  expect(await loadMemory(s.dir)).toMatchObject({ fetch_retry_after: { 'shop.example': start + delay }, pending_urls: [first, sameHost] });
  const outcomes = s.outcomeText().trim().split('\n').map(line => JSON.parse(line));
  expect(outcomes.filter(row => row.detail?.reason === 'http_host_backoff')).toMatchObject([
    { url: first, outcome: 'fetch_failed', detail: { status, stage: 'robots', retry_after: new Date(start + delay).toISOString() } },
  ]);
});

test('page 404 after a redirect removes both canonical URLs and their metadata', async () => {
  const s = setup(url => {
    if (url === first) return new Response(null, { status: 301, headers: { location: '/another' } });
    if (url === sameHost) return new Response(null, { status: 404 });
    return live(url);
  });
  const memory = emptyMemory();
  memory.pending_urls = [first, sameHost];
  for (const url of memory.pending_urls) memory.pending_catalog_meta[url] = { catalog_product_id: 'test-stroller', category: 'stroller' };
  await saveMemory(s.dir, memory);
  expect(await s.run([first, other])).toMatchObject({ outcome: 'completed', backoff: null, deepseek_calls_attempted: 0 });
  expect(s.requested).toEqual([robots, first, sameHost, 'https://other.example/robots.txt', other]);
  const saved = await loadMemory(s.dir);
  expect(saved).toMatchObject({ gone_urls: { [first]: 404, [sameHost]: 404 }, pending_urls: [] });
  expect(saved.pending_catalog_meta).toEqual({});
  expect(s.outcomeText()).toContain('"status":404,"reason":"http_gone"');
});

test('410 in the unconditional fallback after an unusable 304 is a URL result', async () => {
  let attempt = 0;
  const s = setup(url => url === first ? new Response(null, { status: attempt++ === 0 ? 304 : 410 }) : live(url));
  expect(await s.run([first, other])).toMatchObject({ outcome: 'completed', backoff: null, deepseek_calls_attempted: 0 });
  expect(s.requested).toEqual([robots, first, first, 'https://other.example/robots.txt', other]);
  expect((await loadMemory(s.dir)).gone_urls).toEqual({ [first]: 410 });
});

test('5xx, transport failures and request/body timeouts keep pending work retryable', async () => {
  const http = 'https://shop.example/unavailable';
  const request = 'https://shop.example/request-timeout';
  const body = 'https://shop.example/body-timeout';
  const transport = 'https://shop.example/transport';
  const failures = [http, request, body, transport];
  const s = setup((url, signal) => {
    const onAbort = (fail: (reason: unknown) => void) => signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    if (url === http) return new Response('fixture-private-body', { status: 503 });
    if (url === request) return new Promise<Response>((_, reject) => onAbort(reject));
    if (url === body) return new Response(new ReadableStream({ start: controller => onAbort(reason => controller.error(reason)) }));
    if (url === transport) throw new Error('fixture-private-exception');
    return live(url);
  });
  const memory = emptyMemory();
  memory.pending_urls = failures;
  await saveMemory(s.dir, memory);

  expect(await s.run([...failures, other])).toMatchObject({ outcome: 'completed', deepseek_calls_attempted: 0, backoff: null });
  expect(s.requested).toEqual([robots, ...failures, 'https://other.example/robots.txt', other]);
  expect(await loadMemory(s.dir)).toMatchObject({ pending_urls: failures, fetch_retry_after: {}, gone_urls: {} });
  expect(s.outcomeText()).not.toContain('fixture-private');
  expect(s.outcomeText().trim().split('\n').map(line => JSON.parse(line)).filter(row => row.outcome === 'fetch_failed')).toMatchObject([
    { url: http, detail: { reason: 'http_error', status: 503 } },
    { url: request, detail: { reason: 'fetch_timeout', phase: 'request' } },
    { url: body, detail: { reason: 'fetch_timeout', phase: 'body' } },
    { url: transport, detail: { reason: 'fetch_transport', phase: 'request' } },
  ]);
});

test('shutdown during robots acquisition interrupts the tick', async () => {
  const controller = new AbortController();
  const s = setup((_url, signal) => {
    controller.abort();
    signal.throwIfAborted();
    throw new Error('expected shutdown');
  });
  expect(await s.run([first, other], { mode: 'daemon_tick', signal: controller.signal })).toMatchObject({ outcome: 'interrupted', reason: 'shutdown' });
  expect(s.requested).toEqual([robots]);
  expect(() => s.outcomeText()).toThrow();
  expect(s.complete).not.toHaveBeenCalled();
});

test('a same-origin robots redirect is checked as robots and can cool its host', async () => {
  const detail = 'https://09pangpang.com/post/900003';
  const s = setup(url => {
    if (url === 'https://09pangpang.com/robots.txt') return new Response(null, { status: 302, headers: { location: '/rules.txt' } });
    if (url === 'https://09pangpang.com/rules.txt') return new Response(null, { status: 429 });
    return live(url);
  });
  expect(await s.run([detail, other])).toMatchObject({ outcome: 'completed', deepseek_calls_attempted: 0, backoff: null });
  expect(s.requested).toEqual(['https://09pangpang.com/robots.txt', 'https://09pangpang.com/rules.txt', 'https://other.example/robots.txt', other]);
  expect((await loadMemory(s.dir)).fetch_retry_after).toEqual({ '09pangpang.com': start + 600_000 });
});

test('gone seeds, catalog searches and observed listings are filtered before rotation', async () => {
  const s = setup(live);
  const goneListing = 'https://09pangpang.com/';
  const searchRows = catalogSearchUrls(loadGeunbonCatalog()).filter(row => row.category === 'stroller');
  const [liveSearch, ...goneSearches] = searchRows.slice().reverse();
  expect(goneSearches.length).toBeGreaterThan(0);
  const memory = emptyMemory();
  memory.observed_urls = [goneListing];
  memory.gone_urls = Object.fromEntries([first, goneListing, ...goneSearches.map(row => row.url)].map(url => [url, 410]));
  await saveMemory(s.dir, memory);

  s.config.seed_urls = [first, other];
  s.config.scope_categories = s.config.scope_categories.filter(category => category.id === 'stroller');
  s.config.selection.max_pages_per_cycle = 2;
  const result = await s.run([]);
  expect(result.coverage?.searches.map(row => row.url)).toEqual([liveSearch.url]);
  expect(s.requested).toEqual(['https://09pangpang.com/robots.txt', liveSearch.url, 'https://other.example/robots.txt', other]);
});
