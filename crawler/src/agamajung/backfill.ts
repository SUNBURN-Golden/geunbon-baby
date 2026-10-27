import type { CollectionRecord } from '../../../shared/collection-schema';
import { SqliteStorage } from '../../engine/storage';
import { CollectorStore, type Evidence } from '../store';
import { digest, stable } from '../dedup';
import { conditionsKey } from './subject';
export function backfillEngine(store:CollectorStore){
  return store.transaction(()=>{
    const run=digest(['agamajung','legacy@1']),storage=new SqliteStorage(store);
    // Legacy observation times are preserved, including the absence of a prior observation.
    const records=store.list<CollectionRecord>('collection_records'),evidence=store.list<Evidence>('evidence_assertions');
    const time=records.map(r=>r.collected_at).sort()[0]??new Date(store.now()).toISOString();
    store.db.prepare("INSERT OR IGNORE INTO engine_runs VALUES(?,'agamajung','legacy','legacy@1','finished',?,?,?)").run(run,time,time,'{}');
    const before=store.db.prepare('SELECT (SELECT count(*) FROM engine_captures) captures,(SELECT count(*) FROM engine_extracted) extracted').get() as {captures:number;extracted:number};
    const byNew=new Map<string,Evidence[]>();for(const e of evidence)if(e.superseded_by){const bucket=byNew.get(e.superseded_by)??[];bucket.push(e);byNew.set(e.superseded_by,bucket);}
    const window=(e:Evidence,seen=new Set<string>()):string|null=>{
      if(seen.has(e.id))return null;seen.add(e.id);
      const prior=(byNew.get(e.id)??[]).filter(p=>p.record_id===e.record_id&&p.field===e.field&&conditionsKey(p)===conditionsKey(e)&&p.observed_at<e.observed_at).sort((a,b)=>b.observed_at.localeCompare(a.observed_at)||a.id.localeCompare(b.id))[0];
      return prior?(stable(prior.value)===stable(e.value)?window(prior,seen):prior.observed_at):null;
    };
    for(const r of records){
      const capture=digest([run,r.source,r.url,1]);
      storage.capture({id:capture,run_id:run,source_id:r.source,url_norm:r.url,fetch_seq:1,fetched_at:r.last_checked_at??r.collected_at,status:'legacy',content_hash:null,content_type:null,byte_length:null,etag:null,last_modified:null,raw_ref:null,prev_capture_id:null,data:{legacy_record:r.id}});
      const slots=new Map<string,number>();
      for(const e of evidence.filter(e=>e.record_id===r.id).sort((a,b)=>a.observed_at.localeCompare(b.observed_at)||a.id.localeCompare(b.id))){
        const conditions=conditionsKey(e),key=stable([e.field,conditions]),slot=slots.get(key)??0;slots.set(key,slot+1);
        const subject=r.target_model_id??`doc:${r.url}`,extractor='legacy-store@1';
        storage.extracted({id:digest([capture,extractor,subject,e.field,conditions,slot]),capture_id:capture,subject_ref:subject,field:e.field,conditions_key:conditions,claim_slot:slot,source_url:e.url,locator:e.locator||'legacy:locator_missing',quote:e.quote?.slice(0,300)||null,collected_at:e.observed_at,effective_from:e.observed_at,effective_from_basis:'observed',change_window_start:window(e),fact_status:'source_claim',extractor,data:{assertion:{field:e.field,value:e.value,conditions:e.conditions??{},quote:e.quote,locator:e.locator},legacy_id:e.id,legacy_level:e.level}});
      }
    }
    const after=store.db.prepare('SELECT (SELECT count(*) FROM engine_captures) captures,(SELECT count(*) FROM engine_extracted) extracted').get() as typeof before;
    return {captures:after.captures-before.captures,extracted:after.extracted-before.extracted,total:records.length};
  });
}
