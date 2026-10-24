import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleApi } from '../lib/api';
import type { Env } from '../lib/db';
import { migrate } from './helpers/deal-timestamps';
import { memoryD1 } from './helpers/sqlite';

let memory: ReturnType<typeof memoryD1>;
let env: Env;
const seller = { name: 'Synthetic seller', source_url: 'https://example.com/seller' };
const approval = { action: 'approve', model_id: 'model-1', seller_id: 'seller-1', title: 'Offline review fixture', price: null, starts_at: '2026-10-25T00:00:00Z', ends_at: '2026-10-26T00:00:00Z', attribution: 'account' };
function call(path: string, payload?: unknown, token: string | null = env.ADMIN_TOKEN!, config = env) {
  return handleApi(new Request(`https://local.invalid/api/v1/${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), path.split('/'), config);
}
async function ingest(account = '@New.Shop', suffix = crypto.randomUUID()) {
  const response = await call('ingest', { source_url: `https://www.instagram.com/p/${suffix}/`, account, text: 'Synthetic caption', kind: 'post', captured_at: '2026-10-24T00:00:00Z' }, env.INGEST_TOKEN);
  expect(response.status).toBe(202);
  return (await response.json<{ data: { id: string } }>()).data.id;
}
async function register(extra: Record<string, unknown> = {}) {
  const response = await call('admin/sellers', { ...seller, ...extra });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}
const links = () => env.DB.prepare('SELECT account,seller_id FROM seller_accounts ORDER BY account').all();
const count = () => env.DB.prepare('SELECT COUNT(*) AS n FROM sellers').first();
async function pendingWithoutDeal(id: string) {
  expect(await env.DB.prepare('SELECT status,attribution,attribution_note FROM ingested_items WHERE id = ?').bind(id).first()).toEqual({ status: 'pending', attribution: null, attribution_note: null });
  expect(await env.DB.prepare('SELECT id FROM deals WHERE id = ?').bind(id).first()).toBeNull();
}
beforeEach(async () => {
  memory = memoryD1();
  env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'offline-admin-seller-token', INGEST_TOKEN: 'offline-ingest-seller-token' };
  await migrate(env.DB);
});
afterEach(() => { vi.restoreAllMocks(); memory.close(); });

test('every seller operation rejects missing/ingest credentials and fails closed on bad configuration', async () => {
  const operations: [string, unknown?][] = [
    ['admin/sellers'], ['admin/sellers', seller],
    ['admin/sellers/seller-1', { action: 'update', ...seller }],
    ['admin/sellers/seller-1', { action: 'link_account', account: 'new', account_reviewed: true }],
    ['admin/sellers/seller-1', { action: 'unlink_account', account: 'new' }],
  ];
  for (const [path, payload] of operations) {
    for (const token of [null, env.INGEST_TOKEN!]) expect((await call(path, payload, token)).status).toBe(401);
    for (const config of [
      { ...env, ADMIN_TOKEN: undefined }, { ...env, INGEST_TOKEN: undefined },
      { ...env, ADMIN_TOKEN: env.INGEST_TOKEN }, { ...env, ADMIN_TOKEN: 'short' },
      { ...env, COLLECTOR_STATUS_TOKEN: env.ADMIN_TOKEN },
    ]) expect((await call(path, payload, env.ADMIN_TOKEN!, config)).status).toBe(503);
  }
  expect(await count()).toEqual({ n: 1 });
  expect((await links()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT name FROM sellers WHERE id = 'seller-1'").first()).toEqual({ name: 'Test seller' });
});

test('registration without evidence stays unverified; editing replaces and clears the entire evidence set', async () => {
  const id = await register();
  expect(id).toMatch(/^seller-/);
  const evidence = () => env.DB.prepare('SELECT registration_source,withdrawal_source,official_import_source FROM sellers WHERE id = ?').bind(id).first();
  expect(await evidence()).toEqual({ registration_source: null, withdrawal_source: null, official_import_source: null });
  expect((await links()).results).toEqual([]);
  const sources = { registration_source: 'https://example.com/registration', withdrawal_source: 'https://example.com/withdrawal', official_import_source: 'https://example.com/import' };
  expect((await call(`admin/sellers/${id}`, { action: 'update', ...seller, ...sources })).status).toBe(200);
  expect(await evidence()).toEqual(sources);
  expect((await call(`admin/sellers/${id}`, { action: 'update', ...seller, registration_source: '', withdrawal_source: null })).status).toBe(200);
  expect(await evidence()).toEqual({ registration_source: null, withdrawal_source: null, official_import_source: null });
  expect((await call('admin/sellers/absent', { action: 'update', ...seller })).status).toBe(404);
});

test('seller and evidence URLs require safe HTTPS and invalid input writes nothing', async () => {
  for (const field of ['source_url', 'registration_source', 'withdrawal_source', 'official_import_source']) {
    for (const value of ['http://example.com/', 'https://user:password@example.com/', 'javascript:alert(1)', 'not a URL', 42]) {
      expect((await call('admin/sellers', { ...seller, [field]: value })).status).toBe(400);
      expect((await call('admin/sellers/seller-1', { action: 'update', ...seller, [field]: value })).status).toBe(400);
    }
  }
  for (const name of ['', ' ', 'a'.repeat(101)]) expect((await call('admin/sellers', { ...seller, name })).status).toBe(400);
  expect(await count()).toEqual({ n: 1 });
  expect(await env.DB.prepare("SELECT name,registration_source FROM sellers WHERE id = 'seller-1'").first()).toEqual({ name: 'Test seller', registration_source: null });
});

test('account association is normalized, explicitly reviewed, exclusive, idempotent and scoped on unlink', async () => {
  for (const account_reviewed of [undefined, false, 'true', 'on']) {
    expect((await call('admin/sellers', { ...seller, account: '@NEW.Shop', account_reviewed })).status).toBe(400);
    expect((await call('admin/sellers/seller-1', { action: 'link_account', account: '@NEW.Shop', account_reviewed })).status).toBe(400);
  }
  expect(await count()).toEqual({ n: 1 });
  const id = await register({ account: ' @NEW.Shop ', account_reviewed: true });
  expect((await links()).results).toEqual([{ account: 'new.shop', seller_id: id }]);
  expect((await call('admin/sellers', { ...seller, account: 'new.SHOP', account_reviewed: true })).status).toBe(409);
  expect(await count()).toEqual({ n: 2 });
  const link = { action: 'link_account', account: '@New.Shop', account_reviewed: true };
  expect((await call(`admin/sellers/${id}`, link)).status).toBe(200);
  expect((await call('admin/sellers/seller-1', link)).status).toBe(409);
  expect((await call('admin/sellers/seller-1', { action: 'unlink_account', account: 'new.shop' })).status).toBe(200);
  expect((await links()).results).toHaveLength(1);
  expect((await call(`admin/sellers/${id}`, { action: 'unlink_account', account: '@NEW.shop' })).status).toBe(200);
  expect((await links()).results).toEqual([]);
  expect((await call('admin/sellers/seller-1', link)).status).toBe(200);
});

test('ingested seller can be registered, linked and correctly published through review', async () => {
  const id = await ingest();
  const unlinked = await (await call('admin/sellers')).json<{ data: { unlinked_accounts: unknown[] } }>();
  expect(unlinked.data.unlinked_accounts).toEqual([{ account: '@New.Shop', normalized: 'new.shop', pending: 1 }]);
  const sellerId = await register({ account: 'new.shop', account_reviewed: true });
  const listed = await (await call('admin/sellers')).json<{ data: { sellers: { id: string; accounts: string[] }[]; unlinked_accounts: unknown[] } }>();
  expect(listed.data.unlinked_accounts).toEqual([]);
  expect(listed.data.sellers.find(s => s.id === sellerId)?.accounts).toEqual(['new.shop']);
  expect((await call(`admin/review/${id}`, { ...approval, seller_id: sellerId })).status).toBe(200);
  expect(await env.DB.prepare('SELECT seller_id FROM deals WHERE id = ?').bind(id).first()).toEqual({ seller_id: sellerId });
  expect(await env.DB.prepare('SELECT attribution,attribution_note FROM ingested_items WHERE id = ?').bind(id).first()).toEqual({ attribution: 'account', attribution_note: null });
});

test('seller B registration leaves A links intact and mismatched attribution requires a documented review', async () => {
  const id = await ingest('@x');
  await call('admin/sellers/seller-1', { action: 'link_account', account: 'x', account_reviewed: true });
  const sellerB = await register();
  const before = (await links()).results;
  expect(before).toEqual([{ account: 'x', seller_id: 'seller-1' }]);
  expect((await call(`admin/review/${id}`, { ...approval, seller_id: sellerB })).status).toBe(400);
  for (const note of [undefined, '', '123456789', ' '.repeat(10), 'a'.repeat(301)]) {
    expect((await call(`admin/review/${id}`, { ...approval, seller_id: sellerB, attribution: 'explicit', attribution_note: note })).status).toBe(400);
  }
  await pendingWithoutDeal(id);
  const note = 'Original post explicitly identifies seller B; reviewed manually.';
  expect((await call(`admin/review/${id}`, { ...approval, seller_id: sellerB, attribution: 'explicit', attribution_note: note })).status).toBe(200);
  expect(await env.DB.prepare('SELECT seller_id FROM deals WHERE id = ?').bind(id).first()).toEqual({ seller_id: sellerB });
  expect(await env.DB.prepare('SELECT attribution,attribution_note FROM ingested_items WHERE id = ?').bind(id).first()).toEqual({ attribution: 'explicit', attribution_note: note });
  expect((await links()).results).toEqual(before);
});

test('non-handle accounts are listed but cannot link and can only publish through explicit attribution', async () => {
  const id = await ingest('Some Shop 공식');
  const data = await (await call('admin/sellers')).json<{ data: { unlinked_accounts: unknown[] } }>();
  expect(data.data.unlinked_accounts).toEqual([{ account: 'Some Shop 공식', normalized: null, pending: 1 }]);
  for (const account of ['Some Shop 공식', '@@shop', 'a'.repeat(31), 'https://instagram.com/shop']) {
    expect((await call('admin/sellers', { ...seller, account, account_reviewed: true })).status).toBe(400);
    expect((await call('admin/sellers/seller-1', { action: 'link_account', account, account_reviewed: true })).status).toBe(400);
  }
  expect(await count()).toEqual({ n: 1 });
  expect((await call(`admin/review/${id}`, approval)).status).toBe(400);
  await pendingWithoutDeal(id);
  expect((await call(`admin/review/${id}`, { ...approval, attribution: 'explicit', attribution_note: 'Display name and seller confirmed against original source.' })).status).toBe(200);
  expect((await links()).results).toEqual([]);
});

test('blank, whitespace or missing selections never publish; rejection needs none of them', async () => {
  const id = await ingest();
  await call('admin/sellers/seller-1', { action: 'link_account', account: 'new.shop', account_reviewed: true });
  for (const field of ['model_id', 'seller_id', 'attribution']) {
    for (const value of [undefined, '', '   ']) {
      expect((await call(`admin/review/${id}`, { ...approval, [field]: value })).status).toBe(400);
      await pendingWithoutDeal(id);
    }
  }
  await call('admin/sellers/seller-1', { action: 'unlink_account', account: 'new.shop' });
  expect((await call(`admin/review/${id}`, approval)).status).toBe(400); // No reviewed link.
  expect((await call(`admin/review/${id}`, { action: 'reject', model_id: '', seller_id: '', attribution: '' })).status).toBe(200);
  expect(await env.DB.prepare('SELECT status FROM ingested_items WHERE id = ?').bind(id).first()).toEqual({ status: 'rejected' });
  expect(await env.DB.prepare('SELECT id FROM deals').first()).toBeNull();
});

test('unlink between the attribution check and batch cannot publish or mark approved', async () => {
  const id = await ingest();
  await call('admin/sellers/seller-1', { action: 'link_account', account: 'new.shop', account_reviewed: true });
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
    await env.DB.prepare('DELETE FROM seller_accounts').run();
    return batch(statements);
  });
  const response = await call(`admin/review/${id}`, approval);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: '원문 계정과 판매자 연결 검수 필요' });
  await pendingWithoutDeal(id);
});

