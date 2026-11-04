import { expect, test } from 'vitest';
import { createClip, resumeClip, type ClipJob, type DeliveryDeps, DeliveryError } from '../tools/chrome-clipper/src/delivery';
import { fixture, binding } from './helpers/collector';
import { extractFacts } from '../shared/fact-extract';
import { clipperDom } from './helpers/clipper-dom';
import type { Binding } from '../shared/collection-schema';
// Only JSON survives between engines. Neither closures nor in-flight Promises are reused.
function harness(url='https://gear.example.org/model'){
 const f=fixture(),dom=clipperDom(url);const disk:Record<string,ClipJob>={};let fail='',extractions=0,submissions=0;
 function engine():DeliveryDeps{return {now:f.store.now,save:async job=>{if(fail===`save:${job.phase}`){fail='';throw new Error('disk_failed');}disk[job.clip_id]=JSON.parse(JSON.stringify(job));},hash:async p=>JSON.stringify(p),extract:async job=>{extractions++;if(fail==='extract'){fail='';throw new Error('tab_closed_or_permission_revoked');}const region=dom.run(['main',false,job.url]);return {title:region.title,document_origin:region.documentOrigin,assertions:extractFacts(region.text,region.locator)};},call:async(path,body)=>{
  if(fail===`before:${path}`){fail='';throw new Error('offline_before_send');}
  let result:unknown;
  if(path.includes('/clips/'))result=f.store.clip('extension',path.split('/').at(-1)!);
  else if(path==='/v1/intake/reservations')result=f.store.reserve('extension',body as Binding);
  else if(path.endsWith('/start'))result=f.store.start('extension',path.split('/').at(-2)!);
  else {submissions++;const b=body as {reservation_id:string;payload:unknown};result=f.store.submit('extension',b.reservation_id,b.payload);}
  if(fail===path){fail='';throw new Error('response_lost');}return result;
 }};}
 return {f,dom,engine,get submissions(){return submissions;},setFail:(v:string)=>{fail=v;},disk:()=>JSON.parse(JSON.stringify(disk)) as Record<string,ClipJob>,reload:(id:string)=>JSON.parse(JSON.stringify(disk[id])) as ClipJob,get extractions(){return extractions;}};
}
test.each(['reservation_response','start_response','payload_ready','ack_response','ack_storage'])('new worker recovers %s from JSON storage and actual SQLite',async point=>{
 const h=harness();try{
  const job=await createClip(binding(),1,h.engine());
  const failure=point==='reservation_response'?'/v1/intake/reservations':point==='start_response'?`/v1/intake/reservations/${h.f.store.reserve('extension',job).id}/start`:point==='payload_ready'?'before:/v1/intake':point==='ack_response'?'/v1/intake':'save:complete';
  h.setFail(failure);await expect(resumeClip(job,h.engine())).rejects.toThrow();h.f.reopen();const resumed=h.reload(job.clip_id);await resumeClip(resumed,h.engine());
  if(point==='start_response'){expect(h.reload(job.clip_id).phase).toBe('needs_reclick');expect(h.extractions).toBe(0);}else{expect(h.reload(job.clip_id).phase).toBe('complete');expect(h.extractions).toBe(1);expect(h.f.store.list('intake_receipts')).toHaveLength(1);expect(h.reload(job.clip_id).payload).toBeUndefined();}
 }finally{h.f.close();}
});
test('payload storage failure cannot be claimed as recovered; disappeared tab requires a new click and attempt',async()=>{
 const h=harness();try{
  const job=await createClip(binding(),1,h.engine());h.setFail('save:payload_ready');await expect(resumeClip(job,h.engine())).rejects.toThrow('disk_failed');await resumeClip(h.reload(job.clip_id),h.engine());expect(h.reload(job.clip_id).phase).toBe('needs_reclick');expect(h.f.store.list('intake_receipts')).toHaveLength(0);
  const retry=await createClip(binding(),2,h.engine());h.setFail('extract');await resumeClip(retry,h.engine());expect(h.reload(retry.clip_id).phase).toBe('needs_reclick');
 }finally{h.f.close();}
});
test('initial storage failure never reserves or reads the document',async()=>{
 const h=harness();try{h.setFail('save:created');await expect(createClip(binding(),1,h.engine())).rejects.toThrow();expect(h.f.store.list('intake_reservations')).toHaveLength(0);expect(h.extractions).toBe(0);}finally{h.f.close();}
});

