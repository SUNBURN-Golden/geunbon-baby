import type { EngineDb } from './types';
export type EngineProgress = {status:'pending'|'succeeded'|'partial_failure'|'halted'|'exhausted';reason:string;nextAt:number|null;finishedAt:number|null;counts:Record<string,number>};
// Read persisted readiness without acquiring leases, recovering outputs or changing attempts.
export function engineProgress(store:EngineDb,id:string):EngineProgress {
  const run=store.db.prepare('SELECT state,finished_at FROM engine_runs WHERE id=?').get(id) as {state:string;finished_at:string|null}|undefined;
  if(!run)throw new Error('engine_missing');
  const rows=store.db.prepare('SELECT phase,next_at,lease_until,error_code FROM engine_checkpoints WHERE run_id=?').all(id) as {phase:string;next_at:number;lease_until:number|null;error_code:string|null}[];
  const counts={done:0,failed:0,skipped:0,unfinished:0};const dates:number[]=[];
  for(const c of rows){
    if(c.phase==='done')counts.done++;
    else if(c.phase==='failed')counts.failed++;
    else if(c.phase==='skipped'){
      counts.skipped++;
      if(c.error_code!=='unsupported')counts.failed++;
    }else if(['pending','retry_wait','deferred','leased'].includes(c.phase)){
      counts.unfinished++;const at=c.phase==='leased'?c.lease_until:c.next_at;
      if(at===null||!Number.isSafeInteger(at)||at<0)throw new Error('engine_checkpoint_time');
      dates.push(at);
    }else throw new Error('engine_checkpoint_phase');
  }
  const finishedAt=run.finished_at===null?null:Date.parse(run.finished_at);
  if(finishedAt!==null&&!Number.isFinite(finishedAt))throw new Error('engine_finish_time');
  if(run.state==='finished'){
    if(counts.unfinished||finishedAt===null)throw new Error('engine_state_conflict');
    return {status:counts.failed?'partial_failure':'succeeded',reason:counts.failed?'checkpoint_failed':counts.skipped?'policy_skipped':rows.length?'completed':'no_work',nextAt:null,finishedAt,counts};
  }
  if(run.state==='halted'||run.state==='exhausted')return {status:run.state,reason:run.state,nextAt:null,finishedAt:null,counts};
  if(!['running','cost_wait'].includes(run.state)||finishedAt!==null||run.state==='cost_wait'&&!dates.length)throw new Error('engine_state_conflict');
  return {status:'pending',reason:run.state==='cost_wait'?'cost_wait':'checkpoint_wait',nextAt:dates.length?Math.min(...dates):store.now(),finishedAt:null,counts};
}
