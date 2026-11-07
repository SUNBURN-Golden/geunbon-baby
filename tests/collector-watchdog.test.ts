import { expect, test, vi } from 'vitest';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { APPS, initialWatchdogState, validState, watchdog, type Observation, type WatchdogAdapters, type WatchdogState } from '../crawler/src/collector-watchdog';
import { readPrivate, writePrivate } from '../crawler/src/private-state';
import { identity, inspectIdentity } from '../crawler/src/process-identity';
import { linuxAdapters, parsePm2, type LinuxOverrides } from '../crawler/src/watchdog-linux';
import { ScheduleWorker } from '../crawler/src/schedule-worker';
import { loadSchedule } from '../crawler/src/collection-schedule';
import { fixture } from './helpers/collector';
const boot='11111111-1111-1111-1111-111111111111',own={pid:123,start_ticks:'22',boot_id:boot};
function harness(){
  const f=fixture(),path=f.file+'.watchdog/state.json';writePrivate(path,initialWatchdogState(f.now()));
  const observe=vi.fn(async(app:typeof APPS[number]):Promise<Observation>=>({app,identity:null,state:app===APPS[0]?'gone':'alive',policy:true,verified:true,code:null}));
  const restart=vi.fn(async()=>{}),confirm=vi.fn(async()=>true),events:Record<string,unknown>[]=[];
  const adapters:WatchdogAdapters={now:f.now,observe,restart,confirm,findings:async()=>[],emit:e=>events.push(e)};
  return {...f,f,path,adapters,observe,restart,confirm,events,step:async(ms=60000)=>{f.advance(ms);await watchdog(path,adapters);},read:()=>readPrivate(path) as WatchdogState};
}
test('online with no PID needs two spaced observations, reserves before restart and confirms readiness',async()=>{
  const h=harness();try{
    await watchdog(h.path,h.adapters);expect(h.restart).not.toHaveBeenCalled();
    h.restart.mockImplementation(async()=>{expect(h.read().attempts).toMatchObject([{app:APPS[0],result:'reserved'}]);});
    await h.step();expect(h.restart).toHaveBeenCalledExactlyOnceWith(APPS[0]);expect(h.confirm).toHaveBeenCalledExactlyOnceWith(APPS[0],null);
    expect(h.read().attempts[0].result).toBe('recovered');expect(statSync(h.path).mode&0o777).toBe(0o600);expect(statSync(h.f.file+'.watchdog').mode&0o777).toBe(0o700);
  }finally{h.close();}
});
test('durable reservations survive watchdog restart and interrupted commands, applying both recovery caps',async()=>{
  const h=harness();try{
    const state=h.read();state.attempts=[0,20,40].map((m,i)=>({id:`11111111-1111-1111-1111-${String(i).padStart(12,'0')}`,app:APPS[0],at:h.now()-m*60000,identity:null,action:'restart',result:'reserved'}));writePrivate(h.path,state);
    await watchdog(h.path,h.adapters);await h.step(600000);expect(h.restart).not.toHaveBeenCalled();
    // Still three reservations within the rolling hour; none are erased by a new invocation.
    await h.step();expect(h.restart).not.toHaveBeenCalled();expect(h.events.some(e=>e.code==='recovery_limited')).toBe(true);
    await h.step(600000);await h.step();expect(h.restart).toHaveBeenCalledTimes(1);
    await h.step();await h.step();expect(h.restart).toHaveBeenCalledTimes(1);
  }finally{h.close();}
});
test.each(['unknown','alive'] as const)('a %s owner and readiness timeout never trigger restart or lock cleanup',async state=>{
  const h=harness();try{
    h.observe.mockImplementation(async app=>({app,identity:own,state,policy:true,verified:false,code:'readiness_failed'}));
    await watchdog(h.path,h.adapters);await h.step();expect(h.restart).not.toHaveBeenCalled();expect(h.confirm).not.toHaveBeenCalled();
  }finally{h.close();}
});
test('identity changes, policy mismatch, failed DB inspection, and confirmation failure remain separate from collection success',async()=>{
  const h=harness();try{
    h.observe.mockImplementation(async app=>({app,identity:own,state:'zombie',policy:true,verified:true,code:null}));await watchdog(h.path,h.adapters);
    h.observe.mockImplementation(async app=>({app,identity:{...own,start_ticks:'23'},state:'zombie',policy:true,verified:true,code:null}));await h.step();expect(h.restart).not.toHaveBeenCalled();
    h.adapters.findings=async()=>{throw new Error('credential=never-print');};await h.step();expect(h.restart).not.toHaveBeenCalled();
    h.adapters.findings=async()=>[];h.confirm.mockResolvedValue(false);await h.step();expect(h.read().attempts.every(a=>a.result==='failed')).toBe(true);expect(h.restart).toHaveBeenCalled();expect(JSON.stringify(h.events)).not.toContain('never-print');
  }finally{h.close();}
});
test.each(['missing','corrupt','clock','unknown_field'] as const)('%s recovery state blocks automatic recovery without resetting limits',async mode=>{
  const h=harness();try{
    if(mode==='missing')unlinkSync(h.path);
    if(mode==='corrupt')writeFileSync(h.path,'private-secret');
    if(mode==='clock')h.f.advance(-1);
    if(mode==='unknown_field')writeFileSync(h.path,JSON.stringify({...h.read(),secret:'private-secret'}));
    await watchdog(h.path,h.adapters);expect(h.observe).not.toHaveBeenCalled();expect(h.restart).not.toHaveBeenCalled();expect(h.events[0]).toMatchObject({code:'watchdog_state_unavailable',automatic_recovery:false});expect(JSON.stringify(h.events)).not.toContain('private-secret');
  }finally{h.close();}
});
test('a failed reservation write prevents the recovery command',async()=>{
  const h=harness();try{
    await watchdog(h.path,h.adapters);h.adapters.save=()=>{throw new Error('disk_full');};
    await expect(h.step()).rejects.toThrow('disk_full');expect(h.restart).not.toHaveBeenCalled();
  }finally{h.close();}
});
test('a fresh final observation cancels restart if another worker appeared',async()=>{
  const h=harness();try{
    await watchdog(h.path,h.adapters);let n=0;
    h.observe.mockImplementation(async app=>({app,identity:null,state:app===APPS[0]&&n++===0?'gone':'alive',verified:true,policy:true,code:null}));
    await h.step();expect(h.restart).not.toHaveBeenCalled();expect(h.read().attempts[0].result).toBe('failed');
  }finally{h.close();}
});
test('PM2 parser uses only allowed fields, rejects malformed/duplicate registrations and detects old cron policy',()=>{
  const root='/fixture',app={name:APPS[0],pm_id:1,pid:0,pm2_env:{pm_exec_path:root+'/crawler/local-worker.mjs',pm_cwd:root,exec_interpreter:root+'/node_modules/node/bin/node',args:['serve'],node_args:['--import','tsx'],exec_mode:'fork_mode',instances:1,autorestart:false,max_restarts:1,restart_delay:10000,watch:false,kill_timeout:90000,secret:'private-secret'}};
  expect(parsePm2(JSON.stringify([app]),root)).toEqual([{app:APPS[0],id:1,pid:0,policy:true}]);expect(parsePm2(JSON.stringify([{...app,pid:undefined}]),root)[0].pid).toBe(0);expect(()=>parsePm2('{}',root)).toThrow('pm2_malformed');expect(()=>parsePm2(JSON.stringify([app,app]),root)).toThrow('duplicate_app');
  for(const extra of [{name:'agamajung-discover',pm2_env:{status:'online',cron_restart:'20 9,15,21 * * *'}},{...app,name:'alternate'}])expect(parsePm2(JSON.stringify([app,extra]),root)[0].policy).toBe(false);
});
test('Linux observations preserve live owners, detect a process without its lock, and fail closed on PM2 errors',async()=>{
  const f=fixture();try{
    const current=identity(),command=vi.fn(async()=>{}),processes=vi.fn(()=>[{identity:current,service:'local' as const,state:'alive' as const}]);
    const deps:LinuxOverrides={pm:async()=>[{app:APPS[0],id:1,pid:current.pid,policy:true}],processes,lock:()=>null,ready:async()=>current,command};
    const a=linuxAdapters(f.file,'/fixture',deps);
    expect(await a.observe(APPS[0])).toMatchObject({state:'alive',verified:false,code:'live_process_without_lock'});
    deps.lock=()=>({owner:current,status:'alive'});deps.ready=async()=>{throw new Error('private-secret');};
    expect(await linuxAdapters(f.file,'/fixture',deps).observe(APPS[0])).toMatchObject({state:'alive',verified:false,code:'readiness_failed'});
    deps.pm=async()=>{throw new Error('pm2_malformed');};expect(await linuxAdapters(f.file,'/fixture',deps).observe(APPS[0])).toMatchObject({verified:false,code:'pm2_malformed'});expect(command).not.toHaveBeenCalled();
  }finally{f.close();}
});
test('shared process identity distinguishes zombie, reused PID and inspection failures',()=>{
  const stat=(state:string,ticks='22')=>`123 (worker ) name) ${state} ${Array(18).fill('0').join(' ')} ${ticks}`;
  expect(inspectIdentity(own,p=>p.endsWith('boot_id')?boot:stat('Z'),()=>{})).toBe('zombie');
  expect(inspectIdentity(own,p=>p.endsWith('boot_id')?boot:stat('R','23'),()=>{})).toBe('gone');
  expect(inspectIdentity(own,()=>{throw new Error();},()=>{})).toBe('unknown');
  expect(inspectIdentity(own,()=>boot,()=>{throw Object.assign(new Error(),{code:'EPERM'});})).toBe('unknown');
  expect(validState({...initialWatchdogState(1),attempts:[{secret:'private-secret'}]},2)).toBe(false);
});
test('scheduler recovery confirmation succeeds while the first due run is still in progress',async()=>{
  const f=fixture();try{
    // confirm() compares scheduler.json against wall-clock time; keep a margin
    // so a slow first tick cannot age the startup evaluation beyond the tolerance.
    f.advance(Date.now()+60000-f.now());
    const current=identity(),schedules=loadSchedule();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
    const execute=vi.fn(async()=>{await gate;return {};});
    const worker=new ScheduleWorker(f.store,()=>({create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded' as const,reason:'completed'})})}),schedules,{log:()=>{},output:()=>{}});
    const a=linuxAdapters(f.file,'/fixture',{
      pm:async()=>[{app:APPS[1],id:1,pid:current.pid,policy:true}],
      processes:()=>[{identity:current,service:'scheduler' as const,state:'alive' as const}],
      lock:()=>({owner:current,status:'alive' as const}),
      status:()=>JSON.parse(readFileSync(f.file+'.schedule/scheduler.json','utf8')),
    });
    const controller=new AbortController(),running=worker.run(controller.signal,{processes:()=>[]});
    try{
      // Wait until the long first run has actually started; scheduler.json was
      // published on the startup evaluation before this run began.
      await vi.waitFor(()=>expect(execute).toHaveBeenCalled());
      await expect(a.confirm(APPS[1],null)).resolves.toBe(true);
    }finally{release();controller.abort();await running;}
  }finally{f.close();}
});
test('watchdog state prunes resolved faults after seven days but retains open faults',async()=>{
  const h=harness();try{
    const s=h.read(),old=h.now()-8*86400000;s.faults=[{app:null,code:'missing_slot',first_at:old,last_at:old,resolved_at:old},{app:null,code:'last_success_stale',first_at:old,last_at:old,resolved_at:null}];writePrivate(h.path,s);
    h.adapters.findings=async()=>[{code:'last_success_stale'}];await watchdog(h.path,h.adapters);expect(h.read().faults.filter(f=>f.app===null).map(f=>f.code)).toEqual(['last_success_stale']);expect(readFileSync(h.path,'utf8')).not.toContain('missing_slot');
  }finally{h.close();}
});
