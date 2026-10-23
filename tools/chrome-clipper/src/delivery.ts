import type { Binding, ClipPayload } from '../../../shared/collection-schema';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { privacyFilter } from '../../../crawler/src/privacy-filter';
export type Reservation = {id:string;phase:string;execution_until?:number;submit_until?:number};
export type ClipJob = Binding & {schema_version:1;tab_id:number;phase:'created'|'reserved'|'extracting'|'payload_ready'|'needs_reclick'|'complete'|'expired'|'failed';reservation?:Reservation;payload?:ClipPayload;digest?:string;next_retry_at:number;retry_count?:number;last_error?:string};
export type DeliveryDeps = {
  save:(job:ClipJob)=>Promise<void>;
  call:(path:string,body?:unknown)=>Promise<unknown>;
  extract:(job:ClipJob)=>Promise<unknown>;
  now:()=>number;
  hash:(payload:ClipPayload)=>Promise<string>;
};
export async function createClip(input:Binding,tabId:number,deps:DeliveryDeps) {
  const job:ClipJob={...input,url:canonicalUrl(input.url),tab_id:tabId,schema_version:1,phase:'created',next_retry_at:0};
  await deps.save(job); // No reservation or DOM read before the first durable write.
  return job;
}
export class DeliveryError extends Error {
  constructor(readonly status:number,readonly retryAfterMs=0){super(`intake_${status||'offline'}`);}
}
export async function resumeClip(job:ClipJob,deps:DeliveryDeps) {
  if(['complete','needs_reclick','expired','failed'].includes(job.phase)||job.next_retry_at>deps.now())return;
  try {await deliver(job,deps);} catch(error) {
    if(!(error instanceof DeliveryError))throw error; // Storage failure must never advance durable progress.
    job.retry_count=(job.retry_count??0)+1;
    job.last_error=error.status?`http_${error.status}`:'offline';
    if((error.status>=400&&error.status<500&&![408,429].includes(error.status))||job.retry_count>=8){
      job.phase='failed';job.next_retry_at=0;delete job.payload;delete job.digest;
    }else job.next_retry_at=deps.now()+Math.max(error.retryAfterMs,Math.min(6*3600000,60000*2**(job.retry_count-1)));
    await deps.save(structuredClone(job));
  }
}
async function deliver(job:ClipJob,deps:DeliveryDeps) {
  if(['complete','needs_reclick','expired'].includes(job.phase)||job.next_retry_at>deps.now())return;
  const persist=async()=>deps.save(structuredClone(job));
  const status=await deps.call(`/v1/intake/clips/${job.clip_id}`) as {attempts:Reservation[];receipts:{reservation_id:string}[]};
  const old=status.attempts.find(r=>r.id===job.reservation?.id) ?? status.attempts.find(r=>(r as Reservation & {attempt_id?:string}).attempt_id===job.attempt_id);
  if(old&&status.receipts.some(r=>r.reservation_id===old.id)){delete job.payload;delete job.digest;job.phase='complete';job.next_retry_at=0;delete job.last_error;await persist();return;}
  if(old)job.reservation=old;
  if(!job.reservation){
    const {clip_id,attempt_id,url,brand,collection_method,operation,policy_version}=job;
    job.reservation=await deps.call('/v1/intake/reservations',{clip_id,attempt_id,url,brand,collection_method,operation,policy_version}) as Reservation;
    job.phase='reserved';await persist();
  }
  if(['expired','cancelled'].includes(job.reservation.phase)){job.phase='expired';await persist();return;}
  if(!job.payload){
    // A restarted worker may not know whether DOM extraction ran. Never repeat a spent attempt.
    if(job.reservation.phase==='started'||job.phase==='extracting'){job.phase='needs_reclick';await persist();return;}
    job.reservation=await deps.call(`/v1/intake/reservations/${job.reservation.id}/start`,{}) as Reservation;
    job.phase='extracting';await persist();
    if((job.reservation.execution_until??0)<=deps.now()){job.phase='needs_reclick';await persist();return;}
    let payload:ClipPayload;
    try{payload=privacyFilter(await deps.extract(job));}catch{job.phase='needs_reclick';await persist();return;}
    job.payload=payload;job.digest=await deps.hash(payload);job.phase='payload_ready';await persist();
  }
  if((job.reservation.submit_until??0)<deps.now()){delete job.payload;delete job.digest;job.phase='expired';await persist();return;}
  await deps.call('/v1/intake',{reservation_id:job.reservation.id,payload:job.payload});
  delete job.payload;delete job.digest;job.phase='complete';job.next_retry_at=0;delete job.last_error;await persist();
}
