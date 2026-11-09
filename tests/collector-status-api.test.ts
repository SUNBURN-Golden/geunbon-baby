import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GET, POST } from '../app/api/v1/[[...path]]/route';
import { issueAdminSession } from '../lib/api';
import type { Env } from '../lib/db';
import { malformedSnapshots, PRIVATE_MARKER, STATUS_NOW, statusSnapshot, storeStatus } from './helpers/collection-status';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ env: undefined as Env | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => context.env,
}));
const ADMIN_TOKEN = 'fixture-admin-token-separation-0001';
const INGEST_TOKEN = 'fixture-ingest-token-separation-0002';
const STATUS_TOKEN = 'fixture-status-token-separation-0003';
const paths = ['collector-status', 'admin/collection-status'];
const receivedAt = new Date(STATUS_NOW).toISOString();
let memory: ReturnType<typeof memoryD1>;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(STATUS_NOW);
  memory = memoryD1();
  context.env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN, INGEST_TOKEN, COLLECTOR_STATUS_TOKEN: STATUS_TOKEN };
  for (const sql of readFileSync(new URL('../migrations/0007_collector_status.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) {
    await memory.db.prepare(sql).run();
  }
});
afterEach(() => memory.close());

function call(path: string, authorization: string | null = `Bearer ${ADMIN_TOKEN}`, method = 'GET', cookie?: string) {
  const headers = new Headers();
  if (authorization !== null) headers.set('authorization', authorization);
  if (cookie !== undefined) headers.set('cookie', `agamajung_admin=${cookie}`);
  return (method === 'POST' ? POST : GET)(new Request(`https://site.invalid/api/v1/${path}`, {
    method, headers, ...(method === 'POST' ? { body: JSON.stringify(statusSnapshot()) } : {}),
  }), { params: Promise.resolve({ path: path.split('/') }) });
}
async function result(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  for (const secret of [ADMIN_TOKEN, INGEST_TOKEN, STATUS_TOKEN, PRIVATE_MARKER]) expect(text).not.toContain(secret);
  return { status: response.status, headers: [...response.headers], body: JSON.parse(text) };
}
async function expectParity(data: unknown) {
  const alias = await result(await call(paths[0]));
  const original = await result(await call(paths[1]));
  expect(alias).toEqual(original);
  expect(alias.status).toBe(200);
  // Exact equality also rejects extra record, URL, evidence, or aggregate fields.
  expect(alias.body).toEqual({ data });
}
async function expectPrivateFailure() {
  for (const path of paths) {
    const response = await result(await call(path));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: '데이터를 불러오지 못했습니다. DB 마이그레이션 상태를 확인해 주세요.' });
  }
}

test.each([
  ['missing', null],
  ['empty', ''],
  ['incorrect', 'Bearer incorrect-fixture-token'],
  ['missing scheme', ADMIN_TOKEN],
  ['wrong scheme', `Basic ${ADMIN_TOKEN}`],
  ['malformed bearer', `Bearer  ${ADMIN_TOKEN}`],
  ['ingest credential', `Bearer ${INGEST_TOKEN}`],
  ['status credential', `Bearer ${STATUS_TOKEN}`],
])('%s authorization is rejected before any D1 access', async (_name, authorization) => {
  const prepare = vi.spyOn(memory.db, 'prepare');
  for (const path of paths) {
    for (const method of ['GET', 'POST']) {
      const response = await result(await call(path, authorization, method));
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: '인증 필요' });
    }
  }
  expect(prepare).not.toHaveBeenCalled();
});

test('administrator sessions cannot authenticate reads as bearer values or cookies', async () => {
  const session = await issueAdminSession(ADMIN_TOKEN);
  const prepare = vi.spyOn(memory.db, 'prepare');
  for (const path of paths) {
    for (const authorization of [null, `Bearer ${session}`]) {
      const response = await result(await call(path, authorization, 'GET', session));
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: '인증 필요' });
      expect(JSON.stringify(response.body)).not.toContain(session);
    }
  }
  expect(prepare).not.toHaveBeenCalled();
});

test.each([undefined, '', 'short-distinct-status', ' padded-distinct-status-token '])('optional distinct status token does not tighten administrator reads (%#)', async token => {
  context.env!.COLLECTOR_STATUS_TOKEN = token;
  await expectParity({ synced: false, workers: [] });
});

test('empty snapshots retain unsynchronized semantics without fabricated zeros', async () => {
  await expectParity({ synced: false, workers: [] });
});

