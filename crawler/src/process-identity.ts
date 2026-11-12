import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { processStartTicks, processState, type ProcReader } from './run-lock';
export type Identity={pid:number;start_ticks:string;boot_id:string};
export type ProcessStatus='alive'|'gone'|'zombie'|'unknown';
const uuid=(s:string)=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
export const procRead:ProcReader=path=>readFileSync(path,'utf8');
export function identity(pid=process.pid,read:ProcReader=procRead):Identity {
  const boot_id=read('/proc/sys/kernel/random/boot_id').trim(),start_ticks=processStartTicks(read(`/proc/${pid}/stat`));
  if(!Number.isSafeInteger(pid)||pid<1||!uuid(boot_id))throw new Error('process_unverifiable');
  return {pid,start_ticks,boot_id};
}
export function inspectIdentity(owner:Identity,read:ProcReader=procRead,check=(pid:number)=>{process.kill(pid,0);}):ProcessStatus {
  try{check(owner.pid);}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?'gone':'unknown';}
  try{
    const boot=read('/proc/sys/kernel/random/boot_id').trim();if(!uuid(boot))return 'unknown';
    if(boot!==owner.boot_id)return 'gone';
    const stat=read(`/proc/${owner.pid}/stat`);if(processStartTicks(stat)!==owner.start_ticks)return 'gone';
    const state=processState(stat);return state==='Z'?'zombie':/^[RSDTtWIXPK]$/.test(state)?'alive':'unknown';
  }catch{return 'unknown';}
}
// Injectable /proc view so service identity stays testable without live processes.
export type ProcScan={readdir(path:string):string[];uid(pid:number):number;realpath(path:string):string};
export const realProcScan:ProcScan={readdir:path=>readdirSync(path),uid:pid=>statSync(`/proc/${pid}`).uid,realpath:path=>realpathSync(path)};
// Scan all visible same-user processes. Failure to inspect any potential owner fails closed.
// Watchdog must run in the same host/PID namespace as PM2 and these services.
export function serviceProcesses(root:string,read:ProcReader=procRead,scan:ProcScan=realProcScan){
  const found:{identity:Identity;service:'local'|'scheduler'|'job';state:ProcessStatus}[]=[];
  // An unresolvable caller root can prove nothing about service ownership.
  let rootReal:string;
  try{rootReal=scan.realpath(root);}catch{throw new Error('process_unverifiable');}
  for(const name of scan.readdir('/proc').filter(s=>/^\d+$/.test(s))){
    const pid=Number(name);let uid:number;
    try{uid=scan.uid(pid);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error('process_unverifiable');}
    if(uid!==process.getuid!())continue;
    try{
      const args=read(`/proc/${pid}/cmdline`).split('\0');
      const script=args.find(s=>/(?:^|\/)(?:local-worker\.(?:mjs|ts)|collector-scheduler\.mjs)$/.test(s));
      if(!script)continue;
      const cwd=scan.realpath(`/proc/${pid}/cwd`);
      const absolute=scan.realpath(script.startsWith('/')?script:`${cwd}/${script}`);
      // Each checkout root owns its own DB, run locks and root-scoped PM2 apps
      // (parsePm2 is root/db scoped), so a collector service that provably
      // lives under a different canonical root is not this root's service.
      if(absolute!==rootReal&&!absolute.startsWith(rootReal+'/'))continue;
      const service=args.includes('schedule')||script.endsWith('collector-scheduler.mjs')?'scheduler':args.some(a=>['discover','collect','discover-sources','backfill-engine'].includes(a))?'job':'local';
      const own=identity(pid,read);found.push({identity:own,service,state:inspectIdentity(own,read)});
    }catch(e){if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))continue;throw new Error('process_unverifiable');}
  }
  return found;
}
