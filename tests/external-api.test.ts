import { migrationStatements } from './helpers/migrations';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { memoryD1 } from './helpers/sqlite';
import { handleApi } from '../lib/api';
import type { Env } from '../lib/db';

const memory = memoryD1();
let env: Env;
const call = (path: string, method = 'GET', body?: unknown, token?: string) => handleApi(new Request(`http://localhost/api/v1/${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), path.split('?')[0].split('/'), env);
const listing = {
  kind: 'external_listing', source: 'pangpang', source_url: 'https://09pangpang.com/deal/101', account: 'pangpang',
  title: '합성 후보 제목 ZZ-CANDIDATE', text: '합성 후보 제목 ZZ-CANDIDATE / 가격 390,000원', seller_handle: 'synthetic_seller', seller_name: null, seller_url: 'https://www.instagram.com/synthetic_seller/',
  price_hint: 390000, price_raw: '390,000원', price_basis: 'external_listing', starts_at: '2026-10-26T00:00:00+09:00', ends_at: '2026-10-28T23:59:59+09:00', dates_raw: '10/26~10/28',
  category: 'high_chair', model_match: true, captured_at: '2026-10-22T00:30:00Z',
};
const post = (body: Record<string, unknown>) => call('ingest', 'POST', { ...listing, ...body }, env.INGEST_TOKEN);
const rows = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
type Item = { data: { id: string; status: string } };

beforeAll(async () => {
  env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'local-admin-test-only-separation', INGEST_TOKEN: 'local-ingest-test-only-separation' };
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of migrationStatements(await readFile(new URL(file, dir), 'utf8'))) await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("INSERT INTO models VALUES ('model-1','Stokke','test','high_chair','test',NULL,'https://www.stokke.com/','2026-10-20','page_text','')").run();
  await env.DB.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','test','https://www.stokke.com/')").run();
});
afterAll(() => { memory.close(); });

test('an external listing is stored only as a candidate, with canonical URL, times and price basis', async () => {
  const response = await post({});
  expect(response.status).toBe(202);
  const { data } = await response.json<Item>();
  expect(data.status).toBe('candidate');
  const [row] = await rows('SELECT * FROM external_candidates');
  expect(row).toMatchObject({ id: data.id, source: 'pangpang', source_url: 'https://09pangpang.com/deal/101', price_basis: 'external_listing', price_hint: 390000, model_match: 1, captured_at: '2026-10-22T00:30:00.000Z', last_seen_at: '2026-10-22T00:30:00.000Z' });
  expect(await rows('SELECT * FROM ingested_items')).toHaveLength(0);
  expect(await rows('SELECT * FROM deals')).toHaveLength(0);
  const queue = await (await call('admin/queue', 'GET', undefined, env.ADMIN_TOKEN)).text();
  expect(queue).not.toContain('ZZ-CANDIDATE');
});

test('public endpoints never expose candidate strings', async () => {
  for (const path of ['deals', 'calendar', 'models', 'models/model-1', 'sellers', 'brands']) {
    const body = await (await call(path)).text();
    expect(body, path).not.toContain('ZZ-CANDIDATE');
    expect(body, path).not.toContain('09pangpang');
    expect(body, path).not.toContain('synthetic_seller');
  }
});

test('candidate endpoints require the admin token, not the ingest token', async () => {
  expect((await call('admin/candidates')).status).toBe(401);
  expect((await call('admin/candidates', 'GET', undefined, env.INGEST_TOKEN)).status).toBe(401);
  expect((await call('admin/candidates', 'GET', undefined, env.ADMIN_TOKEN)).status).toBe(200);
  expect((await call('ingest', 'POST', listing, env.ADMIN_TOKEN)).status).toBe(401);
  expect((await call('ingest', 'POST', listing)).status).toBe(401);
});

test('resending the same URL updates last_seen_at and keeps one id; tracking params, trailing slash and www collapse', async () => {
  const [first] = await rows('SELECT id FROM external_candidates');
  for (const variant of ['https://www.09pangpang.com/deal/101/', 'https://09pangpang.com/deal/101?utm_source=ad&fbclid=x&ref=y', 'https://09PANGPANG.com:443/deal/101?from=a&share=b']) {
    const response = await post({ source_url: variant, captured_at: '2026-10-22T09:30:00Z', price_hint: 359000 });
    expect(response.status).toBe(202);
    expect((await response.json<Item>()).data.id).toBe(first.id);
  }
  const all = await rows('SELECT * FROM external_candidates');
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ captured_at: '2026-10-22T00:30:00.000Z', last_seen_at: '2026-10-22T09:30:00.000Z', price_hint: 359000 });
});

test('meaningful query parameters are kept and sorted, so different items stay separate', async () => {
  await post({ source_url: 'https://09pangpang.com/deal?b=2&a=1&utm_campaign=z' });
  await post({ source_url: 'https://09pangpang.com/deal?a=1&b=2' });
  await post({ source_url: 'https://09pangpang.com/deal?a=1&b=3' });
  const urls = (await rows("SELECT source_url FROM external_candidates WHERE source_url LIKE '%/deal?%' ORDER BY source_url")).map(row => row.source_url);
  expect(urls).toEqual(['https://09pangpang.com/deal?a=1&b=2', 'https://09pangpang.com/deal?a=1&b=3']);
});

test('Korean paths are normalized to one stored form', async () => {
  await post({ source_url: 'https://09pangpang.com/search/r/육아템' });
  const response = await post({ source_url: 'https://09pangpang.com/search/r/%EC%9C%A1%EC%95%84%ED%85%9C/' });
  expect(response.status).toBe(202);
  expect(await rows("SELECT id FROM external_candidates WHERE source_url LIKE '%search%'")).toHaveLength(1);
});

test.each([
  ['/api path after normalization', { source_url: 'https://09pangpang.com/api/v1/list' }],
  ['/my path', { source_url: 'https://09pangpang.com/my/orders' }],
  ['/auth path', { source_url: 'https://09pangpang.com/auth/login' }],
  ['double-slash api path', { source_url: 'https://09pangpang.com//api/x' }],
  ['gonggumoa', { source: 'pangpang', source_url: 'https://gonggumoa.com/deal/1' }],
  ['gonggumoa as source', { source: 'gonggumoa', source_url: 'https://gonggumoa.com/deal/1' }],
  ['instagram', { source_url: 'https://www.instagram.com/p/abc/' }],
  ['http', { source_url: 'http://09pangpang.com/deal/1' }],
  ['credentials', { source_url: 'https://user:pw@09pangpang.com/deal/1' }],
  ['fragment', { source_url: 'https://09pangpang.com/deal/1#x' }],
  ['custom port', { source_url: 'https://09pangpang.com:8443/deal/1' }],
  ['source and host mismatch', { source: 'momcalendar' }],
  ['unknown source', { source: 'other' }],
  ['negative price', { price_hint: -1 }],
  ['fractional price', { price_hint: 1.5 }],
  ['image_url present', { image_url: 'https://cdninstagram.com/a.jpg' }],
  ['null image_url present', { image_url: null }],
  ['string model_match', { model_match: 'true' }],
  ['numeric model_match', { model_match: 1 }],
  ['text over 2000 chars', { text: 'a'.repeat(2001) }],
  ['title over 200 chars', { title: 'a'.repeat(201) }],
  ['empty title', { title: '' }],
  ['bad dates order', { starts_at: '2026-10-28T00:00:00+09:00', ends_at: '2026-10-26T00:00:00+09:00' }],
  ['bad seller handle', { seller_handle: 'bad handle!' }],
  ['non-instagram seller url', { seller_url: 'https://example.com/x/' }],
  ['bad price_basis', { price_basis: 'official' }],
  ['bad captured_at', { captured_at: 'yesterday' }],
  ['bad suggestions', { suggestions: { models: 'x' } }],
])('invalid external listing is rejected with 400: %s', async (_name, patch) => {
  const before = (await rows('SELECT * FROM external_candidates')).length;
  expect((await post(patch)).status).toBe(400);
  expect((await rows('SELECT * FROM external_candidates')).length).toBe(before);
});

test('omitted model_match is false and true is stored as 1', async () => {
  const { model_match: _omit, ...rest } = listing;
  void _omit;
  expect((await call('ingest', 'POST', { ...rest, source_url: 'https://09pangpang.com/deal/mm-false' }, env.INGEST_TOKEN)).status).toBe(202);
  expect((await rows("SELECT model_match FROM external_candidates WHERE source_url LIKE '%mm-false'"))[0].model_match).toBe(0);
  expect((await rows("SELECT model_match FROM external_candidates WHERE source_url LIKE '%/deal/101'"))[0].model_match).toBe(1);
});

test('Instagram ingest is unchanged and still rejects external hosts', async () => {
  const instagram = { source_url: 'https://www.instagram.com/p/test-ext/', account: 'local-test', text: '검증용 원문', kind: 'post', captured_at: '2026-10-21T00:00:00Z' };
  expect((await call('ingest', 'POST', instagram, env.INGEST_TOKEN)).status).toBe(202);
  expect((await call('ingest', 'POST', { ...instagram, source_url: 'https://09pangpang.com/deal/101' }, env.INGEST_TOKEN)).status).toBe(400);
  expect(await rows('SELECT * FROM ingested_items')).toHaveLength(1);
});

test('dismiss: only the dismiss action, 404 for unknown ids, 409 when repeated, and the review endpoint cannot see candidates', async () => {
  const [row] = await rows("SELECT id FROM external_candidates WHERE source_url = 'https://09pangpang.com/deal/101'");
  const id = row.id as string;
  expect((await call(`admin/candidates/${id}`, 'POST', { action: 'approve' }, env.ADMIN_TOKEN)).status).toBe(400);
  expect((await call(`admin/candidates/${id}`, 'POST', { action: 'reject' }, env.ADMIN_TOKEN)).status).toBe(400);
  expect((await call(`admin/candidates/${id}`, 'POST', { action: 'dismiss' }, env.INGEST_TOKEN)).status).toBe(401);
  expect((await call('admin/candidates/missing', 'POST', { action: 'dismiss' }, env.ADMIN_TOKEN)).status).toBe(404);
  expect((await call(`admin/review/${id}`, 'POST', { action: 'approve', attribution: 'explicit', attribution_note: 'Synthetic fixture attribution reviewed offline', model_id: 'model-1', seller_id: 'seller-1', title: 'x', price: 1, starts_at: '2026-10-26T00:00:00+09:00', ends_at: '2026-10-28T00:00:00+09:00' }, env.ADMIN_TOKEN)).status).toBe(404);
  expect(await rows('SELECT * FROM deals')).toHaveLength(0);
  expect((await call(`admin/candidates/${id}`, 'POST', { action: 'dismiss' }, env.ADMIN_TOKEN)).status).toBe(200);
  expect((await call(`admin/candidates/${id}`, 'POST', { action: 'dismiss' }, env.ADMIN_TOKEN)).status).toBe(409);
  const listed = await (await call('admin/candidates', 'GET', undefined, env.ADMIN_TOKEN)).json<{ data: { id: string }[] }>();
  expect(listed.data.map(item => item.id)).not.toContain(id);
});

test('a dismissed candidate answers 202 with dismissed status and is not updated by resends', async () => {
  const response = await post({ title: '변경된 제목', price_hint: 1, captured_at: '2026-10-23T00:00:00Z' });
  expect(response.status).toBe(202);
  expect((await response.json<Item>()).data.status).toBe('dismissed');
  const [row] = await rows("SELECT title, price_hint, last_seen_at FROM external_candidates WHERE source_url = 'https://09pangpang.com/deal/101'");
  expect(row).toMatchObject({ title: '합성 후보 제목 ZZ-CANDIDATE', price_hint: 359000, last_seen_at: '2026-10-22T09:30:00.000Z' });
});
