import { CostCapError } from './types';
export const HALT_CODES=new Set(['source_blocked','domain_stopped','login_required','access_restricted','empty_page']);
const retryable=new Set(['network_error','request_timeout','source_cooldown','source_response','tool_timeout','execution_expired']);
export function errorCode(e:unknown){const x=e as {code?:string;message?:string};const code=x?.code??x?.message??'error';return /^[a-z_]{1,40}$/.test(code)?code:'error';}
export function classify(e:unknown):'day'|'run'|'retryable'|'terminal'|'unsupported' {
  if(e instanceof CostCapError)return e.scope;
  const code=errorCode(e);if(code==='daily_limit')return 'day';if(code==='unsupported')return 'unsupported';
  if(code==='source_response'&&Number((e as {http_status?:number}).http_status)<500)return 'terminal';
  return retryable.has(code)?'retryable':'terminal';
}
export function nextAttemptAt(now:number,attempt:number,_code:string,hints:{next_at?:number;base?:number;max?:number}={},rng= Math.random){
  return Math.max(hints.next_at??0,now+Math.min(hints.max??21600000,Math.max(300000,(hints.base??300000)*2**Math.max(0,attempt-1))+Math.floor(rng()*30000)));
}
