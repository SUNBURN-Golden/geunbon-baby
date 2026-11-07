import { randomUUID } from 'node:crypto';
import { readPrivate, writePrivate } from './private-state';
import type { Identity, ProcessStatus } from './process-identity';
import type { Finding } from './collector-monitor';
export const APPS=['agamajung-local-worker','agamajung-collector-scheduler'] as const;
export type App=typeof APPS[number];
export type Observation={app:App;identity:Identity|null;state:ProcessStatus;policy:boolean;verified:boolean;code:string|null};
export type Attempt={id:string;app:App;at:number;identity:Identity|null;action:'restart';result:'reserved'|'recovered'|'failed'};
export type WatchdogState={schema_version:1;last_at:number;observations:Partial<Record<App,Observation&{at:number}>>;attempts:Attempt[];faults:{app:App|null;code:string;first_at:number;last_at:number;resolved_at:number|null}[]};
const faultCodes=new Set(['missing_slot','last_success_stale','stale_scheduler','scheduler_state_unavailable','slot_waiting_lock','slot_waiting_active_run','schedule_disabled','waiting_deadline','resume_overdue','progress_stale','monitor_db_unavailable','schedule_config_mismatch','pm2_unavailable','pm2_malformed','pm2_app_missing','duplicate_app','supervision_policy_mismatch','process_unverifiable','service_identity_mismatch','live_process_without_lock','readiness_failed','owner_gone','owner_zombie','recovery_failed','recovery_limited','recovery_not_performed']);
export const fixedFault=(code:unknown)=>typeof code==='string'&&faultCodes.has(code)?code:'process_unverifiable';
const exactKeys=(v:object,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const identityValid=(v:unknown):v is Identity=>{const o=v as Identity;return !!o&&exactKeys(o,['pid','start_ticks','boot_id'])&&Number.isSafeInteger(o.pid)&&o.pid>0&&typeof o.start_ticks==='string'&&/^\d+$/.test(o.start_ticks)&&typeof o.boot_id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(o.boot_id);};
export function validState(v:unknown,now:number):v is WatchdogState {
  const s=v as WatchdogState,time=(t:unknown)=>typeof t==='number'&&Number.isSafeInteger(t)&&t>=0&&t<=now;
  if(!s||!exactKeys(s,['schema_version','last_at','observations','attempts','faults'])||s.schema_version!==1||!time(s.last_at)||!s.observations||typeof s.observations!=='object'||!Array.isArray(s.attempts)||!Array.isArray(s.faults))return false;
  return Object.entries(s.observations).every(([a,o])=>APPS.includes(a as App)&&o&&exactKeys(o,['app','identity','state','policy','verified','code','at'])&&o.app===a&&time(o.at)&&['alive','gone','zombie','unknown'].includes(o.state)&&typeof o.policy==='boolean'&&typeof o.verified==='boolean'&&(o.identity===null||identityValid(o.identity))&&(o.code===null||faultCodes.has(o.code)))&&s.attempts.every(a=>a&&exactKeys(a,['id','app','at','identity','action','result'])&&APPS.includes(a.app)&&/^[a-f0-9-]{36}$/.test(a.id)&&time(a.at)&&a.action==='restart'&&['reserved','recovered','failed'].includes(a.result)&&(a.identity===null||identityValid(a.identity)))&&s.faults.every(f=>f&&exactKeys(f,['app','code','first_at','last_at','resolved_at'])&&(f.app===null||APPS.includes(f.app))&&faultCodes.has(f.code)&&time(f.first_at)&&time(f.last_at)&&f.last_at>=f.first_at&&(f.resolved_at===null||time(f.resolved_at)));
}
export type WatchdogAdapters={now:()=>number;observe:(app:App)=>Promise<Observation>;restart:(app:App)=>Promise<void>;confirm:(app:App,previous:Identity|null)=>Promise<boolean>;findings:()=>Promise<Finding[]>;emit:(event:Record<string,unknown>)=>void;save?:(state:WatchdogState)=>void};
const same=(a:Identity|null,b:Identity|null)=>a===null?b===null:b!==null&&a.pid===b.pid&&a.start_ticks===b.start_ticks&&a.boot_id===b.boot_id;
export async function watchdog(path:string,adapters:WatchdogAdapters){
  const now=adapters.now();let state:WatchdogState;
  try{const read=readPrivate(path);if(!validState(read,now))throw new Error();state=read;}catch{adapters.emit({event:'watchdog',generated_at:new Date(now).toISOString(),code:'watchdog_state_unavailable',automatic_recovery:false});return;}
  const save=()=>{const at=adapters.now();if(at<state.last_at)throw new Error('watchdog_clock');state.last_at=at;(adapters.save??(s=>writePrivate(path,s)))(state);};
  const current:{app:App|null;code:string}[]=[];
  const report=(code:string,app:App|null=null,details:Record<string,unknown>={})=>{code=fixedFault(code);current.push({app,code});const previous=state.faults.find(f=>f.app===app&&f.code===code&&f.resolved_at===null);const emitted=code==='stale_scheduler'&&(!previous||now-previous.first_at<60000||now-previous.last_at>180000)?'stale_scheduler_suspected':code;adapters.emit({event:'watchdog',generated_at:new Date(now).toISOString(),app,code:emitted,automatic_recovery:false,...details});};
  let monitoringAvailable=true;
  try{for(const f of await adapters.findings()){report(f.code,null,{job:['discover','collect','discover-sources','backfill-engine'].includes(f.job??'')?f.job:null,status:['intent','running','pending','halted','exhausted','failed','partial_failure','disabled','succeeded','interrupted','already_completed','skipped','unobserved'].includes(f.status??'')?f.status:null,next_at:typeof f.next_at==='number'&&Number.isSafeInteger(f.next_at)&&f.next_at>=0?f.next_at:null});if(['monitor_db_unavailable','schedule_config_mismatch'].includes(f.code))monitoringAvailable=false;}}catch{monitoringAvailable=false;report('monitor_db_unavailable');}
  for(const app of APPS){
    let o:Observation;
    try{o=await adapters.observe(app);}catch{report('process_unverifiable',app);continue;}
    // Rebuild the observation explicitly: PM2 fixtures/raw responses can never enter state.
    o={app,identity:o.identity&&identityValid(o.identity)?{pid:o.identity.pid,start_ticks:o.identity.start_ticks,boot_id:o.identity.boot_id}:null,state:['alive','gone','zombie','unknown'].includes(o.state)?o.state:'unknown',verified:o.verified===true&&(o.identity===null?o.state==='gone'||o.state==='alive':identityValid(o.identity)),policy:o.policy===true,code:o.code===null?null:fixedFault(o.code)};
    const previous=state.observations[app];state.observations[app]={...o,at:now};
    if(o.code)report(o.code,app);
    if(!o.policy){report('supervision_policy_mismatch',app);continue;}
    if(!monitoringAvailable||!o.verified||!['gone','zombie'].includes(o.state)){if(o.state!=='alive')report('recovery_not_performed',app);continue;}
    report(o.state==='gone'?'owner_gone':'owner_zombie',app);
    if(!previous||now-previous.at<60000||now-previous.at>180000||previous.state!==o.state||!previous.verified||!previous.policy||!same(previous.identity,o.identity)){report('recovery_not_performed',app);continue;}
    const attempts=state.attempts.filter(a=>a.app===app);
    if(attempts.some(a=>now-a.at<600000)||attempts.filter(a=>now-a.at<3600000).length>=3){report('recovery_limited',app);continue;}
    const attempt:Attempt={id:randomUUID(),app,at:now,identity:o.identity,action:'restart',result:'reserved'};state.attempts.push(attempt);
    save(); // Reservation must reach durable storage before any command is invoked.
    try{
      // A final observation closes the gap before restart, without deleting any lock.
      const fresh=await adapters.observe(app);
      if(!fresh.verified||!fresh.policy||fresh.state!==o.state||!same(fresh.identity,o.identity))throw new Error();
      await adapters.restart(app);attempt.result=await adapters.confirm(app,o.identity)?'recovered':'failed';
    }catch{attempt.result='failed';}
    save();adapters.emit({event:'watchdog_recovery',generated_at:new Date(adapters.now()).toISOString(),app,attempt_id:attempt.id,result:attempt.result,automatic_recovery:true});
    if(attempt.result==='failed')report('recovery_failed',app);
    delete state.observations[app];
  }
  for(const old of state.faults)if(old.resolved_at===null&&!current.some(f=>f.app===old.app&&f.code===old.code))old.resolved_at=now;
  for(const f of current){const old=state.faults.find(o=>o.app===f.app&&o.code===f.code&&o.resolved_at===null);if(old)old.last_at=now;else state.faults.push({...f,first_at:now,last_at:now,resolved_at:null});}
  state.attempts=state.attempts.filter(a=>now-a.at<=7*86400000);state.faults=state.faults.filter(f=>f.resolved_at===null||now-f.resolved_at<=7*86400000);save();
}
export function initialWatchdogState(now:number):WatchdogState{return {schema_version:1,last_at:now,observations:{},attempts:[],faults:[]};}
