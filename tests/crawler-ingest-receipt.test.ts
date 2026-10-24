import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import settingsJson from '../crawler/config/settings.json';
import { parseSettings } from '../crawler/lib/config';
import { collectAccount, type CollectContext } from '../crawler/lib/collect';
import { flushHealth, initHealth } from '../crawler/lib/health';
import { IngestError, parseIngestReceipt, sendItem, type InstagramItem } from '../crawler/lib/ingest';
import { CrawlerState } from '../crawler/lib/state';
import { buildPayload } from '../crawler/lib/external/filter';
import { mockPage } from './helpers/page';
vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));

const TOKEN = 'offline-ingest-token-private';
const MARKER = 'BODY_SECRET_MARKER';
const CAPTION = '트립트랩 공구가 390,000원 PRIVATE_CAPTION';
const URL_SENT = 'https://www.instagram.com/p/receipt/';
const receipt = (status = 'pending') => ({ data: { id: 'item-1', status }, private: MARKER });
const json = (value: unknown) => Response.json(value, { status: 202 });
const raw = (body: BodyInit | null, headers: HeadersInit = { 'content-type': 'application/json' }) => new Response(body, { status: 202, headers });
const flagged = (key: string, value: unknown) => Object.defineProperty(json(receipt()), key, { value });
let dir: string;
let ctx: CollectContext;
const page = () => mockPage(selector => selector.startsWith('a[href*="/p/"') ? [{ href: '/p/receipt/' }] : selector === 'article' ? [{ text: CAPTION }] : []).page;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-receipt-'));
  await initHealth(dir);
  ctx = { account: 'stokke', crawlerDir: dir, state: await CrawlerState.open(join(dir, 'state.json')), settings: parseSettings(settingsJson), api: new URL('https://ingest.invalid/api/v1/ingest'), token: TOKEN, scanPosts: true, scanStories: false, collectImages: false };
});
afterEach(async () => { await flushHealth(); await rm(dir, { recursive: true, force: true }); });

