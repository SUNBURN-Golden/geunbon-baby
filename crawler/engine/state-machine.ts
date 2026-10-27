import { randomUUID } from 'node:crypto';
import type { Checkpoint, Data, EngineDb, RunState, StageHandler, StageResult } from './types';
import { acquire, release, renew } from './lease';
import { classify, errorCode, HALT_CODES, nextAttemptAt } from './retry';
import { digest, midnight } from './util';
import { CostCapError } from './types';
type Run={id:string;profile_id:string;state:RunState;data:string};
export class JobEngine {
  readonly owner=randomUUID();
  constructor(readonly store:EngineDb,readonly profileId:string,readonly stages:string[],readonly handlers:Record<string,StageHandler>,readonly options:{rng?:()=>number;fault?:(point:string)=>void;onHalt?:(c:Checkpoint,code:string)=>void;maxAttempts?:number}={}){}
  startRun(slot:{kind:string;at:string;data?:Data}){
    return this.store.transaction(()=>{
      const active=this.store.db.prepare("SELECT * FROM engine_runs WHERE profile_id=? AND state IN ('running','cost_wait') ORDER BY started_at,id LIMIT 1").get(this.profileId) as Run|undefined;if(active)return active.id;
      const id=digest([this.profileId,slot.kind,slot.at]);
      if(this.store.db.prepare('SELECT id FROM engine_runs WHERE id=?').get(id))return id;
      this.store.db.prepare("INSERT INTO engine_runs VALUES(?,?,?,?,'running',?,NULL,?)").run(id,this.profileId,slot.kind,slot.at,new Date(this.store.now()).toISOString(),JSON.stringify(slot.data??{}));
      const old=this.store.db.prepare("SELECT c.* FROM engine_checkpoints c JOIN engine_runs r ON c.run_id=r.id WHERE r.profile_id=? AND r.state='exhausted' AND c.phase NOT IN ('done','failed','skipped') AND NOT EXISTS(SELECT 1 FROM engine_checkpoints n WHERE json_extract(n.data,'$.carried_from')=c.id)").all(this.profileId) as unknown as (Omit<Checkpoint,'data'>&{data:string})[];
      for(const c of old){this.copyAncestors(c.run_id,id,c.item_key,c.stage);this.enqueueInside(id,c.stage,c.item_key,{...JSON.parse(c.data),carried_from:c.id},c.input_digest,c.attempts);}
      return id;
    });
  }
  enqueue(runId:string,stage:string,itemKey:string,data:Data={},inputDigest=digest(data)){return this.store.transaction(()=>this.enqueueInside(runId,stage,itemKey,data,inputDigest));}
  enqueueInside(runId:string,stage:string,itemKey:string,data:Data,inputDigest:string,attempts=0){
    const handler=this.handlers[stage];if(!handler)throw new Error('unknown_stage');
    const id=digest([runId,stage,itemKey]);
    this.store.db.prepare("INSERT OR IGNORE INTO engine_checkpoints(id,run_id,stage,item_key,phase,attempts,input_digest,version_tag,data) VALUES(?,?,?,?,'pending',?,?,?,?)").run(id,runId,stage,itemKey,attempts,inputDigest,handler.version,JSON.stringify(data));return id;
  }
  private copyAncestors(fromRun:string,toRun:string,itemKey:string,stage:string){
    for(const previous of this.stages.slice(0,this.stages.indexOf(stage))){
      const row=this.store.db.prepare("SELECT id FROM engine_checkpoints WHERE run_id=? AND item_key=? AND stage=? AND phase='done'").get(fromRun,itemKey,previous) as {id:string}|undefined;
      if(!row)continue;const old=this.checkpoint(row.id)!;
      const id=this.enqueueInside(toRun,previous,itemKey,{...old.data,reused_from:old.id},old.input_digest,old.attempts);
      this.store.db.prepare("UPDATE engine_checkpoints SET phase='done',output_ref=?,version_tag=? WHERE id=?").run(old.output_ref,old.version_tag,id);
    }
  }
  resume(runId:string){
    const r=this.run(runId);if(!r||r.profile_id!==this.profileId||r.state==='exhausted'||r.state==='halted')throw new Error('run_not_resumable');return runId;
  }
  run(id:string){return this.store.db.prepare('SELECT * FROM engine_runs WHERE id=?').get(id) as Run|undefined;}
  checkpoint(id:string){const row=this.store.db.prepare('SELECT * FROM engine_checkpoints WHERE id=?').get(id) as unknown as Omit<Checkpoint,'data'>&{data:string}|undefined;return row?{...row,data:JSON.parse(row.data)} as Checkpoint:undefined;}
  private finish(c:Checkpoint,result:StageResult){
    const merged={...c.data,...result.data};
    this.store.db.prepare("UPDATE engine_checkpoints SET phase='done',output_ref=?,data=?,error_code=NULL WHERE id=?").run(result.outputRef??null,JSON.stringify(merged),c.id);release(this.store,c);
    this.store.db.prepare('DELETE FROM engine_failures WHERE id=?').run(c.id);
    const next=result.nextStage===undefined?this.stages[this.stages.indexOf(c.stage)+1]:result.nextStage;
    if(next)this.enqueueInside(c.run_id,next,c.item_key,merged,digest([result.outputRef??c.input_digest,merged]));
  }
  async step(runId:string):Promise<boolean>{
    const run=this.run(runId);if(!run||!['running','cost_wait'].includes(run.state))return false;
    let c:Checkpoint|undefined;
    try{
      const recovered=this.store.transaction(()=>{
        const row=this.store.db.prepare("SELECT id FROM engine_checkpoints WHERE run_id=? AND ((phase IN ('pending','retry_wait','deferred') AND next_at<=?) OR (phase='leased' AND lease_until<=?)) ORDER BY next_at,rowid LIMIT 1").get(runId,this.store.now(),this.store.now()) as {id:string}|undefined;
        if(!row)return false;c=this.checkpoint(row.id)!;
        if(c.phase==='leased'){
          const result=this.handlers[c.stage].recover?.(c);
          if(result){this.finish(c,result);return true;}
        }
        acquire(this.store,c.id,this.owner);return false;
      });
      if(recovered)return true;
      if(!c){
        this.store.transaction(()=>{
          const unfinished=this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND phase IN ('pending','leased','retry_wait','deferred')").get(runId) as {n:number};
          if(!unfinished.n)this.store.db.prepare("UPDATE engine_runs SET state='finished',finished_at=? WHERE id=?").run(new Date(this.store.now()).toISOString(),runId);
          else if(!this.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND phase IN ('pending','leased','retry_wait') LIMIT 1").get(runId))this.store.db.prepare("UPDATE engine_runs SET state='cost_wait' WHERE id=?").run(runId);
        });return false;
      }
      const handler=this.handlers[c.stage];
      this.store.transaction(()=>this.store.db.prepare("UPDATE engine_runs SET state='running' WHERE id=?").run(runId));
      const heartbeat=setInterval(()=>renew(this.store,c!.id,this.owner),60000);
      let result:StageResult;
      try{result=await handler.run(c);}finally{clearInterval(heartbeat);}
      // Faults simulate process death: leave lease/output intact for recovery.
      try{this.options.fault?.(handler.kind==='external'?'after_external_commit':'after_handler');}catch(e){throw Object.assign(new Error('engine_crash'),{cause:e});}
      this.store.transaction(()=>{const committed=handler.kind==='transactional'?handler.commit?.(result,c!):undefined;this.finish(c!,committed??result);});return true;
    }catch(e){
      if(e instanceof Error&&e.message==='engine_crash')throw e;
      if(!c)throw e;
      const ck=c,category=classify(e),code=errorCode(e);
      if(code==='input_unavailable'){
        this.store.transaction(()=>{
          const restart=String(ck.data.restart_stage??'fetch');
          const prior=this.store.db.prepare('SELECT id FROM engine_checkpoints WHERE run_id=? AND stage=? AND item_key=?').get(runId,restart,ck.item_key) as {id:string}|undefined;
          if(!prior)throw new Error('restart_missing');
          for(const stage of this.stages.slice(this.stages.indexOf(restart)+1)){
            this.store.db.prepare('DELETE FROM engine_failures WHERE id IN (SELECT id FROM engine_checkpoints WHERE run_id=? AND stage=? AND item_key=?)').run(runId,stage,ck.item_key);
            this.store.db.prepare('DELETE FROM engine_checkpoints WHERE run_id=? AND stage=? AND item_key=?').run(runId,stage,ck.item_key);
          }
          this.store.db.prepare("UPDATE engine_checkpoints SET phase=CASE WHEN attempts+1>=? THEN 'failed' ELSE 'pending' END,attempts=attempts+1,lease_owner=NULL,lease_until=NULL,error_code='input_unavailable' WHERE id=?").run(this.options.maxAttempts??3,prior.id);
          const failed=this.checkpoint(prior.id)!;if(failed.phase==='failed')this.store.db.prepare('INSERT OR REPLACE INTO engine_failures VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(failed.id,runId,failed.stage,failed.item_key,'input_unavailable',failed.attempts,1,null,this.store.now(),this.store.now(),'{}');
        });return true;
      }
      this.store.transaction(()=>{
        let phase='failed',next=0,attempts=ck.attempts;
        if(category==='day'){phase='deferred';next=midnight(this.store.now());this.store.db.prepare("UPDATE engine_runs SET state='cost_wait' WHERE id=?").run(runId);}
        else if(category==='run'){phase='pending';this.store.db.prepare("UPDATE engine_runs SET state='exhausted' WHERE id=?").run(runId);}
        else if(category==='unsupported')phase='skipped';
        else if(category==='retryable'){
          attempts++;
          if(attempts<(this.options.maxAttempts??3)){phase='retry_wait';next=nextAttemptAt(this.store.now(),attempts,code,{next_at:Number((e as {next_at?:number}).next_at??0)},this.options.rng);}
        }
        const data={...ck.data,...(category==='unsupported'?{unsupported_tool:(e as {tool?:string}).tool??'unknown'}:{})};
        this.store.db.prepare('UPDATE engine_checkpoints SET phase=?,attempts=?,next_at=?,error_code=?,data=? WHERE id=?').run(phase,attempts,next,code,JSON.stringify(data),ck.id);release(this.store,ck);
        if(!['day','run','unsupported'].includes(category))this.store.db.prepare('INSERT INTO engine_failures VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET reason=excluded.reason,attempts=excluded.attempts,retryable=excluded.retryable,next_retry_at=excluded.next_retry_at,last_at=excluded.last_at').run(ck.id,runId,ck.stage,ck.item_key,code,attempts,Number(category==='retryable'),next||null,this.store.now(),this.store.now(),'{}');
        if(HALT_CODES.has(code)){this.options.onHalt?.(ck,code);this.store.db.prepare("UPDATE engine_runs SET state='halted' WHERE id=?").run(runId);}
      });
      return (e instanceof CostCapError&&e.local||!['day','run'].includes(category))&&!HALT_CODES.has(code);
    }
  }
  async runUntilIdle(runId:string){while(await this.step(runId)){}return this.run(runId)!;}
  failures(){return this.store.db.prepare('SELECT id,run_id,stage,item_key,reason,attempts,retryable,next_retry_at,first_at,last_at FROM engine_failures ORDER BY last_at').all();}
  retryFailure(id:string){
    const c=this.checkpoint(id);if(!c||c.phase!=='failed'||this.run(c.run_id)?.profile_id!==this.profileId||HALT_CODES.has(c.error_code??''))throw new Error('failure_not_found');
    // Manual retries are isolated runs and never reset the original ledger.
    const runId=digest([this.profileId,'manual',id,randomUUID()]);
    this.store.transaction(()=>{this.store.db.prepare("INSERT INTO engine_runs VALUES(?,?,'manual',?,'running',?,NULL,?)").run(runId,this.profileId,runId,new Date(this.store.now()).toISOString(),JSON.stringify({parent_run:c.run_id}));this.copyAncestors(c.run_id,runId,c.item_key,c.stage);this.enqueueInside(runId,c.stage,c.item_key,{...c.data,parent_run:c.run_id},c.input_digest,c.attempts);});return runId;
  }
}