test.each([403,409,429,500,0])('delivery status %s persists backoff or visible terminal failure across restart',async status=>{
 const h=harness();try{
  const job=await createClip(binding(),1,h.engine());let calls=0;
  const broken=()=>({...h.engine(),call:async(path:string,body?:unknown)=>{calls++;if(path==='/v1/intake/reservations')throw new DeliveryError(status,120000);return h.engine().call(path,body);}});
  await resumeClip(job,broken());const saved=h.reload(job.clip_id);expect(saved.last_error).toBe(status?`http_${status}`:'offline');expect(h.extractions).toBe(0);
  const before=calls;await resumeClip(saved,broken());expect(calls).toBe(before);
  if(status===403||status===409){expect(saved.phase).toBe('failed');h.f.advance(86400000);await resumeClip(saved,broken());expect(calls).toBe(before);}
  else {expect(saved.next_retry_at).toBe(h.f.store.now()+120000);h.f.reopen();h.f.advance(120000);await resumeClip(h.reload(job.clip_id),h.engine());expect(h.reload(job.clip_id).phase).toBe('complete');}
 }finally{h.f.close();}
});

test('repeated transient failures stop after a bounded number of attempts',async()=>{
 const h=harness();try{
  const job=await createClip(binding(),1,h.engine());
  for(let i=0;i<8;i++){const saved=h.reload(job.clip_id);h.f.advance(Math.max(0,saved.next_retry_at-h.f.store.now()));await resumeClip(saved,{...h.engine(),call:async()=>{throw new DeliveryError(500);}});}
  expect(h.reload(job.clip_id)).toMatchObject({phase:'failed',retry_count:8,last_error:'http_500'});
 }finally{h.f.close();}
});

const product='https://gear.example.org/product';
test.each([
 ['?id=A','?id=B',false],['?id=A','',false],['','?id=B',false],
 ['?id=A&page=1','?page=1&id=A',true],
 ['?id=A&utm_source=old','?fbclid=new&id=A#details',true],
 ['?id=A','/other?id=A',false],
])('delivery binds the reserved identity %s → %s',async(reserved,current,same)=>{
 const h=harness(product+reserved);try{
  const job=await createClip(binding(product+reserved),1,h.engine());
  h.dom.navigate(current.startsWith('/')?'https://gear.example.org'+current:product+current);
  await resumeClip(job,h.engine());
  expect(h.reload(job.clip_id).url).toBe(job.url);
  if(same){expect(h.reload(job.clip_id).phase).toBe('complete');expect(h.submissions).toBe(1);expect(h.f.store.list('intake_receipts')).toHaveLength(1);}
  else {
   expect(h.reload(job.clip_id)).toMatchObject({phase:'needs_reclick',url:job.url});expect(h.reload(job.clip_id).payload).toBeUndefined();
   expect(h.dom.reads).not.toHaveBeenCalled();expect(h.submissions).toBe(0);expect(h.f.store.list('evidence_assertions')).toHaveLength(0);expect(h.f.store.list('intake_receipts')).toHaveLength(0);
   // A discovery row may exist, but no extracted title or content can be attached.
   const record=h.f.store.recordByUrl(job.url);expect(record?.title).toBeNull();expect(record?.extracted_facts).toEqual({});expect(record?.evidence_locator).toEqual([]);expect(record?.last_checked_at).toBeNull();
   h.f.reopen();await resumeClip(h.reload(job.clip_id),h.engine());
   expect(h.reload(job.clip_id).phase).toBe('needs_reclick');expect(h.extractions).toBe(1);expect(h.submissions).toBe(0);expect(h.f.store.list('intake_reservations')).toHaveLength(1);
  }
 }finally{h.f.close();}
});

