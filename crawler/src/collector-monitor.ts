import type { DatabaseSync } from 'node:sqlite';
import { dueSlots, type JobSchedule } from './collection-schedule';
import { scheduleHash } from './schedule-worker';
import { type LogicalRun } from './schedule-state';
export type SchedulerStatus={schema_version:number;started_at:number;identity:import('./process-identity').Identity;revision:string;config_hash:string;heartbeat:number;evaluations:Record<string,number>;current_call_id:string|null;waiting:string|null;progress_at:number};
export type Finding={job?:string;code:string;status?:string;next_at?:number|null};
export function monitor(db:DatabaseSync,schedules:JobSchedule[],now:number,status?:SchedulerStatus):Finding[]{
  const out:Finding[]=[];
  if(!status)out.push({code:'scheduler_state_unavailable'});
  else {
    if(status.config_hash!==scheduleHash(schedules))return [{code:'schedule_config_mismatch'}];
    if(!Number.isFinite(status.heartbeat)||status.heartbeat>now||now-status.heartbeat>=180000||schedules.some(s=>s.enabled&&(Number.isFinite(status.evaluations[s.job])?now-status.evaluations[s.job]>=180000:!Number.isFinite(status.started_at)||now-status.started_at>=180000)))out.push({code:'stale_scheduler'});
  }
  for(const s of schedules){
    if(!s.enabled){out.push({job:s.job,code:'schedule_disabled'});continue;}
    const slot=dueSlots(s,now)!;
    const runs=db.prepare('SELECT * FROM collection_schedule_runs WHERE job=? ORDER BY created_at DESC,rowid DESC').all(s.job) as unknown as LogicalRun[];
    // Validate the exact recorded version/range rather than assuming a recent call covers slots.
    const covered=runs.find(r=>r.version===slot.version&&r.first_slot!==null&&r.target_slot!==null&&r.first_slot<=slot.target&&r.target_slot>=slot.target&&dueSlots(s,r.target_slot,r.first_slot-1)?.count===r.slot_count);
    const call=db.prepare('SELECT outcome,reason FROM collection_schedule_calls WHERE job=? AND expected_slot=? AND schedule_version=? ORDER BY rowid DESC LIMIT 1').get(s.job,slot.target,slot.version) as {outcome:string;reason:string}|undefined;
    if(now-slot.target>=300000&&!covered&&!call)out.push({job:s.job,code:'missing_slot'});
    const success=runs.find(r=>r.status==='succeeded'&&r.version===slot.version&&r.target_slot!==null);
    if(!success||success.target_slot!<slot.target)out.push({job:s.job,code:'last_success_stale',status:covered?.status??call?.outcome??'unobserved',next_at:covered?.next_at??null});
    if(call?.reason.startsWith('run_lock'))out.push({job:s.job,code:'slot_waiting_lock'});
    const active=runs.find(r=>['intent','running','pending','halted'].includes(r.status));
    // A synthetic evaluation call means the serial runner is occupied by another
    // job. Report it as waiting even though this job has no active run of its own.
    if(!active&&call?.reason==='slot_waiting_active_run')out.push({job:s.job,code:'slot_waiting_active_run',status:'skipped'});
    if(active){
      if(active.target_slot!==slot.target)out.push({job:s.job,code:'slot_waiting_active_run',status:active.status});
      if(active.next_at!==null&&active.next_at>now)out.push({job:s.job,code:'waiting_deadline',next_at:active.next_at});
      else if(active.next_at!==null&&now-active.next_at>=300000&&(!status||status.evaluations[s.job]<active.next_at))out.push({job:s.job,code:'resume_overdue'});
      else if(active.status==='running'&&status&&now-status.progress_at>=900000)out.push({job:s.job,code:'progress_stale'});
    }
  }
  return out;
}

