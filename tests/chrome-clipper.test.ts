import { expect, test } from 'vitest';
import { createClip, resumeClip, type ClipJob, type DeliveryDeps, DeliveryError } from '../tools/chrome-clipper/src/delivery';
import { fixture, binding, price } from './helpers/collector';
import type { Binding } from '../shared/collection-schema';
// Only JSON survives between engines. Neither closures nor in-flight Promises are reused.
function harness(){
 const f=fixture();const disk:Record<string,ClipJob>={};let fail='',extractions=0;
 function engine():DeliveryDeps{return {now:f.store.now,save:async job=>{if(fail===`save:${job.phase}`){fail='';throw new Error('disk_failed');}disk[job.clip_id]=JSON.parse(JSON.stringify(job));},hash:async p=>JSON.stringify(p),extract:async()=>{extractions++;if(fail==='extract'){fail='';throw new Error('tab_closed_or_permission_revoked');}return price();},call:async(path,body)=>{
  if(fail===`before:${path}`){fail='';throw new Error('offline_before_send');}
  let result:unknown;
  if(path.includes('/clips/'))result=f.store.clip('extension',path.split('/').at(-1)!);
  else if(path==='/v1/intake/reservations')result=f.store.reserve('extension',body as Binding);
  else if(path.endsWith('/start'))result=f.store.start('extension',path.split('/').at(-2)!);
  else {const b=body as {reservation_id:string;payload:unknown};result=f.store.submit('extension',b.reservation_id,b.payload);}
  if(fail===path){fail='';throw new Error('response_lost');}return result;
 }};}
 return {f,engine,setFail:(v:string)=>{fail=v;},disk:()=>JSON.parse(JSON.stringify(disk)) as Record<string,ClipJob>,reload:(id:string)=>JSON.parse(JSON.stringify(disk[id])) as ClipJob,get extractions(){return extractions;}};
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
