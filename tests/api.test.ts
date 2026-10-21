import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { memoryD1 } from './helpers/sqlite';
import { handleApi } from '../lib/api';
import { dealsCopy } from '../lib/deals-copy';
import type { Model } from '../lib/data';
import type { Env } from '../lib/db';
const memory = memoryD1();
let env: Env;
type ItemResponse = { data: { id: string; status: string } };
type ListResponse = { data: { id: string; price: number | null; advertisement: boolean; notice: string }[] };
type QueueResponse = { data: { id: string; account: string; suggestions: string | null }[] };
const ingest = { source_url: 'https://www.instagram.com/p/test-local/', account: 'local-test', text: '검증용 원문. 실제 상품·가격 데이터 아님.', kind: 'post', captured_at: '2026-10-21T00:00:00Z' };
const call = (path: string, method = 'GET', body?: unknown, token?: string) => handleApi(new Request(`http://localhost/api/v1/${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), path.split('?')[0].split('/'), env);
beforeAll(async () => {
  env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'local-admin-test-only', INGEST_TOKEN: 'local-ingest-test-only' };
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(file, dir), 'utf8');
    for (const sql of migration.split(';').filter(s => s.trim())) await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("INSERT INTO models VALUES ('model-1','Stokke','test','high_chair','test',NULL,'https://www.stokke.com/','2026-10-20','page_text','Other retailer 123,456 KRW; used 98,765 KRW')").run();
  await env.DB.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','test','https://www.stokke.com/')").run();
});
afterAll(() => { memory.close(); });
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
  assert.equal(deals.length, 1); assert.equal(deals[0].price, null); assert.equal(deals[0].advertisement, true); assert.equal(deals[0].notice, dealsCopy.apiNotice);
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

test('malformed hint entries return 400 and stored JSON parses for admin display', async () => {
  const { parseStoredSuggestions } = await import('../lib/api');
  const hints = { models: [], price: null, dates: null, links: [], confidence: 0 };
  assert.deepEqual(parseStoredSuggestions(JSON.stringify(hints)), hints);
  assert.equal(parseStoredSuggestions('{'), null);
  assert.equal(parseStoredSuggestions(null), null);
  for (const suggestions of [{ ...hints, models: [null] }, { ...hints, links: [null] }, { ...hints, price: [] }, { ...hints, dates: 'nope' }]) {
    assert.equal((await call('ingest', 'POST', { ...ingest, source_url: 'https://www.instagram.com/p/malformed-hints/', suggestions }, env.INGEST_TOKEN)).status, 400);
  }
});

test('public models expose only official/group-buy prices and never leak seed price notes', async () => {
  const list = await (await call('models')).json<{ data: Omit<Model, 'note'>[] }>();
  assert.equal(list.data.length, 1);
  assert.ok(!('note' in list.data[0]));
  const response = await call('models/model-1');
  const payload = await response.json<{ data: Omit<Model, 'note'> & { comparison: Record<string, unknown> } }>();
  assert.deepEqual(Object.keys(payload.data.comparison).sort(), ['gonggu', 'official']);
  assert.equal(payload.data.official_price, null);
  for (const value of [list, payload]) {
    const serialized = JSON.stringify(value);
    for (const forbidden of ['"overseas"', '"used"', '"fx"', '"note"', '123,456', '98,765']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  }
});


test('public model responses omit notes and overseas, used and FX prices', async () => {
  type PublicModel = { id: string; official_price: number | null; comparison?: { official: { price: number | null }; gonggu: unknown[] } };
  for (const path of ['models', 'models?brand=Stokke', 'models?category=high_chair', 'models/model-1']) {
    const response = await call(path);
    assert.equal(response.status, 200);
    const payload = await response.json<{ data: PublicModel | PublicModel[] }>();
    const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'model-1');
    assert.equal(rows[0].official_price, null);
    const serialized = JSON.stringify(payload);
    for (const forbidden of ['note', 'overseas', 'used', 'fx', '123,456', '234,567', '$799']) {
      assert.ok(!serialized.includes(forbidden), `${path} exposed ${forbidden}`);
    }
    if (rows[0].comparison) {
      assert.deepEqual(Object.keys(rows[0].comparison).sort(), ['gonggu', 'official']);
      assert.equal(rows[0].comparison.official.price, null);
      assert.deepEqual(Object.keys(rows[0].comparison.official).sort(), ['checked', 'price', 'source', 'verify_level']);
    }
  }
  assert.deepEqual((await (await call('models?category=unknown')).json<{ data: unknown[] }>()).data, []);
});
