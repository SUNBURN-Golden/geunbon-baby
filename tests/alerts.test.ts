import { afterEach, beforeEach, expect, test } from 'vitest';
import { handleApi } from '../lib/api';
import { alertStatus } from '../lib/alert-target';
import { memoryD1 } from './helpers/sqlite';
import { migrate } from './helpers/deal-timestamps';

let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  memory = memoryD1({ serialize: true });
  await migrate(memory.db);
});
afterEach(() => memory.close());

const email = 'Parent+Baby@EXAMPLE.TEST';
const valid = { email: `  ${email} \t`, target_type: 'model', target_id: 'model-1' };
function post(payload: object | string, type = 'application/json', db = memory.db) {
  const body = typeof payload === 'string' ? payload : type === 'application/json' ? JSON.stringify(payload) : new URLSearchParams(payload as Record<string, string>);
  const request = new Request('http://localhost/api/v1/alerts', { method: 'POST', headers: { 'content-type': type }, body });
  expect(request.url).not.toContain(email);
  return handleApi(request, ['alerts'], { DB: db, IMAGES: {} as R2Bucket });
}
const stored = () => memory.db.prepare('SELECT email,email_key,created_at,model_id,seller_id FROM alert_subscriptions ORDER BY id').all();

test('JSON subscriptions are target-specific, atomic and idempotent under simultaneous submissions', async () => {
  const duplicates = await Promise.all([post(valid), post(valid), post({ ...valid, email: 'Parent+Baby@example.test' })]);
  for (const response of duplicates) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'success' });
  }
  const seller = await post({ ...valid, target_type: 'seller', target_id: 'seller-1' });
  expect(await seller.json()).toEqual({ result: 'success' });
  const casing = await post({ ...valid, email: 'parent+Baby@example.test' });
  expect(casing.status).toBe(200);
  expect((await stored()).results).toEqual([
    { email, email_key: 'Parent+Baby@example.test', model_id: 'model-1', seller_id: null, created_at: expect.any(String) },
    { email, email_key: 'Parent+Baby@example.test', model_id: null, seller_id: 'seller-1', created_at: expect.any(String) },
    { email: 'parent+Baby@example.test', email_key: 'parent+Baby@example.test', model_id: 'model-1', seller_id: null, created_at: expect.any(String) },
  ]);
});

test('a published seller ID containing a dot works in its form redirect', async () => {
  await memory.db.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('ext-test-mom.shop','Shop','https://example.test')").run();
  const response = await post({ ...valid, target_type: 'seller', target_id: 'ext-test-mom.shop' }, 'application/x-www-form-urlencoded');
  expect(response.headers.get('location')).toBe('/sellers?alert=success&alert_seller=ext-test-mom.shop#alert-seller-ext-test-mom.shop');
  expect((await stored()).results).toHaveLength(1);
});

test('native forms receive an address-free, server-constructed 303 for each target and duplicate', async () => {
  const cases = [
    [valid, '/models/model-1?alert=success#alert-model-model-1'],
    [{ ...valid, target_type: 'seller', target_id: 'seller-1' }, '/sellers?alert=success&alert_seller=seller-1#alert-seller-seller-1'],
    [valid, '/models/model-1?alert=success#alert-model-model-1'],
  ] as const;
  for (const [payload, redirect] of cases) {
    const response = await post(payload, 'application/x-www-form-urlencoded');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(redirect);
    expect(await response.text()).toBe('');
  }
  expect((await stored()).results).toHaveLength(2);
});

test('bad inputs, malformed and oversized bodies and unknown targets cannot write', async () => {
  for (const bad of [
    { ...valid, email: 'bad address' }, { ...valid, email: 'a..b@example.test' },
    { ...valid, email: 'a@-example.test' }, { ...valid, target_type: 'other' }, { ...valid, target_id: '../' },
    { ...valid, target_type: 'seller', target_id: 'ext-test-unknown' }, '{', ' '.repeat(32 * 1024) + JSON.stringify(valid),
  ]) expect((await post(bad)).status).toBe(400);
  expect((await post('email=' + 'x'.repeat(32 * 1024), 'application/x-www-form-urlencoded')).status).toBe(400);
  expect((await post('email=x&email=y&target_type=model&target_id=model-1', 'application/x-www-form-urlencoded')).status).toBe(400);
  expect((await post({ ...valid, target_id: 'missing' })).status).toBe(404);
  expect((await post({ ...valid, target_type: 'seller', target_id: 'missing' })).status).toBe(404);
  expect((await stored()).results).toEqual([]);
});

test('every server alert status renders as feedback, including an unknown target', () => {
  for (const status of ['success', 'invalid', 'target', 'retry'] as const) expect(alertStatus(status)).toBe(status);
  expect(alertStatus('other')).toBeUndefined();
  expect(alertStatus(['target'])).toBeUndefined();
  expect(alertStatus(undefined)).toBeUndefined();
});

test('storage failures return generic retry feedback and a repeated attempt can succeed', async () => {
  const failing = { prepare: () => { throw new Error(`internal failure ${email}`); } } as unknown as D1Database;
  const response = await post(valid, 'application/json', failing);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ result: 'retry' });
  const native = await post(valid, 'application/x-www-form-urlencoded', failing);
  expect(native.status).toBe(303);
  expect(native.headers.get('location')).toBe('/models/model-1?alert=retry#alert-model-model-1');
  expect((await stored()).results).toEqual([]);
  expect((await post(valid)).status).toBe(200);
  expect((await stored()).results).toHaveLength(1);
});