test('a concurrent review returns conflict without creating a deal', async () => {
  const id = await ingest();
  await call('admin/sellers/seller-1', { action: 'link_account', account: 'new.shop', account_reviewed: true });
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
    await env.DB.prepare("UPDATE ingested_items SET status = 'rejected' WHERE id = ?").bind(id).run();
    return batch(statements);
  });
  expect((await call(`admin/review/${id}`, approval)).status).toBe(409);
  expect(await env.DB.prepare('SELECT id FROM deals').first()).toBeNull();
});

test('a conflicting account acquired during registration rolls back the new seller', async () => {
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
    await env.DB.prepare("INSERT INTO seller_accounts VALUES ('new.shop','seller-1','2026-10-24T00:00:00Z')").run();
    return batch(statements);
  });
  expect((await call('admin/sellers', { ...seller, account: 'new.shop', account_reviewed: true })).status).toBe(409);
  expect(await count()).toEqual({ n: 1 });
  expect((await links()).results).toEqual([{ account: 'new.shop', seller_id: 'seller-1' }]);
});

test('public projection excludes private metadata and ingestion never creates site sellers', async () => {
  await env.DB.prepare("ALTER TABLE sellers ADD COLUMN private_review TEXT DEFAULT 'private marker'").run();
  const id = await ingest();
  await call(`admin/review/${id}`, { ...approval, attribution: 'explicit', attribution_note: 'Private documented source attribution.' });
  const response = await (await call('sellers')).json<{ data: Record<string, unknown>[] }>();
  expect(Object.keys(response.data[0]).sort()).toEqual(['id', 'name', 'source_url', 'registration_source', 'withdrawal_source', 'official_import_source'].sort());
  const deals = await (await call('deals')).text();
  for (const key of ['attribution', 'accounts', 'private_review', 'Private documented']) expect(deals).not.toContain(key);
  const ingested = await call('ingest', { source_url: 'https://instagram.com/p/extra-fields/', account: 'seller', text: 'Synthetic', kind: 'post', captured_at: '2026-10-24T00:00:00Z', seller_id: 'injected', name: 'Injected seller', account_reviewed: true, registration_source: 'https://example.com/', seller: { ...seller } }, env.INGEST_TOKEN);
  expect(ingested.status).toBe(202);
  expect(await count()).toEqual({ n: 1 });
  expect((await links()).results).toEqual([]);
});
