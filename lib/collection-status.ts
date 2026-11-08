import { parseSnapshot } from '../shared/collection-status';
export async function receiveStatus(db:D1Database,raw:unknown){
  const s=parseSnapshot(raw);if(!s||Date.parse(s.generated_at)>Date.now()+300000)return {error:'invalid_snapshot',status:400};
  const payload=JSON.stringify({worker_id:s.worker_id,version:s.version,generated_at:s.generated_at,counts:Object.fromEntries(Object.entries(s.counts).sort(([a],[b])=>a.localeCompare(b))),total:s.total,unique:s.unique,groups:s.groups,unresolved_conflicts:s.unresolved_conflicts,recheck_due:s.recheck_due});
  await db.prepare(`INSERT INTO collector_status_snapshots(worker_id,version,generated_at,received_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET version=excluded.version,generated_at=excluded.generated_at,received_at=excluded.received_at,payload=excluded.payload WHERE excluded.version>collector_status_snapshots.version`).bind(s.worker_id,s.version,s.generated_at,new Date().toISOString(),payload).run();
  const row=await db.prepare('SELECT version,payload FROM collector_status_snapshots WHERE worker_id=?').bind(s.worker_id).first<{version:number;payload:string}>();
  if(row?.version===s.version&&row.payload!==payload)return {error:'version_payload_mismatch',status:409};
  return {data:{worker_id:s.worker_id,version:row?.version},status:200};
}
export async function collectionStatus(db:D1Database,now=Date.now()){
  const rows=await db.prepare('SELECT payload,received_at FROM collector_status_snapshots ORDER BY worker_id').all<{payload:string;received_at:string}>();
  if (!rows.success || !Array.isArray(rows.results)) throw new Error('collector_status_read_failed');
  const workers = rows.results.map(row => {
    let raw: unknown;
    try { raw = JSON.parse(row.payload); }
    catch { throw new Error('invalid_stored_collector_snapshot'); }
    const snapshot = parseSnapshot(raw);
    if (!snapshot || typeof row.received_at !== 'string' || !Number.isFinite(Date.parse(row.received_at))) {
      throw new Error('invalid_stored_collector_snapshot');
    }
    return { snapshot, received_at: row.received_at, stale: now - Date.parse(snapshot.generated_at) > 3600000 };
  });
  return { synced: workers.length > 0, workers };
}
