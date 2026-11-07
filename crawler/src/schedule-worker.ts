import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquireRunLockWithRetry, type RunLockOptions } from './run-lock';
import { dueSlots, loadSchedule, type CollectionJob, type JobSchedule } from './collection-schedule';
import { runCollectorJob, type JobDefinition, type JobOptions } from './collector-job';
import { digest } from './dedup';
import { identity, serviceProcesses } from './process-identity';
import { invocation, jobEvent, publish } from './collector-events';
import { writePrivate } from './private-state';
import type { CollectorStore } from './store';
import { requireThat } from './store';
import { ScheduleState } from './schedule-state';
export const scheduleHash=(s:JobSchedule[])=>digest(s);
const RETENTION_MS=7*86400000,PRUNE_MS=3600000;
export class ScheduleWorker {
  currentCall:string|null=null;
  evaluations:Partial<Record<CollectionJob,number>>={};
  private busy=false;
  readonly startedAt:number;
  private progress='';
  private progressAt=0;
  private prunedAt=0;
  readonly instance=identity();
  readonly revision=(()=>{try{const v=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return /^[a-f0-9]{40}$/.test(v)?v:'unavailable';}catch{return 'unavailable';}})();
  constructor(readonly store:CollectorStore,readonly definitions:(job:CollectionJob)=>JobDefinition,readonly schedules:JobSchedule[]=loadSchedule(),readonly options:JobOptions={}){this.startedAt=store.now();}
  // Evaluation timestamps are recorded on every pass, including the startup pass.
  // A watchdog confirms recovery from this file, so it must be fresh even while
  // the first due run is still occupying the serial runner.
  evaluate(waiting=false){
    const state=new ScheduleState(this.store),now=this.store.now();
    for(const s of this.schedules){
      this.evaluations[s.job]=now;
      // Disabled schedules are reported by the monitor; recording a synthetic
      // call every minute would only grow history.
      if(!waiting||!s.enabled)continue;
      const expected=dueSlots(s,now);
      const id=randomUUID();state.call(id,s.job,'scheduled','skip',now,undefined,expected);
      state.endCall(id,'skipped','slot_waiting_active_run');
      const context=invocation(s.job,'scheduled',now);context.call_id=id;
      publish(jobEvent(context,'start',now,{expected}),this.options.output);
      publish(jobEvent(context,'result',now,{expected,outcome:'skipped',reason:'slot_waiting_active_run',history_status:'recorded'}),this.options.output);
    }
    this.publishState(now);
  }
  private publishState(now:number,heartbeat=true){
    const rows=this.store.db.prepare("SELECT r.id,r.status,r.next_at,c.phase,c.attempts,c.output_ref FROM collection_schedule_runs r LEFT JOIN engine_checkpoints c ON c.run_id=r.engine_id WHERE r.status IN ('running','pending','intent','halted') ORDER BY r.id,c.id").all();
    const progress=digest(rows);if(progress!==this.progress){this.progress=progress;this.progressAt=now;}
    writePrivate(`${this.store.file}.schedule/scheduler.json`,{schema_version:1,started_at:this.startedAt,identity:this.instance,revision:this.revision,config_hash:scheduleHash(this.schedules),heartbeat:now,evaluations:this.evaluations,current_call_id:this.currentCall,waiting:this.busy?'active_run':null,progress_at:this.progressAt});
    if(heartbeat)publish({schema_version:1,event:'scheduler_heartbeat',generated_at:new Date(now).toISOString(),current_call_id:this.currentCall,progress_at:new Date(this.progressAt).toISOString()},this.options.output);
  }
  // Bound call history growth without touching open calls or run ownership.
  private prune(now:number){
    if(now-this.prunedAt<PRUNE_MS)return;this.prunedAt=now;
    try{this.store.transaction(()=>this.store.db.prepare('DELETE FROM collection_schedule_calls WHERE ended_at IS NOT NULL AND started_at<?').run(now-RETENTION_MS));}catch{/* retention must never stop scheduling */}
  }
  async tick(stopping:()=>boolean=()=>false){
    if(this.busy){this.evaluate(true);return;}
    this.busy=true;
    try{
      for(const schedule of this.schedules){
        if(stopping())break;
        const at=this.store.now();
        this.evaluations[schedule.job]=at;
        this.prune(at);
        // A disabled schedule is reported by the monitor; a per-minute disabled
        // call would only grow history without observing a run.
        if(!schedule.enabled)continue;
        const state=new ScheduleState(this.store),active=state.active(schedule.job);
        // Nothing is due and no logical run needs recovery: record the evaluation
        // in scheduler.json without inserting an already_completed call row.
        if(!active&&!dueSlots(schedule,at,state.watermark(schedule.job)))continue;
        // Persist the evaluation and heartbeat before a potentially long run so
        // watchdog confirmation does not depend on the run completing first. A
        // state write failure is diagnostic only; it must not block collection.
        try{this.publishState(at,false);}
        catch{publish({schema_version:1,event:'diagnostic',generated_at:new Date(at).toISOString(),reason:'result_publish_failed'},this.options.output);}
        try{await runCollectorJob(this.store,schedule,this.definitions(schedule.job),{...this.options,context:undefined,source:'scheduled',onCall:id=>{this.currentCall=id;}});}
        catch{(this.options.log??console.error)(`collector_schedule_error job=${schedule.job} reason=execution_error`);}
      }
    }finally{this.busy=false;this.currentCall=null;}
  }
  async run(signal:AbortSignal,options:{sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;lock?:RunLockOptions;processes?:typeof serviceProcesses}={}){
    requireThat(process.platform==='linux','linux_required');
    const lock=await acquireRunLockWithRetry(this.store,'schedule',options.lock);
    if(!lock.acquired)return {outcome:'skipped',reason:lock.reason};
    const sleep=options.sleep??((ms:number,s:AbortSignal)=>new Promise<void>(resolve=>{
      if(s.aborted){resolve();return;}
      const stop=()=>{clearTimeout(timer);s.removeEventListener('abort',stop);resolve();};
      const timer=setTimeout(stop,ms);s.addEventListener('abort',stop,{once:true});
    }));
    try{requireThat(!(options.processes??serviceProcesses)(resolve('.')).some(p=>p.identity.pid!==process.pid&&p.service==='scheduler'&&p.state!=='gone'&&p.state!=='zombie'),'live_process_without_lock');}catch(e){lock.lock.release();throw e;}
    let timer:ReturnType<typeof setInterval>|undefined;
    try{
      const state=new ScheduleState(this.store);for(const s of this.schedules)state.writeSummary(s.job);
      this.evaluate();
      // Independent observations continue while the single serial runner awaits transport.
      timer=setInterval(()=>{try{this.evaluate(this.busy);}catch{publish({schema_version:1,event:'diagnostic',generated_at:new Date().toISOString(),reason:'scheduler_state_failed'},this.options.output);}},60000);
      while(!signal.aborted){await this.tick(()=>signal.aborted);this.evaluate();if(!signal.aborted)await sleep(60000,signal);}
      return {outcome:'stopped',reason:'shutdown'};
    }finally{if(timer)clearInterval(timer);lock.lock.release();}
  }
}
