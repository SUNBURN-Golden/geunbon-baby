import { digest } from './dedup';
import { envelope, invocation, publish, safeId, safeReason, safeTime, outcomes } from '../collector-bootstrap.mjs';
import type { LogicalRun } from './schedule-state';
export type Invocation = ReturnType<typeof invocation>;
export { invocation, publish };
const keys=new Set(['state','enabled','dry_run','run_id','generated_at','discovered','source_check_needed','dedup_excluded','verified_waiting','ready_to_publish','counts','total','done','failed','skipped','unfinished','attempted','review','max_depth','shared_owner','version','unique','groups','unresolved_conflicts','recheck_due','health','mode','status','sources','source_id','flags','notes','pages_attempted','pages_ok','pages_failed','pages_review','links_found','parsed','eligible','price_checked','price_hints','sent','blocked','page_findings','zero_parsed','zero_eligible','zero_price_hints','failures','subrequest_failures','blocked_reasons','jobs','pending','candidates','truncated_checkpoints','checkpoints','phase','count']);
const sources=new Set(['cpsc','pangpang','snapup']);
const failures=new Set(['redirect_identity','error','network_error','request_timeout','source_response','source_blocked','source_cooldown','robots_denied','robots_unavailable','visit_not_allowed','domain_stopped','private_network','redirect_missing','response_size','login_required','access_restricted','empty_page','region_missing','region_required','selector_invalid','browser_not_approved','document_changed','url_identity_changed','binding_changed','policy_changed','unsafe_url','private_url','daily_limit','execution_expired','submission_expired','payload_shape','payload_changed','cpsc_schema','depth_limit','source_mismatch','brand_mismatch','reservation_expired']);
const strings=new Set(['running','finished','halted','exhausted','cost_wait','agamajung','ok','review','idle','run','dry_run','failed','blocked','not_attempted','zero_parsed','zero_eligible','zero_price_hints','subrequest_failed','price_not_assessed','price_not_applicable','cpsc','pangpang','snapup','done','skipped','pending','retry_wait','deferred','leased']);
// Output is bounded, with explicit keys and string values. Custom source IDs become opaque IDs.
export function safeResult(value:unknown,depth=0,key=''):unknown {
  if(depth>10)return null;
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?value:null;
  if(typeof value==='string'){
    if(key==='generated_at'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value)))return value;
    if(key==='source_id')return sources.has(value)?value:digest(value);
    if(key==='reason')return failures.has(value)?value:safeReason(value);
    return safeId(value)??(strings.has(value)?value:null);
  }
  if(!value||typeof value!=='object')return null;
  if(Array.isArray(value))return value.slice(0,1000).map(v=>safeResult(v,depth+1,key==='sources'?'':key));
  if(key==='sources')return Object.fromEntries(Object.entries(value).slice(0,1000).map(([id,v])=>[sources.has(id)?id:digest(id),safeResult(v,depth+1)]));
  if(['failures','blocked_reasons','subrequest_failures'].includes(key))return Object.fromEntries(Object.entries(value).filter(([k,v])=>failures.has(k)&&Number.isSafeInteger(v)&&Number(v)>=0));
  return Object.fromEntries(Object.entries(value).filter(([k])=>keys.has(k)).map(([k,v])=>[k,safeResult(v,depth+1,k)]));
}
const countKeys=new Set(['pages_attempted','pages_ok','pages_failed','blocked_requests','parsed_items','eligible_items','submissions_accepted','subrequest_failures','sources_review','checkpoints_done','checkpoints_failed','checkpoints_skipped','checkpoints_unfinished','service_receipts_confirmed','checkpoint_attempts_delta','service_receipts_confirmed_delta']);
export const safeCounts=(c:Record<string,number>|null)=>c===null?null:Object.fromEntries(Object.entries(c).filter(([k,v])=>countKeys.has(k)&&Number.isSafeInteger(v)&&v>=0));
export type Counts={engine:Record<string,number>|null;invocation:Record<string,number>|null};
export function jobEvent(context:Invocation,event:'start'|'result',at:number,fields:{logical?:LogicalRun;expected?:{target:number;version:string};outcome?:string;reason?:string;counts?:Counts;output?:unknown;history_status?:'recorded'|'unavailable'}={}) {
  const r=fields.logical;
  return envelope(context,event,at,{logical_run_id:safeId(r?.id),engine_run_id:safeId(r?.engine_id),schedule_version:safeId(r?.version??fields.expected?.version),first_slot:safeTime(r?.first_slot),target_slot:safeTime(r?.target_slot),slot_count:r?.slot_count??null,expected_slot:safeTime(fields.expected?.target),outcome:fields.outcome&&outcomes.has(fields.outcome)?fields.outcome:null,reason:safeReason(fields.reason??'started'),counts:fields.counts?{engine:safeCounts(fields.counts.engine),invocation:safeCounts(fields.counts.invocation)}:{engine:null,invocation:null},history_status:fields.history_status??null,result:safeResult(fields.output)});
}