test('restart after reservation rejects B without reading it; a fresh click reserves and submits B',async()=>{
 const a=product+'?id=A',b=product+'?id=B',h=harness(a);try{
  const job=await createClip(binding(a),1,h.engine());h.setFail('save:reserved');
  await expect(resumeClip(job,h.engine())).rejects.toThrow('disk_failed');
  h.dom.navigate(b,'모델: ProductB');h.f.reopen();
  await resumeClip(h.reload(job.clip_id),h.engine());
  expect(h.reload(job.clip_id)).toMatchObject({url:a,phase:'needs_reclick'});expect(h.dom.reads).not.toHaveBeenCalled();expect(h.submissions).toBe(0);
  const fresh=await createClip(binding(b),1,h.engine());await resumeClip(fresh,h.engine());
  expect(fresh.attempt_id).not.toBe(job.attempt_id);expect(h.reload(fresh.clip_id)).toMatchObject({url:b,phase:'complete'});
  expect(h.f.store.list('intake_reservations')).toHaveLength(2);expect(h.f.store.list('intake_receipts')).toHaveLength(1);
  expect(h.f.store.list<{id:string;spent:number;held:number}>('daily_budgets').find(b=>b.id.endsWith(':new_body'))).toMatchObject({spent:2,held:0});
  const records=h.f.store.list<{url:string;title?:string}>('collection_records');
  expect(records.find(r=>r.url===a)?.title).toBeNull();
  expect(h.f.store.recordByUrl(b)?.title).toBe('Product');
  const evidence=h.f.store.list<{record_id:string;value:unknown}>('evidence_assertions');
  expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({record_id:h.f.store.recordByUrl(b)?.id,value:'ProductB'});
 }finally{h.f.close();}
});

test('restart after extraction starts but before payload persistence never reads the new document',async()=>{
 const h=harness(product+'?id=A');try{
  const job=await createClip(binding(product+'?id=A'),1,h.engine());h.setFail('save:payload_ready');
  await expect(resumeClip(job,h.engine())).rejects.toThrow('disk_failed');
  h.dom.reads.mockClear();h.dom.navigate(product+'?id=B');h.f.reopen();
  await resumeClip(h.reload(job.clip_id),h.engine());
  expect(h.reload(job.clip_id).phase).toBe('needs_reclick');expect(h.dom.reads).not.toHaveBeenCalled();expect(h.extractions).toBe(1);expect(h.submissions).toBe(0);
  expect(h.f.store.list('evidence_assertions')).toHaveLength(0);expect(h.f.store.list('intake_receipts')).toHaveLength(0);
 }finally{h.f.close();}
});

test.each(['before:/v1/intake','/v1/intake','save:complete'])('persisted A payload recovers after navigation and %s without reading B',async failure=>{
 const a=product+'?id=A',h=harness(a);try{
  const job=await createClip(binding(a),1,h.engine());h.setFail(failure);
  await expect(resumeClip(job,h.engine())).rejects.toThrow();
  h.dom.reads.mockClear();h.dom.navigate(product+'?id=B','모델: ProductB');h.f.reopen();
  await resumeClip(h.reload(job.clip_id),h.engine());await resumeClip(h.reload(job.clip_id),h.engine());
  expect(h.reload(job.clip_id)).toMatchObject({phase:'complete',url:a});expect(h.extractions).toBe(1);expect(h.dom.reads).not.toHaveBeenCalled();
  expect(h.f.store.list('intake_receipts')).toHaveLength(1);expect(h.f.store.list('evidence_assertions')).toHaveLength(1);expect(h.f.store.recordByUrl(product+'?id=B')).toBeUndefined();
 }finally{h.f.close();}
});
