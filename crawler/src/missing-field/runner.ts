import { randomUUID } from 'node:crypto';
import { JobEngine, type StageHandler } from '../../engine';
import { digest } from '../dedup';
import { requireThat, type CollectorStore } from '../store';
import { enumerateSlots } from './targets';
import { evaluateSlot, inputDigest } from './evaluate';
import { MissingFieldStore } from './store';
import { EXPLORER_VERSION, type Slot, type Assessment } from './types';
import { metrics } from './metrics';
import type { DiscoveryConfig } from '../source-discovery/config';
export const EXPLORER_RUN_ID='agamajung-missing-field-explorer';
type Baseline={slots:string[];missing:string[];review_missing:string[]};
export class MissingFieldRunner {
  readonly engine:JobEngine;
  readonly storage:MissingFieldStore;
  constructor(readonly store:CollectorStore,options:{discovery?:DiscoveryConfig;fault?:(point:string)=>void}={}){
    this.storage=new MissingFieldStore(store,options.discovery);
    const reconcile:StageHandler={kind:'transactional',version:EXPLORER_VERSION,run:async()=>({}),commit:(_r,c)=>{
      const batch=store.db.prepare("SELECT group_id FROM evidence_policy_jobs WHERE state='pending' ORDER BY group_id LIMIT 50").all();
      for(const row of batch)store.reconcileConflictInside(String(row.group_id));
      if(batch.length===50)this.engine.enqueueInside(c.run_id,'reconcile',digest(batch),{},digest(batch));
      return {nextStage:null};
    }};
    const evaluate:StageHandler={kind:'transactional',version:EXPLORER_VERSION,run:async c=>({data:{assessment:evaluateSlot(store,c.data.slot as Slot)}}),commit:(result,c)=>{
      const slots=enumerateSlots(store),slot=slots.find(s=>s.id===(c.data.slot as Slot).id),a=result.data!.assessment as Assessment;
      if(!slot){this.storage.retireObsoleteInside(slots);return {outputRef:`retired:${(c.data.slot as Slot).id}`,nextStage:null};}
      // Re-evaluate inside BEGIN IMMEDIATE if serve changed evidence after the read.
      const current=inputDigest(store,slot)===a.input_digest?a:evaluateSlot(store,slot);
      this.storage.installInside(slot,current);return {outputRef:current.id,nextStage:null};
    }};
    const aggregate:StageHandler={kind:'transactional',version:EXPLORER_VERSION,run:async()=>({}),commit:(_r,c)=>{
      const baseline=this.baseline(c.run_id),slots=enumerateSlots(store),assessments=slots.map(s=>evaluateSlot(store,s));
      // One consistent transaction, including freshness and all simultaneous review/withdraw changes.
      this.storage.retireObsoleteInside(slots);
      for(let i=0;i<slots.length;i++)this.storage.installInside(slots[i],assessments[i]);
      const state=digest(assessments.map(a=>[a.slot_id,a.input_digest])),id=digest([c.run_id,state]);
      const previous=store.db.prepare('SELECT id FROM missing_field_metric_snapshots WHERE id=?').get(id);
      if(!previous){const data={run_id:c.run_id,version:EXPLORER_VERSION,measured_at:new Date(store.now()).toISOString(),state_digest:state,baseline,...metrics(slots,assessments,baseline)};this.storage.immutable('missing_field_metric_snapshots',id,data,{run_id:c.run_id,measured_at:data.measured_at});}
      return {outputRef:id,nextStage:null};
    }};
    this.engine=new JobEngine(store,EXPLORER_RUN_ID,['reconcile','evaluate','aggregate'],{reconcile,evaluate,aggregate},{fault:options.fault,maxAttempts:3});
  }
  preview(){return this.store.readSnapshot(()=>{const slots=enumerateSlots(this.store),assessments=slots.map(s=>evaluateSlot(this.store,s));return {dry_run:true,version:EXPLORER_VERSION,slots:slots.length,network_calls:0,model_calls:0,...metrics(slots,assessments,{slots:slots.map(s=>s.id),missing:assessments.filter(a=>!a.fulfilled).map(a=>a.slot_id),review_missing:assessments.filter(a=>!a.reviewed).map(a=>a.slot_id)})};});}
  start(){
    const active=this.store.db.prepare("SELECT id FROM engine_runs WHERE profile_id=? AND state IN ('running','cost_wait') ORDER BY started_at,id LIMIT 1").get(EXPLORER_RUN_ID) as {id:string}|undefined;if(active)return active.id;
    // Freeze the baseline and enqueue its complete input manifest atomically.
    return this.store.transaction(()=>{
      const slots=enumerateSlots(this.store),baseline={slots:slots.map(s=>s.id),missing:slots.filter(s=>!evaluateSlot(this.store,s).fulfilled).map(s=>s.id),review_missing:slots.filter(s=>!evaluateSlot(this.store,s).reviewed).map(s=>s.id)},id=digest([EXPLORER_RUN_ID,randomUUID()]);
      this.store.db.prepare("INSERT INTO engine_runs VALUES(?,?,'explore',?,'running',?,NULL,?)").run(id,EXPLORER_RUN_ID,id,new Date(this.store.now()).toISOString(),JSON.stringify({version:EXPLORER_VERSION,baseline,slots}));
      this.engine.enqueueInside(id,'reconcile','policy',{},digest(EXPLORER_VERSION));
      for(const slot of slots)this.engine.enqueueInside(id,'evaluate',slot.id,{slot},digest(slot));
      this.engine.enqueueInside(id,'aggregate','metrics',{},digest(baseline));return id;
    });
  }
  resume(id:string){
    const run=this.engine.run(id);requireThat(run?.profile_id===EXPLORER_RUN_ID,'run_not_resumable');this.engine.resume(id);
    this.store.transaction(()=>{
      const slots=enumerateSlots(this.store),current=new Map(slots.map(s=>[s.id,s]));
      this.storage.retireObsoleteInside(slots);
      this.store.db.prepare("UPDATE engine_runs SET state='running',finished_at=NULL WHERE id=?").run(id);
      this.store.db.prepare("UPDATE engine_checkpoints SET phase='pending',output_ref=NULL WHERE run_id=? AND stage='aggregate' AND phase='done'").run(id);
      const rows=this.store.db.prepare("SELECT id,data,output_ref FROM engine_checkpoints WHERE run_id=? AND stage='evaluate' AND phase='done'").all(id);
      for(const row of rows){const slot=current.get((JSON.parse(String(row.data)).slot as Slot).id);if(slot&&evaluateSlot(this.store,slot).id!==row.output_ref)this.store.db.prepare("UPDATE engine_checkpoints SET phase='pending',output_ref=NULL WHERE id=?").run(row.id);}
    });return id;
  }
  retryFailure(checkpoint:string){const id=this.engine.retryFailure(checkpoint);this.engine.enqueue(id,'aggregate','metrics',{},digest(this.baseline(id)));return id;}
  baseline(id:string):Baseline {
    let run=this.engine.run(id);requireThat(run?.profile_id===EXPLORER_RUN_ID,'explorer_run_required');
    const seen=new Set<string>();
    while(run){requireThat(!seen.has(run.id),'run_lineage_cycle');seen.add(run.id);const data=JSON.parse(run.data);if(data.baseline)return data.baseline;if(!data.parent_run)break;run=this.engine.run(data.parent_run);}
    throw new Error('baseline_missing');
  }
  async run(id:string){return this.engine.runUntilIdle(id);}
  report(id:string){return {run_id:id,state:this.engine.run(id)?.state,slots:enumerateSlots(this.store).length,network_calls:0,model_calls:0};}
  currentMetrics(id:string){return this.store.readSnapshot(()=>{
    const baseline=this.baseline(id),slots=enumerateSlots(this.store),assessments=slots.map(s=>evaluateSlot(this.store,s));
    return {run_id:id,as_of:new Date(this.store.asOf).toISOString(),...metrics(slots,assessments,baseline)};
  });}
  snapshots(id:string){return this.store.readSnapshot(()=>{
    this.baseline(id);
    const state=digest(enumerateSlots(this.store).map(s=>[s.id,inputDigest(this.store,s)]));
    return this.store.db.prepare('SELECT data FROM missing_field_metric_snapshots WHERE run_id=? ORDER BY measured_at,id').all(id).map(r=>{const snapshot=JSON.parse(String(r.data));return {...snapshot,current:snapshot.state_digest===state};});
  });}
}
