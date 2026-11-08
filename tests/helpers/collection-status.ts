import type { Snapshot } from '../../shared/collection-schema';

export const STATUS_NOW = Date.parse('2026-10-24T02:00:00.000Z');
export const PRIVATE_MARKER = 'synthetic-private-payload-marker';
export function statusSnapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    worker_id: 'offline-worker', version: 1, generated_at: new Date(STATUS_NOW).toISOString(),
    counts: { discovered: 11, source_check_needed: 7, dedup_excluded: 3, verified_waiting: 5, ready_to_publish: 2 },
    total: 28, unique: 25, groups: 25, unresolved_conflicts: 0, recheck_due: 0,
    ...patch,
  };
}
export const malformedSnapshots = [
  { name: 'invalid JSON', payload: `{"${PRIVATE_MARKER}":` },
  { name: 'null', payload: 'null' },
  { name: 'missing counts', payload: JSON.stringify({ ...statusSnapshot(), counts: undefined }) },
  { name: 'invalid generation timestamp', payload: JSON.stringify(statusSnapshot({ generated_at: PRIVATE_MARKER })) },
  { name: 'inconsistent total', payload: JSON.stringify(statusSnapshot({ total: 29 })) },
  { name: 'inconsistent unique', payload: JSON.stringify(statusSnapshot({ unique: 26 })) },
  { name: 'inconsistent groups', payload: JSON.stringify(statusSnapshot({ groups: 26 })) },
  { name: 'negative count', payload: JSON.stringify(statusSnapshot({ counts: { ...statusSnapshot().counts, discovered: -1 } })) },
  { name: 'unexpected private field', payload: JSON.stringify({ ...statusSnapshot(), private_data: PRIVATE_MARKER }) },
  { name: 'invalid receipt timestamp', payload: JSON.stringify(statusSnapshot()), receivedAt: PRIVATE_MARKER },
];
export async function storeStatus(db: D1Database, payload = JSON.stringify(statusSnapshot()), receivedAt = new Date(STATUS_NOW).toISOString(), workerId = 'offline-worker') {
  await db.prepare('INSERT INTO collector_status_snapshots (worker_id,version,generated_at,received_at,payload) VALUES (?,1,?,?,?)')
    .bind(workerId, new Date(STATUS_NOW).toISOString(), receivedAt, payload).run();
}
