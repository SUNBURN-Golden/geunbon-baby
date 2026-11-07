import { engineProgress } from '../engine/progress';
import type { CollectorStore } from './store';
export function engineSnapshot(store:CollectorStore,id:string){
  const attempts=Number(store.db.prepare('SELECT coalesce(sum(attempts),0) n FROM engine_checkpoints WHERE run_id=?').get(id)!.n);
  const receipts=Number(store.db.prepare("SELECT count(DISTINCT r.id) n FROM engine_checkpoints c JOIN intake_receipts r ON r.id=c.output_ref WHERE c.run_id=? AND c.stage='service' AND c.phase='done'").get(id)!.n);
  return {attempts,receipts};
}
export function collectCounts(store:CollectorStore,id:string,before?:ReturnType<typeof engineSnapshot>,diagnostic?:(code:string)=>void){
  const progress=engineProgress(store,id),after=engineSnapshot(store,id);
  const attempts=after.attempts-(before?.attempts??after.attempts),receipts=after.receipts-(before?.receipts??after.receipts);
  // Snapshot deltas are counts of work done; a decrease means history was
  // reconciled or removed. Clamp the contract value but record a diagnostic.
  if(attempts<0||receipts<0)diagnostic?.('counts_negative_delta');
  return {engine:{checkpoints_done:progress.counts.done,checkpoints_failed:progress.counts.failed,checkpoints_skipped:progress.counts.skipped,checkpoints_unfinished:progress.counts.unfinished,service_receipts_confirmed:after.receipts},invocation:{checkpoint_attempts_delta:Math.max(0,attempts),service_receipts_confirmed_delta:Math.max(0,receipts)}};
}
