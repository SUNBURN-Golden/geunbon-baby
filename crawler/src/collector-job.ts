import { safeReason } from '../collector-bootstrap.mjs';
import { invocation, jobEvent, publish, safeCounts, type Invocation, type Counts } from './collector-events';
import { engineSnapshot, collectCounts } from './collector-measurements';
import { randomUUID } from 'node:crypto';
import { engineProgress } from '../engine/progress';
import { digest } from './dedup';
import { dueSlots, kstDay, kstTime, type JobSchedule } from './collection-schedule';
import { acquireRunLockWithRetry, type RunLockOptions } from './run-lock';
import { ScheduleState, type LogicalRun } from './schedule-state';
import { CollectorStore, requireThat } from './store';
export type JobResult={status:'succeeded'|'partial_failure'|'disabled';reason:string;output?:unknown;counts?:Record<string,number>};
export type JobAdapter={enabled:boolean;start?:(slot:{kind:string;at:string;data?:Record<string,unknown>})=>string;seed?:(id:string)=>void;resume?:(id:string)=>string;run:(id?:string,callId?:string)=>Promise<unknown>;result?:(output:unknown)=>JobResult;preview?:()=>Promise<unknown>|unknown};
export type JobDefinition={profileId?:string;create:(offline?:boolean)=>JobAdapter;output?:(id:string)=>unknown};
export type JobOptions={source?:'manual'|'scheduled';resumeId?:string;dryRun?:boolean;lock?:RunLockOptions;log?:(line:string)=>void;fault?:(point:string)=>void;context?:Invocation;output?:(line:string)=>void;onCall?:(id:string|null)=>void};
export type InvocationResult={outcome:string;reason:string;run_id?:string;output?:unknown};
export async function runCollectorJob(store:CollectorStore,schedule:JobSchedule,definition:JobDefinition,options:JobOptions={}):Promise<InvocationResult>{
  const context=options.context??invocation(schedule.job,options.source??'manual',store.now());
  const state=new ScheduleState(store),callId=context.call_id,started=context.started_at,source=options.source??'manual',log=options.log??(line=>console.error(line));
  const expected=schedule.enabled?dueSlots(schedule,store.now()):undefined;
  let measured:Counts={engine:null,invocation:null},before:ReturnType<typeof engineSnapshot>|undefined;
  const publishResult=(outcome:string,reason:string,result?:unknown)=>{context.completed=true;try{publish(jobEvent(context,'result',store.now(),{logical,expected,outcome,reason,counts:measured,output:result,history_status:called&&reason!=='call_history_unavailable'?'recorded':'unavailable'}),options.output);}catch{publish({schema_version:1,event:'diagnostic',generated_at:new Date(store.now()).toISOString(),reason:'result_publish_failed'},options.output);}};
  if(!options.context)publish(jobEvent(context,'start',store.now(),{expected}),options.output);
  options.onCall?.(callId);
  const emit=(event:string,outcome:string,reason:string)=>{try{log(`collector_${event} at=${kstTime(store.now())} job=${schedule.job} call_id=${callId} source=${source} outcome=${outcome} reason=${safeReason(reason)}`);}catch{publish({schema_version:1,event:'diagnostic',generated_at:new Date(store.now()).toISOString(),reason:'result_publish_failed'},options.output);}};
  emit('start','running','started');
  let lock;
  let logical:LogicalRun|undefined,called=false;
  try{lock=await acquireRunLockWithRetry(store,'crawl',options.lock);}
  catch(error){
    if (options.lock?.cronSignal?.aborted) {
      publishResult('interrupted', 'shutdown');options.onCall?.(null);emit('end','interrupted','shutdown');
      return {outcome:'interrupted',reason:'shutdown'};
    }
    publishResult('failed','lock_error');options.onCall?.(null);emit('end','failed','lock_error');throw error;}
  if(!lock.acquired){try{state.call(callId,schedule.job,source,'skip',started,undefined,expected);state.endCall(callId,'skipped',lock.reason);called=true;}catch{publishResult('failed','call_history_unavailable');options.onCall?.(null);throw new Error('call_history_unavailable');}publishResult('skipped',lock.reason);options.onCall?.(null);emit('end','skipped',lock.reason);return {outcome:'skipped',reason:lock.reason};}
  const call=(action:'new'|'resume'|'skip'|'dry_run')=>{
    if(called)store.transaction(()=>store.db.prepare('UPDATE collection_schedule_calls SET run_id=?,action=? WHERE id=?').run(logical?.id??null,action,callId));
    else{state.call(callId,schedule.job,source,action,started,logical,expected);called=true;}
  };
  const finish=(outcome:string,reason:string,output?:unknown,counts:Record<string,number>={}):InvocationResult=>{
    if(logical?.engine_id&&schedule.job==='collect')measured=collectCounts(store,logical.engine_id,before,code=>emit('diagnostic','failed',code));
    else if(Object.keys(counts).length)measured={engine:null,invocation:counts};
    measured={engine:safeCounts(measured.engine),invocation:safeCounts(measured.invocation)};
    if(!called)call('skip');state.endCall(callId,outcome,reason,measured);
    try{state.writeSummary(schedule.job);}catch{emit('status_error','failed','summary_write_failed');}
    publishResult(outcome,reason,output);emit('end',outcome,reason);
    return {outcome,reason,...(logical?.engine_id?{run_id:logical.engine_id}:{}),...(output!==undefined?{output}:{})};
  };
  try{
    // The lock proves there is no surviving crawler owner. Leases remain untouched.
    for(const recovered of state.recoverCalls(schedule.job)){
      const previous=invocation(schedule.job,recovered.source,recovered.started_at);previous.call_id=recovered.id as typeof previous.call_id;
      const event=jobEvent(previous,'result',store.now(),{logical:recovered.run_id?state.get(recovered.run_id):undefined,expected:recovered.expected_slot!==null&&recovered.schedule_version!==null?{target:recovered.expected_slot,version:recovered.schedule_version}:undefined,outcome:'interrupted',reason:'owner_gone'});
      publish({...event,ended_at:null,observed_at:new Date(store.now()).toISOString()},options.output);
    }
    call('skip');
    options.fault?.('before_claim');
    if(options.dryRun){call('dry_run');const adapter=definition.create(true);return finish('dry_run','preview',await adapter.preview?.());}
    logical=state.active(schedule.job);
    const profile=definition.profileId;
    // A claim made before engine creation keeps its slot while separate retry work recovers.
    // If the deterministic engine already exists, it must retain priority and ownership.
    const unstartedIntent=logical?.status==='intent'&&!logical.engine_id&&!!logical.engine_key&&!store.db.prepare('SELECT 1 FROM engine_runs WHERE id=?').get(logical.engine_key);
    if(options.resumeId){
      requireThat(profile,'run_not_resumable');
      const old=store.db.prepare('SELECT id,state,profile_id FROM engine_runs WHERE id=?').get(options.resumeId) as {id:string;state:string;profile_id:string}|undefined;
      requireThat(old?.profile_id===profile,'run_not_resumable');
      // Completed legacy/daily/manual retry runs never claim a current schedule slot.
      if(old!.state==='finished')return finish('already_completed','already_completed',definition.output?.(old!.id)??{run_id:old!.id,state:old!.state});
      requireThat(!logical||logical.engine_id===old!.id||unstartedIntent,'active_run_conflict');
      logical=state.byEngine(old!.id)??state.adopt(schedule.job,old!.id);
    }
    if(profile&&(!logical||unstartedIntent)&&!options.resumeId){
      const old=store.db.prepare("SELECT id FROM engine_runs WHERE profile_id=? AND state IN ('running','cost_wait','halted') ORDER BY started_at,id LIMIT 1").get(profile) as {id:string}|undefined;
      if(old){
        logical=state.byEngine(old.id);
        // Isolated checkpoint retries retain unassigned ownership during recovery.
        if(!logical)logical=state.adopt(schedule.job,old.id);
      }
    }
    // A parked claim has not spent an engine budget yet; recovery exhaustion must
    // block its creation just as it blocks a newly claimed slot on the same day.
    if(!logical||(profile&&!logical.engine_id&&!store.db.prepare('SELECT 1 FROM engine_runs WHERE id=?').get(logical.engine_key))){
      const exhausted=state.exhausted(schedule.job);
      const engineExhausted=profile?store.db.prepare("SELECT started_at FROM engine_runs WHERE profile_id=? AND state='exhausted' ORDER BY started_at DESC LIMIT 1").get(profile) as {started_at:string}|undefined:undefined;
      if((exhausted&&kstDay(exhausted.finished_at??exhausted.created_at)>=kstDay(store.now()))||(engineExhausted&&kstDay(Date.parse(engineExhausted.started_at))>=kstDay(store.now())))return finish('exhausted','next_day_required');
    }
    if(!logical){
      const batch=schedule.enabled?dueSlots(schedule,store.now(),state.watermark(schedule.job)):undefined;
      if(schedule.enabled&&!batch)return finish('already_completed','already_completed');
      const id=randomUUID(),at=batch?new Date(batch.target).toISOString():id,kind=batch?'scheduled':'manual';
      logical=state.create(schedule.job,batch,profile?digest([profile,kind,at]):null,id);
      options.fault?.('after_claim');
    }
    if(profile&&!logical.engine_id&&logical.engine_key){
      const saved=store.db.prepare('SELECT profile_id,state,data FROM engine_runs WHERE id=?').get(logical.engine_key) as {profile_id:string;state:string;data:string}|undefined;
      if(saved){
        requireThat(saved.profile_id===profile,'engine_identity_conflict');
        const owned=JSON.parse(saved.data).collection_intent===logical.id;
        const legacy=logical.target_slot===null&&logical.engine_key!==digest([profile,'manual',logical.id]);
        if(!owned&&!legacy){
          requireThat(saved.state==='finished','engine_origin_conflict');
          state.update(logical.id,'already_completed','existing_engine');return finish('already_completed','existing_engine');
        }
        requireThat(!state.byEngine(logical.engine_key),'engine_ownership_conflict');
        store.transaction(()=>store.db.prepare('UPDATE collection_schedule_runs SET engine_id=engine_key,engine_origin=?,seeded=? WHERE id=?').run(legacy?'legacy_unassigned':'recovered',legacy?1:logical!.seeded,logical!.id));
        logical=state.get(logical.id);
      }
    }
    call('skip');
    if(!profile&&logical.status!=='intent'){
      state.update(logical.id,'interrupted','owner_gone');return finish('interrupted','owner_gone');
    }
    // Non-engine work cannot prove whether network effects committed after process death.
    if(!profile&&store.db.prepare("SELECT 1 FROM collection_schedule_calls WHERE run_id=? AND outcome='interrupted' LIMIT 1").get(logical.id)){
      state.update(logical.id,'interrupted','owner_gone');return finish('interrupted','owner_gone');
    }
    if(profile&&logical.engine_id){
      if(schedule.job==='collect')before=engineSnapshot(store,logical.engine_id);
      let progress=engineProgress(store,logical.engine_id);
      if(progress.status==='halted'&&options.resumeId){definition.create().resume!(logical.engine_id);progress=engineProgress(store,logical.engine_id);}
      if(progress.status!=='pending'){
        state.update(logical.id,progress.status,logical.engine_origin==='legacy_unassigned'?'legacy_unassigned':progress.reason,null,progress.finishedAt??(progress.status==='exhausted'?logical.finished_at??store.now():null));
        return finish(progress.status,logical.engine_origin==='legacy_unassigned'?'legacy_unassigned':progress.reason,definition.output?.(logical.engine_id)??{run_id:logical.engine_id,state:store.db.prepare('SELECT state FROM engine_runs WHERE id=?').get(logical.engine_id)!.state},progress.counts);
      }
      if(progress.nextAt!==null&&progress.nextAt>store.now()){
        state.update(logical.id,'pending',progress.reason,progress.nextAt);return finish('pending',progress.reason,definition.output?.(logical.engine_id)??{run_id:logical.engine_id,state:store.db.prepare('SELECT state FROM engine_runs WHERE id=?').get(logical.engine_id)!.state},progress.counts);
      }
    }
    const adapter=definition.create();
    if(!adapter.enabled&&!logical.engine_id){state.update(logical.id,'disabled','sources_disabled',null,store.now());return finish('disabled','sources_disabled',{state:'finished',enabled:false});}
    const resuming=!!logical.engine_id;call(resuming?'resume':'new');state.writeSummary(schedule.job);
    if(profile&&!logical.engine_id){
      const at=logical.target_slot===null?logical.id:new Date(logical.target_slot).toISOString();
      options.fault?.('before_engine_start');
      const engineId=adapter.start!({kind:logical.target_slot===null?'manual':'scheduled',at,data:{collection_intent:logical.id}});
      options.fault?.('after_engine_start');
      // Never attach a returned daily, completed, active, or retry ID to a new slot.
      requireThat(engineId===logical.engine_key,'engine_identity_conflict');
      const created=store.db.prepare('SELECT data FROM engine_runs WHERE id=?').get(engineId) as {data:string}|undefined;
      requireThat(created&&JSON.parse(created.data).collection_intent===logical.id,'engine_origin_conflict');
      requireThat(!state.byEngine(engineId),'engine_ownership_conflict');
      store.transaction(()=>store.db.prepare("UPDATE collection_schedule_runs SET engine_id=?,engine_origin='created' WHERE id=?").run(engineId,logical!.id));logical=state.get(logical.id);
      options.fault?.('after_engine_link');
    }
    if(profile){
      // A crash between engine creation and linking is recovered using the saved key.
      if(schedule.job==='collect'&&!before)before=engineSnapshot(store,logical.engine_id!);
      const progressBefore=engineProgress(store,logical.engine_id!);
      if(progressBefore.status==='pending'){
        if(resuming)adapter.resume!(logical.engine_id!);
        if(!logical.seeded){adapter.seed!(logical.engine_id!);store.transaction(()=>store.db.prepare('UPDATE collection_schedule_runs SET seeded=1 WHERE id=?').run(logical!.id));}
      }
      state.update(logical.id,'running','started');state.writeSummary(schedule.job);
      if(progressBefore.status==='pending')await adapter.run(logical.engine_id!,callId);
      options.fault?.('before_result');
      const progress=engineProgress(store,logical.engine_id!);
      const reason=logical.engine_origin==='legacy_unassigned'?'legacy_unassigned':progress.reason;
      state.update(logical.id,progress.status,reason,progress.nextAt,progress.finishedAt??(progress.status==='exhausted'?logical.finished_at??store.now():null));
      options.fault?.('after_result');
      return finish(progress.status,reason,definition.output?.(logical.engine_id!)??{run_id:logical.engine_id,state:store.db.prepare('SELECT state FROM engine_runs WHERE id=?').get(logical.engine_id!)!.state},progress.counts);
    }
    state.update(logical.id,'running','started');state.writeSummary(schedule.job);
    const output=await adapter.run(undefined,callId);options.fault?.('before_result');
    const result=adapter.result!(output);state.update(logical.id,result.status,safeReason(result.reason),null,store.now());options.fault?.('after_result');
    return finish(result.status,safeReason(result.reason),result.output??output,result.counts);
  }catch(error){
    let recorded=true;
    try{if(!called)call('skip');state.endCall(callId,'failed','execution_error');}catch{recorded=false;}
    // Keep intents and engine ownership for deterministic recovery; do not turn errors into successes.
    try{if(logical&&!definition.profileId&&state.get(logical.id).status==='running')state.update(logical.id,'interrupted','execution_error');state.writeSummary(schedule.job);}catch{emit('status_error','failed','summary_write_failed');}
    publishResult('failed',recorded?'execution_error':'call_history_unavailable');emit('end','failed',recorded?'execution_error':'call_history_unavailable');throw error;
  }finally{options.onCall?.(null);lock.lock.release();}
}
