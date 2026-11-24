import { afterEach, beforeEach, expect, test } from 'vitest';
import { handleApi } from '../lib/api';
import type { Env } from '../lib/db';
import type { AdminDeal } from '../lib/data';
import { api, approval, migrate, publish } from './helpers/deal-timestamps';
import { batchGate, memoryD1 } from './helpers/sqlite';

let memory: ReturnType<typeof memoryD1>;
let options: NonNullable<Parameters<typeof memoryD1>[0]>;
let call: ReturnType<typeof api>;
let id: string;
export const correction = (extra: Record<string, unknown> = {}) => ({ action: 'correct', expected_version: 1, request_id: crypto.randomUUID(), reason: 'Offline correction evidence reviewed', model_id: 'model-1', title: 'Corrected deal', price: 300000, starts_at: '2026-10-21T09:00:00+09:00', ends_at: '2026-10-29T00:00:00Z', include_image: false, ...extra });
const withdrawal = (extra: Record<string, unknown> = {}) => ({ action: 'withdraw', expected_version: 1, request_id: crypto.randomUUID(), reason: 'Offline withdrawal evidence reviewed', ...extra });
const row = () => memory.db.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first<AdminDeal>();
const revisions = () => memory.db.prepare('SELECT * FROM deal_revisions WHERE deal_id = ? ORDER BY version').bind(id).all();
const update = (payload: unknown) => call(`admin/deals/${id}`, payload);
async function error(response: Response, code: string) { expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: code }); }
async function snapshot() { return { row: await row(), revisions: (await revisions()).results }; }
async function assertLatest() {
  const current = (await row())!;
  const latest = (await revisions()).results.at(-1)!;
  for (const field of ['model_id','seller_id','title','price','starts_at','ends_at','image_url','checked','status','version']) expect(current[field as keyof AdminDeal]).toEqual(latest[field]);
}
beforeEach(async () => {
  options = { serialize: true }; memory = memoryD1(options); call = api(memory.db);
  await migrate(memory.db); id = (await publish(memory.db, 'lifecycle')).id;
});
afterEach(() => memory.close());

