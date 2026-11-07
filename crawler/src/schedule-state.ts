import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CollectorStore, requireThat } from './store';
import { JOBS, kstTime, type CollectionJob, type SlotBatch } from './collection-schedule';
export type LogicalRun={id:string;job:CollectionJob;version:string|null;first_slot:number|null;target_slot:number|null;slot_count:number;engine_key:string|null;engine_origin:string|null;engine_id:string|null;seeded:number;status:string;reason:string;next_at:number|null;created_at:number;finished_at:number|null};
export class ScheduleState {
  constructor(readonly store:CollectorStore){}
  active(job:CollectionJob){return this.store.db.prepare("SELECT * FROM collection_schedule_runs WHERE job=? AND status IN ('intent','running','pending','halted') ORDER BY engine_id IS NULL,created_at,id LIMIT 1").get(job) as LogicalRun|undefined;}
  byEngine(id:string){return this.store.db.prepare('SELECT * FROM collection_schedule_runs WHERE engine_id=?').get(id) as LogicalRun|undefined;}
  get(id:string){return this.store.db.prepare('SELECT * FROM collection_schedule_runs WHERE id=?').get(id) as LogicalRun;}
  watermark(job:CollectionJob){return (this.store.db.prepare('SELECT max(target_slot) at FROM collection_schedule_runs WHERE job=?').get(job) as {at:number|null}).at??undefined;}
  exhausted(job:CollectionJob){return this.store.db.prepare("SELECT * FROM collection_schedule_runs WHERE job=? AND status='exhausted' ORDER BY created_at DESC LIMIT 1").get(job) as LogicalRun|undefined;}
  create(job:CollectionJob,batch:SlotBatch|undefined,engineKey:string|null,id=randomUUID()){
    this.store.transaction(()=>this.store.db.prepare("INSERT INTO collection_schedule_runs(id,job,version,first_slot,target_slot,slot_count,engine_key,status,reason,created_at) VALUES(?,?,?,?,?,?,?,'intent','claimed',?)").run(id,job,batch?.version??null,batch?.first??null,batch?.target??null,batch?.count??0,engineKey,this.store.now()));
    return this.get(id);
  }
  adopt(job:CollectionJob,engineId:string){
    const id=randomUUID();
    this.store.transaction(()=>this.store.db.prepare("INSERT INTO collection_schedule_runs(id,job,slot_count,engine_key,engine_id,engine_origin,seeded,status,reason,created_at) VALUES(?,?,0,?,?,'legacy_unassigned',1,'intent','claimed',?)").run(id,job,engineId,engineId,this.store.now()));
    return this.get(id);
  }
  // A recovered call has an observation time, never a fabricated process end time.
  recoverCalls(job:CollectionJob){return this.store.transaction(()=>{
    const rows=this.store.db.prepare("SELECT id,run_id,source,started_at,expected_slot,schedule_version FROM collection_schedule_calls WHERE job=? AND ended_at IS NULL AND outcome='running'").all(job) as {id:string;run_id:string|null;source:'manual'|'scheduled';started_at:number;expected_slot:number|null;schedule_version:string|null}[];
    this.store.db.prepare("UPDATE collection_schedule_calls SET outcome='interrupted',reason='owner_gone',observed_at=? WHERE job=? AND ended_at IS NULL AND outcome='running'").run(this.store.now(),job);return rows;
  });}
  call(id:string,job:CollectionJob,source:'manual'|'scheduled',action:'new'|'resume'|'skip'|'dry_run',started:number,run?:LogicalRun,expected?:{target:number;version:string}){
    this.store.transaction(()=>this.store.db.prepare("INSERT INTO collection_schedule_calls(id,job,source,run_id,action,started_at,expected_slot,schedule_version,outcome,reason) VALUES(?,?,?,?,?,?,?,?,'running','started')").run(id,job,source,run?.id??null,action,started,expected?.target??null,expected?.version??null));
  }
  endCall(id:string,outcome:string,reason:string,counts:Record<string,unknown>={engine:null,invocation:null}){this.store.transaction(()=>this.store.db.prepare('UPDATE collection_schedule_calls SET ended_at=?,outcome=?,reason=?,counts=? WHERE id=?').run(this.store.now(),outcome,reason,JSON.stringify(counts),id));}
  update(id:string,status:string,reason:string,nextAt:number|null=null,finishedAt:number|null=null){this.store.transaction(()=>this.store.db.prepare('UPDATE collection_schedule_runs SET status=?,reason=?,next_at=?,finished_at=? WHERE id=?').run(status,reason,nextAt,finishedAt,id));}
  summary(job:CollectionJob){
    const success=this.store.db.prepare("SELECT target_slot,finished_at FROM collection_schedule_runs WHERE job=? AND target_slot IS NOT NULL AND status='succeeded' ORDER BY target_slot DESC LIMIT 1").get(job) as {target_slot:number;finished_at:number}|undefined;
    // Synthetic evaluation rows (lock contention or another job's active run) must
    // not shadow the last real invocation in the per-job summary.
    const call=this.store.db.prepare("SELECT id,run_id,source,action,started_at,ended_at,observed_at,outcome,reason,counts,expected_slot,schedule_version FROM collection_schedule_calls WHERE job=? AND NOT (action='skip' AND (reason LIKE 'run_lock%' OR reason='slot_waiting_active_run')) ORDER BY started_at DESC,rowid DESC LIMIT 1").get(job) as Record<string,unknown>|undefined;
    // Recovery can be created after a parked intent; report the run most recently invoked.
    const lastRun=this.store.db.prepare('SELECT run_id FROM collection_schedule_calls WHERE job=? AND run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(job) as {run_id:string}|undefined;
    const run=typeof call?.run_id==='string'?this.get(call.run_id):this.active(job)??(lastRun?this.get(lastRun.run_id):this.store.db.prepare('SELECT * FROM collection_schedule_runs WHERE job=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(job) as LogicalRun|undefined);
    const time=(v:unknown)=>typeof v==='number'?kstTime(v):null;
    return {job,last_success_at:time(success?.finished_at),last_success_slot:time(success?.target_slot),run:run?{...run,created_at:time(run.created_at),first_slot:time(run.first_slot),target_slot:time(run.target_slot),finished_at:time(run.finished_at),next_at:time(run.next_at)}:null,call:call?{...call,started_at:time(call.started_at),ended_at:time(call.ended_at),observed_at:time(call.observed_at),expected_slot:time(call.expected_slot),counts:JSON.parse(String(call.counts))}:null};
  }
  writeSummary(job:CollectionJob){
    requireThat(JOBS.includes(job),'schedule_job');
    const dir=`${this.store.file}.schedule`;
    mkdirSync(dir,{recursive:true,mode:0o700});
    const stat=lstatSync(dir);requireThat(!stat.isSymbolicLink()&&stat.isDirectory()&&realpathSync(dir)===dir&&(stat.mode&0o777)===0o700,'unsafe_directory');
    const path=join(dir,`${job}.json`),old=lstatSync(path,{throwIfNoEntry:false});
    requireThat(!old||!old.isSymbolicLink()&&old.isFile()&&(old.mode&0o777)===0o600,'unsafe_file');
    const tmp=join(dir,`.${randomUUID()}.tmp`),fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{
      try{writeFileSync(fd,JSON.stringify(this.summary(job))+'\n');fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(tmp,path);const d=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(d);}finally{closeSync(d);}
    }finally{rmSync(tmp,{force:true});}
  }
}
