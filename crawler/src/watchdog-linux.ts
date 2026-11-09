import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { APPS, type App, type Observation, type WatchdogAdapters } from './collector-watchdog';
import { identity, inspectIdentity, serviceProcesses, type Identity } from './process-identity';
import { ownerOf, readLock, type RunKind } from './run-lock';
import { readPrivate } from './private-state';
import { scheduleHash } from './schedule-worker';
import { monitor, type SchedulerStatus } from './collector-monitor';
import { loadSchedule } from './collection-schedule';
const exec=promisify(execFile);
const same=(a:Identity,b:Identity)=>a.pid===b.pid&&a.start_ticks===b.start_ticks&&a.boot_id===b.boot_id;
export type PmApp={app:App;id:number;pid:number;policy:boolean};
export function parsePm2(text:string,root:string,dbFile?:string):PmApp[]{
  const list=JSON.parse(text);if(!Array.isArray(list)||list.length>1024)throw new Error('pm2_malformed');
  return APPS.flatMap(app=>{
    const matches=list.filter(v=>v?.name===app);if(matches.length>1)throw new Error('duplicate_app');if(!matches.length)return [];
    const v=matches[0],e=v.pm2_env,pid=v.pid??0;
    if(!e||!Number.isSafeInteger(v.pm_id)||v.pm_id<0||!Number.isSafeInteger(pid)||pid<0)throw new Error('pm2_malformed');
    const script=app===APPS[0]?'local-worker.mjs':'collector-scheduler.mjs';
    const args=Array.isArray(e.args)?e.args:typeof e.args==='string'?e.args.split(/\s+/):[];
    const nodeArgs=Array.isArray(e.node_args)?e.node_args:typeof e.node_args==='string'?e.node_args.split(/\s+/):[];
    const legacy=list.some(v=>['agamajung-discover','agamajung-collect','agamajung-discover-sources','agamajung-backfill-engine'].includes(v?.name)&&v?.pm2_env?.status!=='stopped');
    const duplicate=list.some(v=>v?.name!==app&&v?.pm2_env?.pm_exec_path===`${root}/crawler/${script}`);
    const dbMatches=dbFile===undefined||e.COLLECTOR_DB===dbFile||e.env?.COLLECTOR_DB===dbFile;
    const policy=dbMatches&&!legacy&&!duplicate&&args.length===1&&args[0]===(app===APPS[0]?'serve':'schedule')&&nodeArgs.length===2&&nodeArgs[0]==='--import'&&nodeArgs[1]==='tsx'&&e.pm_exec_path===`${root}/crawler/${script}`&&e.pm_cwd===root&&e.exec_interpreter===`${root}/node_modules/node/bin/node`&&['fork','fork_mode'].includes(e.exec_mode)&&e.instances===1&&e.autorestart===false&&e.max_restarts===1&&e.restart_delay===10000&&e.watch===false&&!e.cron_restart&&e.kill_timeout===90000;
    return [{app,id:v.pm_id,pid,policy}];
  });
}
export type LinuxOverrides={pm?:()=>Promise<PmApp[]>;processes?:typeof serviceProcesses;lock?: (kind:RunKind)=>{owner:Identity;status:import('./process-identity').ProcessStatus}|null;ready?:()=>Promise<Identity>;status?:()=>SchedulerStatus;command?:(id:number)=>Promise<void>};
export function linuxAdapters(dbFile:string,root=resolve('.'),overrides:LinuxOverrides={}):WatchdogAdapters {
  const pm2=process.env.COLLECTOR_PM2_BIN??'pm2';
  // PM2 CLI otherwise starts a new daemon when its control socket is absent.
  // Re-check immediately before every CLI invocation, including restart.
  const requireSocket=()=>{
    const socket=lstatSync(join(process.env.PM2_HOME??join(homedir(),'.pm2'),'rpc.sock'));
    if(!socket.isSocket()||socket.uid!==process.getuid!())throw new Error();
  };
  const pm=overrides.pm??(async()=>{
    let output:string;try{
      requireSocket();
      output=(await exec(pm2,['jlist'],{timeout:10000,maxBuffer:8*1024*1024,encoding:'utf8'})).stdout;}catch{throw new Error('pm2_unavailable');}
    try{return parsePm2(output,root,dbFile);}catch(e){throw new Error(e instanceof Error&&e.message==='duplicate_app'?'duplicate_app':'pm2_malformed');}
  });
  const expected=(app:App)=>app===APPS[0]?'local':'scheduler';
  const lockStatus=overrides.lock??((kind:RunKind)=>{
    const lock=readLock(`${dbFile}.${kind}.lock`);if(!lock)return null;
    const owner=ownerOf(lock.text,kind,`${dbFile}.${kind}.lock`);return {owner,status:inspectIdentity(owner)};
  });
  const readiness=overrides.ready??(async()=>{
    const token=process.env.COLLECTOR_REVIEW_TOKEN??'';if(token.length<24)throw new Error('readiness_failed');
    const response=await fetch('http://127.0.0.1:4318/v1/readiness',{headers:{Authorization:`Bearer ${token}`,Host:'127.0.0.1:4318'},redirect:'error',signal:AbortSignal.timeout(3000)});
    if(response.status!==200||Number(response.headers.get('content-length'))>4096)throw new Error('readiness_failed');
    const reader=response.body?.getReader();if(!reader)throw new Error('readiness_failed');let size=0;const chunks:Uint8Array[]=[];
    for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>4096){await reader.cancel();throw new Error('readiness_failed');}chunks.push(r.value);}
    const data=JSON.parse(Buffer.concat(chunks).toString()).data;if(data?.ready!==true)throw new Error('readiness_failed');
    const own=identity(data.identity?.pid);if(!same(own,data.identity))throw new Error('readiness_failed');return own;
  });
  const status=overrides.status??(()=>readPrivate(`${dbFile}.schedule/scheduler.json`) as SchedulerStatus);
  const observe=async(app:App):Promise<Observation>=>{
    const base:Observation={app,identity:null,state:'unknown',policy:false,verified:false,code:null};
    let apps:PmApp[];
    try{apps=await pm();}catch(e){return {...base,code:['pm2_unavailable','pm2_malformed','duplicate_app'].includes((e as Error).message)?(e as Error).message:'pm2_unavailable'};}
    const target=apps.find(a=>a.app===app);if(!target)return {...base,code:'pm2_app_missing'};
    base.policy=target.policy;if(!target.policy)return {...base,code:'supervision_policy_mismatch'};
    try{
      const processes=(overrides.processes??serviceProcesses)(root),matching=processes.filter(p=>p.service===expected(app));
      if(matching.some(p=>p.state==='unknown')||processes.some(p=>p.state==='unknown'))return {...base,code:'process_unverifiable'};
      const living=matching.filter(p=>p.state==='alive');
      const lock=lockStatus(app===APPS[0]?'serve':'schedule'),crawl=lockStatus('crawl');
      if(lock?.status==='unknown'||crawl?.status==='unknown')return {...base,code:'process_unverifiable'};
      if(living.length){
        if(living.length!==1||living[0].identity.pid!==target.pid)return {...base,code:'service_identity_mismatch'};
        base.identity=living[0].identity;base.state='alive';
        if(!lock||lock.status!=='alive'||!same(lock.owner,base.identity))return {...base,code:'live_process_without_lock'};
        if(app===APPS[0]){try{if(!same(await readiness(),base.identity))throw new Error();}catch{return {...base,code:'readiness_failed'};}}
        else{try{if(!same(status().identity,base.identity))throw new Error();}catch{return {...base,code:'service_identity_mismatch'};}}
        return {...base,verified:true};
      }
      // A live PM2 pid outside the verified service inventory is never killed.
      if(target.pid){
        try{base.identity=identity(target.pid);base.state=inspectIdentity(base.identity);if(base.state==='alive'||base.state==='unknown')return {...base,code:'service_identity_mismatch'};}
        catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))return {...base,code:'process_unverifiable'};base.state='gone';}
      }else base.state='gone';
      if(matching.some(p=>p.state==='zombie')){
        if(matching.length!==1)return {...base,code:'service_identity_mismatch'};
        base.identity=matching[0].identity;base.state='zombie';
      }
      if(base.state==='zombie'&&(!lock||!base.identity||!same(lock.owner,base.identity)))return {...base,code:'service_identity_mismatch'};
      if(base.state==='gone'&&lock&&['gone','zombie'].includes(lock.status)){base.identity={pid:lock.owner.pid,start_ticks:lock.owner.start_ticks,boot_id:lock.owner.boot_id};base.state=lock.status==='zombie'?'zombie':'gone';}
      if(lock?.status==='alive'||crawl?.status==='alive'||processes.some(p=>p.service==='job'&&p.state==='alive'))return {...base,code:'live_process_without_lock'};
      // Startup owns stale-lock reclamation with its usual grace and inode checks.
      return {...base,verified:true};
    }catch{return {...base,code:'process_unverifiable'};}
  };
  return {
    now:Date.now,observe,
    findings:async()=>{
      const file=lstatSync(dbFile);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||realpathSync(dbFile)!==dbFile)throw new Error();
      const db=new DatabaseSync(dbFile,{readOnly:true});
      try{db.exec('PRAGMA busy_timeout=2000');if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<8)throw new Error();let s:SchedulerStatus|undefined;try{s=status();}catch{}return monitor(db,loadSchedule(),Date.now(),s);}finally{db.close();}
    },
    restart:async app=>{
      const checked=await observe(app);if(!checked.verified||!checked.policy||!['gone','zombie'].includes(checked.state))throw new Error();
      const target=(await pm()).find(a=>a.app===app);if(!target?.policy)throw new Error();
      if(target.pid){try{const current=inspectIdentity(identity(target.pid));if(current==='alive'||current==='unknown')throw new Error();}catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}
      if(overrides.command)await overrides.command(target.id);else {try{requireSocket();}catch{throw new Error('pm2_unavailable');}await exec(pm2,['restart',String(target.id)],{timeout:20000,maxBuffer:1024*1024,encoding:'utf8'});}
    },
    confirm:async(app,previous)=>{
      // The scheduler records evaluation timestamps on the startup pass (before
      // its first due run). Compare them with the moment confirmation began,
      // allowing a small tolerance for startup before this loop starts.
      const started=Date.now(),accept=started-5000,deadline=started+60000;
      while(Date.now()<deadline){
        const o=await observe(app);
        if(o.verified&&o.state==='alive'&&o.identity&&(!previous||!same(o.identity,previous))){
          if(app===APPS[0])return true;
          try{const s=status();if(s.heartbeat>=accept&&s.config_hash===scheduleHash(loadSchedule())&&loadSchedule().filter(j=>j.enabled).every(j=>s.evaluations[j.job]>=accept))return true;}catch{}
        }
        await new Promise(r=>setTimeout(r,1000));
      }return false;
    },
    emit:event=>console.log(JSON.stringify({schema_version:1,...event})),
  };
}