test('approval, correction and terminal withdrawal preserve evidence and full audit history', async () => {
  const evidence = await memory.db.prepare('SELECT * FROM ingested_items WHERE id = ?').bind(id).first();
  const original = (await row())!;
  expect((await revisions()).results).toMatchObject([{ action: 'publish', version: 1, request_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  const body = correction({ title: '  Corrected deal  ', reason: '  Offline correction evidence reviewed  ' });
  expect((await update(body)).status).toBe(200);
  const corrected = (await row())!;
  expect(corrected).toMatchObject({ title: 'Corrected deal', price: 300000, image_url: null, version: 2, status: 'published', starts_at: '2026-10-21T00:00:00.000Z' });
  expect(corrected.checked).not.toBe(original.checked);
  const correctedRevision = (await revisions()).results[1];
  expect(correctedRevision).toMatchObject({ reason: 'Offline correction evidence reviewed', version: 2 });
  expect(correctedRevision.request_hash).toMatch(/^[a-f0-9]{64}$/);
  const withdraw = withdrawal({ expected_version: 2 });
  expect((await update(withdraw)).status).toBe(200);
  expect(await row()).toMatchObject({ version: 3, status: 'withdrawn', withdrawn_at: expect.any(String) });
  await assertLatest();
  await error(await update(correction({ expected_version: 3 })), 'withdrawn');
  await error(await update(withdrawal({ expected_version: 3 })), 'withdrawn');
  expect(await memory.db.prepare('SELECT * FROM ingested_items WHERE id = ?').bind(id).first()).toEqual(evidence);
  expect(await row()).toMatchObject({ source_url: original.source_url, verify_level: original.verify_level });
  const detail = (await (await call(`admin/deals/${id}`)).json<{ data: AdminDeal }>()).data;
  expect(detail.revisions.map(r => r.action)).toEqual(['publish', 'correct', 'withdraw']);
  expect(detail.evidence).toMatchObject({ text: 'Original evidence lifecycle', attribution: 'explicit' });
  expect(JSON.stringify(detail)).not.toContain('request_hash');
  const before = await snapshot();
  const repeatedIngest = await call('ingest', { source_url: original.source_url, account: 'different', text: 'Changed evidence', kind: 'post', captured_at: '2026-10-23T00:00:00Z', image_url: 'https://cdninstagram.com/replaced.jpg' });
  expect(repeatedIngest.status).toBe(202);
  expect(await repeatedIngest.json()).toEqual({ data: { id, status: 'approved' } });
  expect((await call(`admin/review/${id}`, approval(body.starts_at, body.ends_at))).status).toBe(409);
  expect(await snapshot()).toEqual(before);
  expect(await memory.db.prepare('SELECT * FROM ingested_items WHERE id = ?').bind(id).first()).toEqual(evidence);
});

test('invalid inputs and unknown IDs cannot change state', async () => {
  const before = await snapshot();
  const invalid = [
    { expected_version: '1' }, { expected_version: 0 }, { expected_version: 1.5 }, { expected_version: Number.MAX_SAFE_INTEGER + 1 },
    { reason: 'short' }, { reason: ' '.repeat(20) }, { reason: 'a'.repeat(301) }, { title: ' ' }, { title: 'a'.repeat(201) },
    { starts_at: '2026-02-30T00:00:00Z' }, { ends_at: '2026-10-20T00:00:00Z' }, { ends_at: 'invalid' },
    { model_id: 'unknown' }, { price: -1 }, { price: 1.5 }, { price: '4' }, { include_image: 'on' }, { include_image: undefined },
    ...['short', 'x'.repeat(65), 'invalid_request_id_123', `review-${crypto.randomUUID()}`].map(request_id => ({ request_id })),
    ...['source_url','verify_level','checked','image_url','seller_id','status','version','id'].map(key => ({ [key]: 'injected' })),
  ];
  for (const fields of invalid) expect((await update(correction(fields))).status, JSON.stringify(fields)).toBe(400);
  for (const payload of [null, [], {}, { action: 'restore' }]) expect((await update(payload)).status).toBe(400);
  expect((await call('admin/deals/unknown')).status).toBe(404);
  expect((await call('admin/deals/unknown', correction())).status).toBe(404);
  expect(await snapshot()).toEqual(before);
});

test('every lifecycle route requires admin credentials and valid configuration', async () => {
  const env: Env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'timestamp-admin-test-only', INGEST_TOKEN: 'timestamp-ingest-test-only', COLLECTOR_STATUS_TOKEN: 'offline-status-token-only' };
  const before = await snapshot();
  for (const [path, payload] of [['admin/deals', undefined], [`admin/deals/${id}`, undefined], [`admin/deals/${id}`, correction()], [`admin/deals/${id}`, withdrawal()]] as const) {
    const request = (token?: string) => new Request(`http://localhost/api/v1/${path}`, { method: payload ? 'POST' : 'GET', headers: token ? { authorization: `Bearer ${token}` } : {}, body: payload ? JSON.stringify(payload) : undefined });
    for (const token of [undefined, env.INGEST_TOKEN, env.COLLECTOR_STATUS_TOKEN]) expect((await handleApi(request(token), path.split('/'), env)).status).toBe(401);
    for (const config of [
      { ADMIN_TOKEN: undefined }, { INGEST_TOKEN: undefined }, { ADMIN_TOKEN: 'short' }, { INGEST_TOKEN: 'short' },
      { ADMIN_TOKEN: ` ${env.ADMIN_TOKEN}` }, { ADMIN_TOKEN: env.INGEST_TOKEN }, { COLLECTOR_STATUS_TOKEN: env.ADMIN_TOKEN }, { COLLECTOR_STATUS_TOKEN: env.INGEST_TOKEN },
    ]) expect((await handleApi(request(env.ADMIN_TOKEN), path.split('/'), { ...env, ...config })).status).toBe(503);
  }
  expect(await snapshot()).toEqual(before);
});

test('sequential normalized replays succeed and key reuse with changed content, action or version conflicts', async () => {
  const body = correction();
  expect((await update(body)).status).toBe(200);
  const replay = await update({ ...body, title: ` ${body.title} `, reason: ` ${body.reason} `, starts_at: '2026-10-21T00:00:00.000Z' });
  expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ data: { replayed: true, version: 2 } });
  for (const change of [{ price: 42 }, { reason: 'A different documented reason' }, { expected_version: 2 }, { action: 'withdraw' }]) await error(await update({ ...body, ...change }), 'request_id_reused');
  expect((await revisions()).results).toHaveLength(2);
  const withdraw = withdrawal({ expected_version: 2 });
  expect((await update(withdraw)).status).toBe(200);
  expect(await (await update(withdraw)).json()).toMatchObject({ data: { replayed: true, status: 'withdrawn', version: 3 } });
  expect((await revisions()).results).toHaveLength(3);
});

