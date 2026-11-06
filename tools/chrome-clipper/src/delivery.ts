import type { Binding, ClipPayload } from '../../../shared/collection-schema';
import { canonicalUrl, URL_IDENTITY_VERSION } from '../../../shared/privacy-rules';
import { privacyFilter } from '../../../crawler/src/privacy-filter';
export type Reservation = Binding & {id:string;client:string;record_id:string;phase:string;execution_until?:number;submit_until?:number};
type Receipt={id:string;reservation_id:string;record_id:string;digest:string};
export type ClipJob = Binding & {client:string;schema_version:1;tab_id:number;phase:'created'|'reserved'|'extracting'|'payload_ready'|'needs_reclick'|'complete'|'expired'|'failed';reservation?:Reservation;payload?:ClipPayload;digest?:string;digest_version?:'stable@1';next_retry_at:number;retry_count?:number;last_error?:string};
export type DeliveryDeps = {
  client:string;
  save:(job:ClipJob)=>Promise<void>;
  call:(path:string,body?:unknown)=>Promise<unknown>;
  checkIdentity:(job:ClipJob)=>Promise<void>;
  extract:(job:ClipJob)=>Promise<unknown>;
  now:()=>number;
  hash:(payload:ClipPayload,format?:'legacy')=>Promise<string>;
};
const terminalCodes=new Set(['unsafe_url','private_url','document_changed','url_identity_changed','binding_changed','policy_changed']);
const expiredCodes=new Set(['reservation_expired','submission_expired','execution_expired']);
export function localErrorCode(value:unknown):string|undefined {
  return typeof value==='string'&&value.length<=40&&(terminalCodes.has(value)||expiredCodes.has(value))?value:undefined;
}
export async function createClip(input:Binding,tabId:number,deps:DeliveryDeps) {
  if(input.url_identity_version!==URL_IDENTITY_VERSION)throw new Error('url_identity_changed');
  const job:ClipJob={...input,client:deps.client,url:canonicalUrl(input.url),tab_id:tabId,schema_version:1,phase:'created',next_retry_at:0};
  await deps.save(job);
  return job;
}
export class DeliveryError extends Error {
  readonly code?:string;
  constructor(readonly status:number,readonly retryAfterMs=0,code?:unknown){super(`intake_${status||'offline'}`);this.code=localErrorCode(code);}
}
export async function resumeClip(job:ClipJob,deps:DeliveryDeps) {
  if(['complete','needs_reclick','expired','failed'].includes(job.phase)||job.next_retry_at>deps.now())return;
  const storageErrors=new Set<unknown>();
  const guarded={...deps,save:async(value:ClipJob)=>{try{await deps.save(value);}catch(e){storageErrors.add(e);throw e;}}};
  try {await deliver(job,guarded);} catch(error) {
    if(storageErrors.has(error))throw error;
    const code=error instanceof DeliveryError?error.code:localErrorCode((error as {message?:unknown})?.message);
    if(code){job.phase=expiredCodes.has(code)?'expired':'needs_reclick';job.last_error=code;job.next_retry_at=0;delete job.payload;delete job.digest;delete job.digest_version;await deps.save(structuredClone(job));return;}
    if(!(error instanceof DeliveryError))throw error;
    job.retry_count=(job.retry_count??0)+1;
    job.last_error=error.status?`http_${error.status}`:'offline';
    if((error.status>=400&&error.status<500&&![408,429].includes(error.status))||job.retry_count>=8){
      job.phase='failed';job.next_retry_at=0;delete job.payload;delete job.digest;delete job.digest_version;
    }else job.next_retry_at=deps.now()+Math.max(error.retryAfterMs,Math.min(6*3600000,60000*2**(job.retry_count-1)));
    await deps.save(structuredClone(job));
  }
}
const bindingKeys=['clip_id','attempt_id','url','brand','collection_method','operation','policy_version','url_identity_version'] as const;
function verify(job:ClipJob,r:Reservation,deps:DeliveryDeps) {
  if(!r||r.client!==deps.client||(job.client!==undefined&&job.client!==r.client)||bindingKeys.some(k=>r[k]!==job[k])||(job.reservation&&(job.reservation.id!==r.id||job.reservation.client!==r.client||job.reservation.record_id!==r.record_id||bindingKeys.some(k=>job.reservation![k]!==r[k]))))throw new Error('binding_changed');
}
async function deliver(job:ClipJob,deps:DeliveryDeps) {
  const persist=async()=>deps.save(structuredClone(job));
  const status=await deps.call(`/v1/intake/clips/${job.clip_id}`) as {attempts:Reservation[];receipts:Receipt[]};
  const old=job.reservation?status.attempts.find(r=>r.id===job.reservation!.id):status.attempts.find(r=>r.attempt_id===job.attempt_id);
  if(job.reservation&&!old)throw new Error('binding_changed');
  if(old){
    verify(job,old,deps);
    const receipt=status.receipts.find(r=>r.reservation_id===old.id);
    if(receipt){
      if(old.phase!=='complete'||receipt.id!==old.id||receipt.record_id!==old.record_id||!job.payload||!job.digest||await deps.hash(job.payload,job.digest_version==='stable@1'?undefined:'legacy')!==job.digest||await deps.hash(job.payload)!==receipt.digest)throw new Error('binding_changed');
      delete job.payload;delete job.digest;delete job.digest_version;job.phase='complete';job.next_retry_at=0;delete job.last_error;await persist();return;
    }
  }
  if(job.url_identity_version!==URL_IDENTITY_VERSION)throw new Error('url_identity_changed');
  if(canonicalUrl(job.url)!==job.url)throw new Error('url_identity_changed');
  if(job.client!==deps.client)throw new Error('binding_changed');
  if(old)job.reservation=old;
  if(!job.reservation){
    const {clip_id,attempt_id,url,brand,collection_method,operation,policy_version,url_identity_version}=job;
    const reserved=await deps.call('/v1/intake/reservations',{clip_id,attempt_id,url,brand,collection_method,operation,policy_version,url_identity_version}) as Reservation;
    verify(job,reserved,deps);job.reservation=reserved;
    job.phase='reserved';await persist();
  }
  if(['expired','cancelled'].includes(job.reservation.phase))throw new Error('reservation_expired');
  if(!job.payload){
    if(job.reservation.phase==='started'||job.phase==='extracting'){job.phase='needs_reclick';await persist();return;}
    await deps.checkIdentity(job);
    const started=await deps.call(`/v1/intake/reservations/${job.reservation.id}/start`,{}) as Reservation;
    verify(job,started,deps);job.reservation=started;
    job.phase='extracting';await persist();
    if((job.reservation.execution_until??0)<=deps.now())throw new Error('execution_expired');
    let payload:ClipPayload;
    try{payload=privacyFilter(await deps.extract(job));}catch(e){job.phase='needs_reclick';job.last_error=localErrorCode((e as {message?:unknown})?.message);await persist();return;}
    job.payload=payload;job.digest=await deps.hash(payload);job.digest_version='stable@1';job.phase='payload_ready';await persist();
  }
  if(!job.digest||await deps.hash(job.payload)!==job.digest)throw new Error('binding_changed');
  if((job.reservation.submit_until??0)<deps.now())throw new Error('submission_expired');
  const receipt=await deps.call('/v1/intake',{reservation_id:job.reservation.id,payload:job.payload}) as Receipt;
  if(receipt.reservation_id!==job.reservation.id||receipt.id!==job.reservation.id||receipt.record_id!==job.reservation.record_id||receipt.digest!==job.digest)throw new Error('binding_changed');
  delete job.payload;delete job.digest;delete job.digest_version;job.phase='complete';job.next_retry_at=0;delete job.last_error;await persist();
}
