import { acquireRunLockWithRetry, type RunLockOptions } from './run-lock';
import { loadSchedule, type CollectionJob, type JobSchedule } from './collection-schedule';
import { runCollectorJob, type JobDefinition, type JobOptions } from './collector-job';
import type { CollectorStore } from './store';
import { requireThat } from './store';
import { ScheduleState } from './schedule-state';
export class ScheduleWorker {
  constructor(readonly store:CollectorStore,readonly definitions:(job:CollectionJob)=>JobDefinition,readonly schedules:JobSchedule[]=loadSchedule(),readonly options:JobOptions={}){}
  async tick(stopping:()=>boolean=()=>false){
    for(const schedule of this.schedules){
      if(stopping())break;if(!schedule.enabled)continue;
      try{await runCollectorJob(this.store,schedule,this.definitions(schedule.job),{...this.options,source:'scheduled'});}
      catch{(this.options.log??console.error)(`collector_schedule_error job=${schedule.job} reason=execution_error`);}
    }
  }
  async run(signal:AbortSignal,options:{sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;lock?:RunLockOptions}={}){
    requireThat(process.platform==='linux','linux_required');
    const lock=await acquireRunLockWithRetry(this.store,'schedule',options.lock);
    if(!lock.acquired)return {outcome:'skipped',reason:lock.reason};
    const sleep=options.sleep??((ms:number,s:AbortSignal)=>new Promise<void>(resolve=>{
      if(s.aborted){resolve();return;}
      const stop=()=>{clearTimeout(timer);s.removeEventListener('abort',stop);resolve();};
      const timer=setTimeout(stop,ms);s.addEventListener('abort',stop,{once:true});
    }));
    try{
      // Summaries are disposable views. Never reconstruct DB history from missing JSON.
      const state=new ScheduleState(this.store);for(const s of this.schedules)state.writeSummary(s.job);
      while(!signal.aborted){await this.tick(()=>signal.aborted);if(!signal.aborted)await sleep(60000,signal);}
      return {outcome:'stopped',reason:'shutdown'};
    }finally{lock.lock.release();}
  }
}
