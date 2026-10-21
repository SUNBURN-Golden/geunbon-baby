import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from 'miniflare';
import { handleApi } from '../lib/api';
import type { Env } from '../lib/db';
const options: V4MiniflareOptions = { modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-10-01', d1Databases: ['DB'], r2Buckets: ['IMAGES'] };
const mf = new Miniflare(convertV4MiniflareOptions(options));
let env: Env;
type ItemResponse = { data: { id: string; status: string } };
type ListResponse = { data: { id: string; price: number | null; advertisement: boolean; notice: string }[] };
type QueueResponse = { data: { id: string; account: string; suggestions: string | null }[] };
const ingest = { source_url: 'https://www.instagram.com/p/test-local/', account: 'local-test', text: '검증용 원문. 실제 상품·가격 데이터 아님.', kind: 'post', captured_at: '2026-10-21T00:00:00Z' };
const call = (path: string, method = 'GET', body?: unknown, token?: string) => handleApi(new Request(`http://localhost/api/v1/${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), path.split('?')[0].split('/'), env);
before(async () => {
  env = { DB: await mf.getD1Database('DB') as unknown as D1Database, IMAGES: await mf.getR2Bucket('IMAGES') as unknown as R2Bucket, ADMIN_TOKEN: 'local-admin-test-only', INGEST_TOKEN: 'local-ingest-test-only' };
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(file, dir), 'utf8');
    for (const sql of migration.split(';').filter(s => s.trim())) await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("INSERT INTO models VALUES ('model-1','Stokke','test','high_chair','test',NULL,'https://www.stokke.com/','2026-10-20','page_text','')").run();
  await env.DB.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','test','https://www.stokke.com/')").run();
});
after(async () => { await mf.dispose(); });
test('tokens fail closed and do not cross privilege boundaries', async () => {
  assert.equal((await call('ingest', 'POST', ingest)).status, 401);
  assert.equal((await call('admin/queue', 'GET', undefined, env.INGEST_TOKEN)).status, 401);
  assert.equal((await call('ingest', 'POST', ingest, env.ADMIN_TOKEN)).status, 401);
  const response = await handleApi(new Request('http://localhost'), ['admin', 'queue'], { ...env, ADMIN_TOKEN: undefined }); assert.equal(response.status, 503);
});
test('read API lists brands, models, comparison, sellers and calendar', async () => {
  for (const path of ['brands', 'models', 'models/model-1', 'sellers', 'calendar']) assert.equal((await call(path)).status, 200);
  assert.equal((await call('models/not-found')).status, 404);
  assert.deepEqual((await (await call('models?brand=not-known')).json<ListResponse>()).data, []);
});
test('invalid JSON and unsafe URLs are rejected before insertion', async () => {
  assert.equal((await call('ingest', 'POST', { ...ingest, source_url: 'javascript:alert(1)' }, env.INGEST_TOKEN)).status, 400);
  assert.equal((await call('ingest', 'POST', { ...ingest, text: 'a'.repeat(40000) }, env.INGEST_TOKEN)).status, 400);
  const r = new Request('http://localhost', { method: 'POST', body: '{', headers: { authorization: `Bearer ${env.INGEST_TOKEN}` } }); assert.equal((await handleApi(r, ['ingest'], env)).status, 400);
});
test('ingest stays private; canonical URL is idempotent; approval publishes atomically', async () => {
  const one = await (await call('ingest', 'POST', ingest, env.INGEST_TOKEN)).json<ItemResponse>();
  const two = await (await call('ingest', 'POST', { ...ingest, source_url: 'https://instagram.com/p/test-local' }, env.INGEST_TOKEN)).json<ItemResponse>();
  assert.equal(one.data.id, two.data.id); assert.equal(one.data.status, 'pending');
  assert.equal((await (await call('deals')).json<ListResponse>()).data.length, 0);
  assert.equal((await (await call('admin/queue', 'GET', undefined, env.ADMIN_TOKEN)).json<ListResponse>()).data.length, 1);
  const approval = { action: 'approve', model_id: 'model-1', seller_id: 'seller-1', title: '로컬 테스트 전용', price: null, starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-22T00:00:00Z' };
  assert.equal((await call(`admin/review/${one.data.id}`, 'POST', { ...approval, price: -1 }, env.ADMIN_TOKEN)).status, 400);
  assert.equal((await call(`admin/review/${one.data.id}`, 'POST', { ...approval, seller_id: 'missing' }, env.ADMIN_TOKEN)).status, 400);
  assert.equal((await call(`admin/review/${one.data.id}`, 'POST', approval, env.ADMIN_TOKEN)).status, 200);
  assert.equal((await call(`admin/review/${one.data.id}`, 'POST', approval, env.ADMIN_TOKEN)).status, 409);
  const deals = (await (await call('deals')).json<ListResponse>()).data;
  assert.equal(deals.length, 1); assert.equal(deals[0].price, null); assert.equal(deals[0].advertisement, true); assert.match(deals[0].notice, /거래 당사자가 아닙니다/);
  assert.equal((await (await call('admin/queue', 'GET', undefined, env.ADMIN_TOKEN)).json<ListResponse>()).data.length, 0);
});
test('reject never publishes and cannot later be approved', async () => {
  const item = (await (await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/stories/test/123/' }, env.INGEST_TOKEN)).json<ItemResponse>()).data;
  assert.equal((await call(`admin/review/${item.id}`, 'POST', { action: 'reject' }, env.ADMIN_TOKEN)).status, 200);
  assert.equal((await call(`admin/review/${item.id}`, 'POST', { action: 'approve' }, env.ADMIN_TOKEN)).status, 409);
  assert.equal((await (await call('deals')).json<ListResponse>()).data.length, 1);
});
test('crawler suggestions ride along, stay private, and never auto-publish', async () => {
  const suggestions = { models: [{ model_id: 'model-1', brand: 'Stokke', name: '트립트랩 하이체어(너도밤나무)', matched: ['스토케', '트립트랩', '너도밤나무'], confidence: 0.95 }], price: { value: 390000, raw: '390,000원', confidence: 0.9 }, dates: { starts_at: '2026-10-26T00:00:00+09:00', ends_at: '2026-10-28T23:59:59+09:00', raw: '10/26~10/28', confidence: 0.95 }, links: [{ url: '', kind: 'link_in_bio', confidence: 0.85 }], confidence: 0.93 };
  const response = await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/p/with-suggestions/', suggestions }, env.INGEST_TOKEN);
  assert.equal(response.status, 202);
  const queue = await (await call('admin/queue', 'GET', undefined, env.ADMIN_TOKEN)).json<QueueResponse>();
  const stored = queue.data.find(item => item.suggestions !== null);
  assert.ok(stored, '검수 대기열에 제안이 함께 저장돼야 한다');
  assert.deepEqual(JSON.parse(stored!.suggestions!), suggestions);
  // 잘못된 제안 스키마는 저장 전에 400 으로 거부된다.
  assert.equal((await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/p/bad-suggestions-1/', suggestions: { models: 'nope' } }, env.INGEST_TOKEN)).status, 400);
  assert.equal((await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/p/bad-suggestions-2/', suggestions: { ...suggestions, price: { value: -1, raw: 'x', confidence: 1 } } }, env.INGEST_TOKEN)).status, 400);
  assert.equal((await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/p/bad-suggestions-3/', suggestions: { ...suggestions, dates: { starts_at: '10/26', ends_at: null, raw: 'x', confidence: 0.5 } } }, env.INGEST_TOKEN)).status, 400);
  assert.equal((await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/p/bad-suggestions-4/', suggestions: { ...suggestions, links: [{ url: 'javascript:alert(1)', kind: 'url', confidence: 0.9 }] } }, env.INGEST_TOKEN)).status, 400);
  // 공개 deals 응답에는 제안이 노출되지 않는다.
  assert.ok(!(await (await call('deals')).text()).includes('suggestions'));
});