test('valid zero counts are synchronized and preserve the complete allowed response shape', async () => {
  const snapshot = statusSnapshot({
    counts: { discovered: 0, source_check_needed: 0, dedup_excluded: 0, verified_waiting: 0, ready_to_publish: 0 },
    total: 0, unique: 0, groups: 0,
  });
  await storeStatus(memory.db, JSON.stringify(snapshot));
  await expectParity({ synced: true, workers: [{ snapshot, received_at: receivedAt, stale: false }] });
});

test.each([
  { age: 0, stale: false },
  { age: 3600000, stale: false },
  { age: 3600001, stale: true },
])('generation age $age ms has stale=$stale despite a recent receipt', async ({ age, stale }) => {
  const snapshot = statusSnapshot({
    generated_at: new Date(STATUS_NOW - age).toISOString(), version: 7, unresolved_conflicts: 2, recheck_due: 4,
  });
  await storeStatus(memory.db, JSON.stringify(snapshot));
  await expectParity({ synced: true, workers: [{ snapshot, received_at: receivedAt, stale }] });
});

test('an old receipt does not make a fresh generation stale', async () => {
  const snapshot = statusSnapshot();
  const oldReceipt = new Date(STATUS_NOW - 7200000).toISOString();
  await storeStatus(memory.db, JSON.stringify(snapshot), oldReceipt);
  await expectParity({ synced: true, workers: [{ snapshot, received_at: oldReceipt, stale: false }] });
});

test('multiple workers retain separate snapshots, freshness flags and worker-ID ordering', async () => {
  const fresh = statusSnapshot();
  const stale = statusSnapshot({ worker_id: 'old-worker', generated_at: new Date(STATUS_NOW - 3600001).toISOString() });
  await storeStatus(memory.db, JSON.stringify(stale), undefined, stale.worker_id);
  await storeStatus(memory.db, JSON.stringify(fresh));
  await expectParity({ synced: true, workers: [
    { snapshot: fresh, received_at: receivedAt, stale: false },
    { snapshot: stale, received_at: receivedAt, stale: true },
  ] });
});

const privateFields = {
  records: [{ id: PRIVATE_MARKER, text: PRIVATE_MARKER }],
  url: `https://private.invalid/${PRIVATE_MARKER}`,
  evidence: { text: PRIVATE_MARKER, credential: ADMIN_TOKEN },
};
test.each([
  ...malformedSnapshots,
  { name: 'local records, URL and evidence', payload: JSON.stringify({ ...statusSnapshot(), ...privateFields }) },
  { name: 'nested private fields', payload: JSON.stringify({ ...statusSnapshot(), counts: { ...statusSnapshot().counts, ...privateFields } }) },
])('$name returns only a generic 503 through the Next.js wrapper', async ({ payload, receivedAt }) => {
  await storeStatus(memory.db, payload, receivedAt);
  await expectPrivateFailure();
});

test('a malformed worker prevents partial results alongside valid snapshots', async () => {
  await storeStatus(memory.db);
  await storeStatus(memory.db, JSON.stringify({ ...statusSnapshot({ worker_id: 'second-worker' }), ...privateFields }), undefined, 'second-worker');
  await expectPrivateFailure();
});

test.each(['synchronous query error', 'asynchronous all rejection', 'unsuccessful empty result', 'unsuccessful populated result'])('%s is sanitized by the Next.js wrapper', async failure => {
  const statement = memory.db.prepare('SELECT 1');
  const error = new Error(JSON.stringify({ ...privateFields, token: STATUS_TOKEN, ingest: INGEST_TOKEN }));
  if (failure === 'asynchronous all rejection') vi.spyOn(statement, 'all').mockRejectedValue(error);
  else vi.spyOn(statement, 'all').mockResolvedValue({
    success: false, error: error.message,
    results: failure === 'unsuccessful populated result' ? [{ payload: JSON.stringify(statusSnapshot()), received_at: receivedAt }] : [],
  } as unknown as D1Result);
  vi.spyOn(memory.db, 'prepare').mockImplementation(() => {
    if (failure === 'synchronous query error') throw error;
    return statement;
  });
  await expectPrivateFailure();
});

test('authenticated POST to the compatibility route returns no-store 405 without database access', async () => {
  const prepare = vi.spyOn(memory.db, 'prepare');
  const response = await result(await call('collector-status', `Bearer ${ADMIN_TOKEN}`, 'POST'));
  expect(response.status).toBe(405);
  expect(response.body).toEqual({ error: '지원하지 않는 경로 또는 메서드' });
  expect(prepare).not.toHaveBeenCalled();
});

test.each(['collector-status/extra', 'collector-status-other'])('the compatibility alias only matches its exact path, excluding %s', async path => {
  const prepare = vi.spyOn(memory.db, 'prepare');
  expect((await result(await call(path, ''))).status).toBe(404);
  expect(prepare).not.toHaveBeenCalled();
});
