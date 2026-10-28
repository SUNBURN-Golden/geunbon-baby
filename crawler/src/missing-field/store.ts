import type { CollectorStore } from '../store';
import { requireThat } from '../store';
import { digest, stable } from '../dedup';
import { feedbackQueries } from '../source-discovery/queries';
import { SourceCandidateStore, discoveryConditions } from '../source-discovery/store';
import { loadDiscoveryConfig, type DiscoveryConfig } from '../source-discovery/config';
import { providerApproved } from '../source-discovery/providers/types';
import { loadProfile } from '../agamajung/profile';
import { explicitSubjects } from '../source-discovery/entities';
import { evaluateSlot, inputDigest, parsedFor } from './evaluate';
import { enumerateSlots } from './targets';
import type { Action, ActionKind, Assessment, Cause, Slot } from './types';
const actionKinds:Record<Cause,ActionKind>={unextracted:'improve_extractor',not_in_source:'reverse_search',inaccessible:'hold_access',conflict:'review'};
// All mutations here run in the caller's existing JobEngine transaction.
export class MissingFieldStore {
  constructor(readonly store:CollectorStore,readonly discovery:DiscoveryConfig=loadDiscoveryConfig()){}
  immutable(table:string,id:string,data:unknown,columns:Record<string,string>={}){
    requireThat(['missing_field_assessments','missing_field_actions','missing_field_action_links','missing_field_metric_snapshots'].includes(table),'explorer_table');
    const value=stable(data),old=this.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|undefined;
    if(old){requireThat(old.data===value,'immutable_id_conflict');return;}
    const row={id,...columns,data:value},keys=Object.keys(row);
    this.store.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  }
  retireObsoleteInside(slots:Slot[]){
    const current=new Set(slots.map(s=>s.id));
    for(const row of this.store.db.prepare('SELECT id,data FROM missing_field_slots').all()){
      if(current.has(String(row.id)))continue;
      const previous=JSON.parse(String(row.data)) as Slot;
      const replacements=slots.filter(s=>s.field===previous.field&&s.record_ids.some(id=>previous.record_ids.includes(id)));
      this.store.db.prepare('UPDATE missing_field_slots SET stale=1 WHERE id=?').run(row.id);
      const event=digest(['missing_target_relinked',previous,replacements]);
      if(!this.store.get('review_events',event))this.store.put('review_events',event,{decision:'missing_target_relinked',slot_id:previous.id,previous,current:replacements,retired:true,at:new Date(this.store.now()).toISOString()});
    }
  }
  installInside(slot:Slot,a:Assessment){
    requireThat(inputDigest(this.store,slot)===a.input_digest,'assessment_changed');
    const previous=this.store.db.prepare('SELECT data FROM missing_field_slots WHERE id=?').get(slot.id) as {data:string}|undefined;
    if(previous&&previous.data!==stable(slot))this.store.put('review_events',digest(['missing_target_relinked',slot.id,previous.data,slot]),{decision:'missing_target_relinked',slot_id:slot.id,previous:JSON.parse(previous.data),current:slot,at:new Date(this.store.now()).toISOString()});
    this.store.db.prepare('INSERT INTO missing_field_slots(id,target_ref,field,conditions_key,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(slot.id,slot.target_ref,slot.field,stable(slot.conditions),stable(slot));
    this.immutable('missing_field_assessments',a.id,a,{slot_id:slot.id,input_digest:a.input_digest,assessed_at:a.assessed_at});
    this.store.db.prepare('UPDATE missing_field_slots SET assessment_id=?,stale=0 WHERE id=?').run(a.id,slot.id);
    for(const d of a.fulfilled?[]:a.diagnoses){
      if(!d.cause)continue;
      const kind=actionKinds[d.cause],id=digest([a.id,kind,d]),action:Action={id,slot_id:slot.id,assessment_id:a.id,kind,diagnosis:d};
      this.immutable('missing_field_actions',id,action,{slot_id:slot.id,assessment_id:a.id,kind});
      if(d.capture_id){
        this.linkInside(id,'capture',d.capture_id,{source_id:d.source_id});
        const checkpoints=this.store.db.prepare("SELECT id FROM engine_checkpoints WHERE stage='extract' AND json_extract(data,'$.capture_id')=?").all(d.capture_id);
        for(const checkpoint of checkpoints)this.linkInside(id,'checkpoint',String(checkpoint.id),{stage:'extract'});
      }
      if(kind==='review')for(const ref of d.refs??[])this.linkInside(id,'review',ref,{group_scope:true});
      if(kind==='reverse_search')this.reverseInside(slot,action);
    }
  }
  linkInside(action:string,kind:string,ref:string,data:unknown){
    this.immutable('missing_field_action_links',digest([action,kind,ref,data]),data,{action_id:action,kind,ref});
  }
  private reverseInside(slot:Slot,action:Action){
    const cap=action.diagnosis.capture_id?this.store.db.prepare('SELECT * FROM engine_captures WHERE id=?').get(action.diagnosis.capture_id):undefined;
    const parsed=cap?parsedFor(this.store,cap as Parameters<typeof parsedFor>[1]):undefined;
    const subjects=parsed?explicitSubjects(parsed.text,slot.target_ref).map(s=>({...s,conditions:discoveryConditions({...s.conditions,...(s.option?{option:s.option}:{}),...(s.seller?{seller:s.seller}:{})})})):[];
    const slotConditions=Object.fromEntries(Object.entries(slot.conditions).filter(([,v])=>!!v.trim()));
    // Only an explicitly labelled model number can drive a product reverse search.
    const eligible=subjects.filter(s=>s.model_number&&Object.entries(s.conditions).every(([k,v])=>!slotConditions[k]||slotConditions[k]===v));
    const providers=this.discovery.providers.filter(providerApproved);
    let reason=!this.discovery.enabled||!providers.length?'provider_disabled':eligible.length!==1?'model_number_missing':slot.field==='certifications'&&(slot.conditions.market??eligible[0]?.conditions.market)!=='KR'?'kr_applicability_missing':null;
    const capData=cap?JSON.parse(String(cap.data)):{};
    const depth=capData.discovery_depth;
    if(!Number.isSafeInteger(depth)||depth<0||depth+1>=this.discovery.max_depth)reason='depth_limit';
    if(reason){this.linkInside(action.id,'deferred',reason,{reason});return;}
    const conditions={...eligible[0].conditions,...slotConditions};
    const subject={...eligible[0],subject_ref:`entity:${digest(slot.target_ref)}`,conditions,release_year:conditions.release_year??eligible[0].release_year,option:conditions.option,seller:conditions.seller};
    const profile=loadProfile(),candidateStore=new SourceCandidateStore(this.store,this.discovery);
    for(const provider of providers){
      const queries=feedbackQueries(provider.id,subject,profile).filter(q=>q.kind==='missing_field'&&q.conditions.scheme===(slot.conditions.scheme??undefined));
      // Match exactly the field's shared generated query, retaining all explicit conditions.
      const name=profile.required_fields.find(f=>f.field===slot.field)!.ko;
      const q=queries.find(q=>q.text.includes(slot.field==='certifications'?'KC 인증번호':name));
      if(!q){this.linkInside(action.id,'deferred','query_unavailable',{reason:'query_unavailable'});continue;}
      candidateStore.queryInside(provider.id,q);
      this.linkInside(action.id,'source_query',q.id,{provider_id:provider.id,depth:depth+1,origin_capture:action.diagnosis.capture_id});
    }
  }
  current(id?:string){return this.store.readSnapshot(()=>{
    const current=new Map(enumerateSlots(this.store).map(s=>[s.id,s]));
    const rows=(id?this.store.db.prepare('SELECT * FROM missing_field_slots WHERE id=?').all(id):this.store.db.prepare('SELECT * FROM missing_field_slots ORDER BY id').all()) as {id:string;assessment_id:string|null;stale:number;data:string}[];
    const persisted=new Map(rows.map(r=>[r.id,r]));
    const manifest=id?rows.map(r=>JSON.parse(r.data) as Slot):[...current.values()];
    return manifest.map(live=>{
      const r=persisted.get(live.id)??{id:live.id,assessment_id:null,stale:1,data:stable(live)};
      const slot=JSON.parse(r.data) as Slot,a=r.assessment_id?this.store.db.prepare('SELECT data FROM missing_field_assessments WHERE id=?').get(r.assessment_id) as {data:string}|undefined:undefined;
      const assessment=a?JSON.parse(a.data) as Assessment:undefined;
      const retired=!current.has(r.id),stale=retired||stable(slot)!==stable(current.get(r.id))||!!r.stale||!assessment||inputDigest(this.store,slot)!==assessment.input_digest;
      return {slot,retired,stale,assessment:retired?{...assessment,state:'assessment_pending',fulfilled:false,reviewed:false,value:null}:stale?evaluateSlot(this.store,current.get(r.id)!):assessment};
    });
  });}
  actions(){return this.store.db.prepare('SELECT id,data FROM missing_field_actions ORDER BY id LIMIT 500').all().map(r=>{const action=JSON.parse(String(r.data)) as Action;return {...action,links:(this.store.db.prepare('SELECT kind,ref,data FROM missing_field_action_links WHERE action_id=? ORDER BY id').all(String(r.id)) as {kind:string;ref:string;data:string}[]).map(l=>({kind:l.kind,ref:l.ref,data:JSON.parse(l.data) as unknown}))};});}
}
