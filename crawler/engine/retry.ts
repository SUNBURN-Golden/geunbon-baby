import { CostCapError } from './types';
export const HALT_CODES=new Set(['source_blocked','domain_stopped','login_required','access_restricted','empty_page']);
const retryable=new Set(['network_error','request_timeout','source_cooldown','source_response','tool_timeout','execution_expired']);
const failureCodes=new Set([
  'error','daily_limit','unsupported','input_unavailable','network_error','request_timeout','source_cooldown','source_response','tool_timeout','execution_expired',
  'source_blocked','domain_stopped','login_required','access_restricted','empty_page','robots_denied','robots_unavailable','visit_not_allowed','redirect_identity','redirect_missing',
  'response_size','content_type','private_network','unsafe_url','private_url','payload_shape','payload_changed','payload_value','payload_depth','assertions_shape','submission_expired',
  'capture_missing','capture_cache_missing','preparation_limit','preparation_schema','unsupported_xml','retention_not_allowed','artifact_invalid','artifact_corrupt','unsafe_directory','unsafe_file',
  'region_missing','render_not_allowed','source_not_found','reservation_missing','reservation_expired','reservation_state','budget_exceeded','policy_changed','document_changed','url_identity_changed','binding_changed',
  'discovery_disabled','depth_limit','search_permission','search_cursor','search_capture','search_schema','cpsc_schema','discovery_content_type','search_content_type','search_auth_missing','search_endpoint','search_redirect',
  'nested_transaction','merge_forbidden','provenance_invalid','provenance_reused','cost_run','cost_day','storage_column','immutable_id_conflict','unknown_stage','run_not_resumable','source_mismatch'
]);
export function errorCode(e:unknown){const x=e as {code?:unknown;message?:unknown};const code=x?.code??x?.message;return typeof code==='string'&&failureCodes.has(code)?code:'error';}
export function unsupportedTool(e:unknown){const tool=(e as {tool?:unknown})?.tool;return typeof tool==='string'&&['renderer','pdftotext','tesseract','model'].includes(tool)?tool:'unknown';}
export function classify(e:unknown):'day'|'run'|'retryable'|'terminal'|'unsupported' {
  if(e instanceof CostCapError)return e.scope;
  const code=errorCode(e);if(code==='daily_limit')return 'day';if(code==='unsupported')return 'unsupported';
  if(code==='source_response'&&Number((e as {http_status?:number}).http_status)<500)return 'terminal';
  return retryable.has(code)?'retryable':'terminal';
}
export function nextAttemptAt(now:number,attempt:number,_code:string,hints:{next_at?:number;base?:number;max?:number}={},rng= Math.random){
  return Math.max(hints.next_at??0,now+Math.min(hints.max??21600000,Math.max(300000,(hints.base??300000)*2**Math.max(0,attempt-1))+Math.floor(rng()*30000)));
}
