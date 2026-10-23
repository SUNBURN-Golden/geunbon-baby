import { STATUSES, type CollectionRecord, type Snapshot } from './collection-schema';
export function aggregateCollectionStatus(records: CollectionRecord[]) {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0])) as Snapshot['counts'];
  const groups = new Map<string, number>();
  for (const r of records) {
    if (!STATUSES.includes(r.verification_status)) throw new Error('unknown_status');
    counts[r.verification_status]++;
    groups.set(r.dedup_group_id, (groups.get(r.dedup_group_id) ?? 0) + (r.verification_status === 'dedup_excluded' ? 0 : 1));
  }
  if ([...groups.values()].some(n => n !== 1)) throw new Error('representative_invariant');
  return { counts, total: records.length, unique: records.length - counts.dedup_excluded, groups: groups.size };
}
export function parseSnapshot(v: unknown): Snapshot | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Snapshot;
  if (Object.keys(x).sort().join() !== ['worker_id','version','generated_at','counts','total','unique','groups','unresolved_conflicts','recheck_due'].sort().join()) return null;
  const num = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (typeof x.worker_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(x.worker_id) || !num(x.version) || typeof x.generated_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(x.generated_at) || !Number.isFinite(Date.parse(x.generated_at))) return null;
  if (!x.counts || Object.keys(x.counts).sort().join() !== [...STATUSES].sort().join() || !STATUSES.every(s => num(x.counts[s]))) return null;
  if (![x.total,x.unique,x.groups,x.unresolved_conflicts,x.recheck_due].every(num) || x.total !== STATUSES.reduce((n,s) => n+x.counts[s],0) || x.unique !== x.total-x.counts.dedup_excluded || x.groups !== x.unique) return null;
  return x;
}