for (const order of [[0, 1], [1, 0]]) {
  test.each(['identical', 'payload', 'action', 'versions', 'withdraw-version'])('concurrent %s requests serialize safely in order ' + order.join(','), async scenario => {
    const first = correction();
    const second = scenario === 'identical' ? { ...first }
      : scenario === 'payload' ? { ...first, price: 42 }
      : scenario === 'action' ? withdrawal({ request_id: first.request_id })
      : scenario === 'versions' ? correction({ price: 42 }) : withdrawal();
    options.gate = batchGate(2, order);
    const firstRequest = update(first);
    await options.gate.firstArrived;
    const responses = await Promise.all([firstRequest, update(second)]);
    await options.gate.arrived;
    if (scenario === 'identical') {
      expect(responses.map(r => r.status)).toEqual([200, 200]);
      const results = await Promise.all(responses.map(r => r.json<{ data: { replayed?: boolean } }>()));
      expect(results.filter(r => r.data.replayed)).toHaveLength(1);
    } else {
      expect(responses[order[0]].status).toBe(200);
      const loser = responses[order[1]];
      expect(loser.status).toBe(409);
      expect(await loser.json()).toMatchObject({ error: scenario === 'payload' || scenario === 'action' ? 'request_id_reused' : order[0] === 1 && scenario === 'withdraw-version' ? 'withdrawn' : 'stale_version' });
    }
    expect((await revisions()).results).toHaveLength(2);
    expect(await row()).toMatchObject({ version: 2, status: order[0] === 1 && ['action', 'withdraw-version'].includes(scenario) ? 'withdrawn' : 'published' });
    await assertLatest();
  });
}

test('stale versions return current_version', async () => {
  expect((await update(correction())).status).toBe(200);
  const response = await update(correction());
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'stale_version', current_version: 2 });
});

test.each([0, 1])('failure after statement %i rolls back both writes and permits retry', async statement => {
  options.failAfter = { batch: 2, statement };
  const before = await snapshot(), body = correction();
  await expect(update(body)).rejects.toThrow('Injected transaction failure');
  expect(await snapshot()).toEqual(before);
  expect((await update(body)).status).toBe(200); await assertLatest();
});

test('keyset pages reach beyond 200 including withdrawn deals, ties, lookup and correction', async () => {
  const ids = [id];
  for (let index = 1; index < 205; index++) ids.push((await publish(memory.db, `reach-${index}`)).id);
  // Include tied timestamps to verify the id tie breaker too.
  for (const [index, dealId] of ids.entries()) await memory.db.prepare('UPDATE deals SET checked = ? WHERE id = ?').bind(new Date(Date.UTC(2026, 9, 20, 0, 0, Math.floor(index / 2))).toISOString(), dealId).run();
  for (const dealId of ids.slice(-3)) expect((await call(`admin/deals/${dealId}`, withdrawal())).status).toBe(200);
  async function collect(status = '') {
    const found: string[] = []; let cursor: string | null = null;
    do {
      const response = await call(`admin/deals?limit=50${status ? `&status=${status}` : ''}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.status).toBe(200);
      const result = await response.json<{ data: AdminDeal[]; next_cursor: string | null }>();
      found.push(...result.data.map(d => d.id)); cursor = result.next_cursor;
    } while (cursor);
    return found;
  }
  const published = await collect();
  expect(published).toHaveLength(202); expect(new Set(published).size).toBe(202);
  expect(published.slice(-2)).toContain(id);
  expect(new Set(await collect('withdrawn'))).toEqual(new Set(ids.slice(-3)));
  expect(new Set(await collect('all'))).toEqual(new Set(ids));
  const detail = await (await call(`admin/deals/${id}`)).json<{ data: AdminDeal }>();
  expect(detail.data.revisions).toHaveLength(1); expect(detail.data.evidence?.text).toBe('Original evidence lifecycle');
  expect((await update(correction())).status).toBe(200);
  for (const query of ['cursor=invalid', 'cursor=', 'limit=0', 'limit=51', 'limit=1.5', 'status=unknown']) expect((await call(`admin/deals?${query}`)).status).toBe(400);
});
