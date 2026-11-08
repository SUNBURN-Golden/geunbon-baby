import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { collectionStatus } from '../lib/collection-status';
import { memoryD1 } from './helpers/sqlite';
import { malformedSnapshots, PRIVATE_MARKER, STATUS_NOW, statusSnapshot, storeStatus } from './helpers/collection-status';

let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  memory = memoryD1();
  for (const sql of readFileSync(new URL('../migrations/0007_collector_status.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) {
    await memory.db.prepare(sql).run();
  }
});
afterEach(() => memory.close());

test('a successfully read empty table is unsynchronized and has no fabricated counts', async () => {
  expect(await collectionStatus(memory.db, STATUS_NOW)).toEqual({ synced: false, workers: [] });
});

test.each([
  { age: 0, stale: false },
  { age: 3600000, stale: false },
  { age: 3600001, stale: true },
])('generation age $age ms has stale=$stale, regardless of receipt time', async ({ age, stale }) => {
  const snapshot = statusSnapshot({ generated_at: new Date(STATUS_NOW - age).toISOString() });
  await storeStatus(memory.db, JSON.stringify(snapshot));
  expect(await collectionStatus(memory.db, STATUS_NOW)).toEqual({
    synced: true, workers: [{ snapshot, received_at: new Date(STATUS_NOW).toISOString(), stale }],
  });
});

test('a valid zero-count snapshot is synchronized data', async () => {
  const snapshot = statusSnapshot({ counts: { discovered: 0, source_check_needed: 0, dedup_excluded: 0, verified_waiting: 0, ready_to_publish: 0 }, total: 0, unique: 0, groups: 0 });
  await storeStatus(memory.db, JSON.stringify(snapshot));
  expect(await collectionStatus(memory.db, STATUS_NOW)).toMatchObject({ synced: true, workers: [{ snapshot, stale: false }] });
});

test('multiple workers retain separate counts and generation freshness', async () => {
  const fresh = statusSnapshot();
  const stale = statusSnapshot({ worker_id: 'old-worker', generated_at: new Date(STATUS_NOW - 3600001).toISOString() });
  await storeStatus(memory.db, JSON.stringify(stale), undefined, stale.worker_id);
  await storeStatus(memory.db, JSON.stringify(fresh));
  expect((await collectionStatus(memory.db, STATUS_NOW)).workers).toEqual([
    { snapshot: fresh, received_at: new Date(STATUS_NOW).toISOString(), stale: false },
    { snapshot: stale, received_at: new Date(STATUS_NOW).toISOString(), stale: true },
  ]);
});

test.each(malformedSnapshots)('$name rejects with a fixed error excluding stored content', async ({ payload, receivedAt }) => {
  await storeStatus(memory.db, payload, receivedAt);
  await expect(collectionStatus(memory.db, STATUS_NOW)).rejects.toThrow(/^invalid_stored_collector_snapshot$/);
});

test('a malformed row fails the whole load even alongside valid data', async () => {
  await storeStatus(memory.db);
  await storeStatus(memory.db, `{"${PRIVATE_MARKER}":`, undefined, 'second-worker');
  await expect(collectionStatus(memory.db, STATUS_NOW)).rejects.toThrow(/^invalid_stored_collector_snapshot$/);
});

test('synchronous query errors remain failures', async () => {
  vi.spyOn(memory.db, 'prepare').mockImplementation(() => { throw new Error(PRIVATE_MARKER); });
  await expect(collectionStatus(memory.db, STATUS_NOW)).rejects.toThrow(PRIVATE_MARKER);
});

test('asynchronous all() rejection remains a failure', async () => {
  const statement = memory.db.prepare('SELECT 1');
  vi.spyOn(statement, 'all').mockRejectedValue(new Error(PRIVATE_MARKER));
  vi.spyOn(memory.db, 'prepare').mockReturnValue(statement);
  await expect(collectionStatus(memory.db, STATUS_NOW)).rejects.toThrow(PRIVATE_MARKER);
});

test.each([
  { name: 'empty', results: [] },
  { name: 'populated', results: [{ payload: JSON.stringify(statusSnapshot()), received_at: new Date(STATUS_NOW).toISOString() }] },
])('unsuccessful $name D1 results cannot become empty or synchronized success', async ({ results }) => {
  const statement = memory.db.prepare('SELECT 1');
  vi.spyOn(statement, 'all').mockResolvedValue({ success: false, results, error: PRIVATE_MARKER } as unknown as D1Result);
  vi.spyOn(memory.db, 'prepare').mockReturnValue(statement);
  await expect(collectionStatus(memory.db, STATUS_NOW)).rejects.toThrow(/^collector_status_read_failed$/);
});