async function expectRetryable(send: () => Promise<Response>, reason?: string) {
  vi.stubGlobal('fetch', vi.fn(send));
  const error = await collectAccount(page(), ctx).then(() => null, error => error);
  expect(error).toBeInstanceOf(IngestError);
  expect(error.status).toBeUndefined();
  expect(error.cause).toBeUndefined();
  expect(ctx.state.isSeen(URL_SENT)).toBe(false);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).text).toBe(CAPTION);
  expect(vi.mocked(fetch).mock.calls[0][1]!.redirect).toBe('error');
  await flushHealth();
  const log = await readFile(join(dir, 'logs', `health-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  for (const secret of [TOKEN, MARKER, CAPTION, URL_SENT]) {
    expect(log).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(error.stack).not.toContain(secret);
  }
  const failures = log.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.event === 'api_error');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject(reason ? { receipt: reason } : { status: 'network' });
}

const failures: [string, () => Response, string][] = [
  ['HTML 200', () => new Response(`<html>${MARKER}</html>`, { status: 200, headers: { 'content-type': 'text/html' } }), 'status'],
  ['HTML 202', () => raw(`<html>${MARKER}</html>`, { 'content-type': 'text/html' }), 'content_type'],
  ['missing content type', () => { const response = raw(JSON.stringify(receipt()), new Headers()); response.headers.delete('content-type'); return response; }, 'content_type'],
  ['malformed JSON', () => raw(`{"data": ${MARKER}`), 'json'],
  ['wrong acceptance status', () => Response.json(receipt()), 'status'],
  ['redirect status', () => new Response(MARKER, { status: 302 }), 'redirect'],
  ['redirected response', () => flagged('redirected', true), 'redirect'],
  ['opaque redirect', () => flagged('type', 'opaqueredirect'), 'redirect'],
  ['missing body', () => raw(null), 'body'],
  ['invalid UTF-8', () => raw(new Uint8Array([0xff])), 'json'],
  ...[{}, { data: null }, { data: [] }, [], null].map((value, i): [string, () => Response, string] => [`invalid envelope ${i}`, () => json(value), 'invalid']),
  ...['', 'x y', 123, null, ['a'], {}, 'a'.repeat(101)].map((id, i): [string, () => Response, string] => [`invalid id ${i}`, () => json({ data: { id, status: 'pending' }, private: MARKER }), 'invalid']),
  ...['published', 1, null].map((status, i): [string, () => Response, string] => [`invalid status ${i}`, () => json({ data: { id: 'item-1', status }, private: MARKER }), 'invalid']),
];
test.each(failures)('%s leaves the URL retryable without private diagnostics', async (_name, makeResponse, reason) => {
  await expectRetryable(async () => makeResponse(), reason);
});
test('lost response discards raw transport errors', async () => {
  await expectRetryable(async () => { throw new Error(`Bearer ${TOKEN} ${MARKER} ${CAPTION}`); });
});
test('body stream failure after headers leaves the URL retryable', async () => {
  let reads = 0;
  await expectRetryable(async () => raw(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`{"private":"${MARKER}","data":`));
      else controller.error(new Error(`Bearer ${TOKEN} ${MARKER}`));
    },
  })), 'body');
});
test('streamed JSON over 8 KB is cancelled and remains retryable even if cancellation rejects', async () => {
  const cancel = vi.fn(() => { throw new Error(`Bearer ${TOKEN} ${MARKER}`); });
  const chunks = [JSON.stringify(receipt()).slice(0, -1) + ',"padding":"', 'x'.repeat(8192), '"}'];
  await expectRetryable(async () => raw(new ReadableStream<Uint8Array>({
    pull(controller) { if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()!)); else controller.close(); }, cancel,
  })), 'oversized');
  expect(cancel).toHaveBeenCalledOnce();
});
test.each(['pending', 'approved', 'rejected'])('valid %s receipt marks the URL seen', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => json(receipt(status))));
  expect(await collectAccount(page(), ctx)).toEqual({ posts: 1, stories: 0 });
  expect(ctx.state.isSeen(URL_SENT)).toBe(true);
});
test('a lost acknowledgment retries the same URL and accepts the duplicate receipt', async () => {
  await expectRetryable(async () => { throw new Error(`Bearer ${TOKEN}`); });
  vi.stubGlobal('fetch', vi.fn(async () => json(receipt('approved'))));
  expect(await collectAccount(page(), ctx)).toEqual({ posts: 1, stories: 0 });
  expect(ctx.state.isSeen(URL_SENT)).toBe(true);
});
test('duplicate sends return the same id; JSON charset and media type casing are accepted', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => raw(JSON.stringify(receipt()), { 'content-type': ' Application/JSON ; charset=utf-8' })));
  const item: InstagramItem = { kind: 'post', source_url: URL_SENT, account: ctx.account, text: CAPTION, captured_at: new Date().toISOString() };
  for (let i = 0; i < 2; i++) expect(await sendItem(ctx.api, TOKEN, item)).toEqual({ id: 'item-1', status: 'pending' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
test.each(['candidate', 'dismissed'])('external listing accepts %s and rejects Instagram statuses', async status => {
  const item = buildPayload('fixture', { source_url: 'https://example.org/a', title: '스토케 트립트랩 공구', text: '', category_text: '', price: null, dates: null, seller_handle: null, seller_url: null }, new Date())!;
  expect(item).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async () => json(receipt(status))));
  expect(await sendItem(ctx.api, TOKEN, item)).toEqual({ id: 'item-1', status });
  vi.stubGlobal('fetch', vi.fn(async () => json(receipt('pending'))));
  await expect(sendItem(ctx.api, TOKEN, item)).rejects.toBeInstanceOf(IngestError);
});
test('pure receipt parser enforces both independent kind/status sets without coercion', () => {
  for (const kind of ['post', 'story'] as const) {
    for (const status of ['pending', 'approved', 'rejected']) expect(parseIngestReceipt(receipt(status), kind)).toEqual({ id: 'item-1', status });
    expect(parseIngestReceipt(receipt('candidate'), kind)).toBeNull();
  }
  for (const id of [123, null, [], {}, '', 'x y']) expect(parseIngestReceipt({ data: { id, status: 'pending' } }, 'post')).toBeNull();
  expect(parseIngestReceipt({ data: { id: 'A_0-z', status: 'candidate' } }, 'external_listing')).toEqual({ id: 'A_0-z', status: 'candidate' });
  expect(parseIngestReceipt(receipt('pending'), 'external_listing')).toBeNull();
});
