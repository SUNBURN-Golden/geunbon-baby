import { expect, test, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { monitor } from '../crawler/src/collector-monitor';
import { ScheduleState } from '../crawler/src/schedule-state';
import { ScheduleWorker, scheduleHash } from '../crawler/src/schedule-worker';
import { dueSlots, loadSchedule } from '../crawler/src/collection-schedule';
import { runCollectorJob } from '../crawler/src/collector-job';
import { identity } from '../crawler/src/process-identity';
import { config } from '../crawler/src/source-policy';
import { fixture } from './helpers/collector';
const at=(s:string)=>Date.parse(`2026-11-06T${s}+09:00`);
const quiet={log:()=>{},output:()=>{}};
function schedulerStatus(now:number,schedules=loadSchedule()) {return {schema_version:1,started_at:now-180000,identity:identity(),revision:'a'.repeat(40),config_hash:scheduleHash(schedules),heartbeat:now,evaluations:Object.fromEntries(schedules.map(s=>[s.job,now])),current_call_id:null,waiting:null,progress_at:now};}
test('previous-day watermark merges exactly three missed slots, preserving immutable slot ownership on every later tick',async()=>{
  for(const job of ['discover','collect'] as const){
    const f=fixture();try{
      const s=loadSchedule().find(s=>s.job===job)!,state=new ScheduleState(f.store),yesterday=dueSlots(s,at('22:10:00')-86400000)!;
      const old=state.create(job,yesterday,null);state.update(old.id,'succeeded','completed',null,f.now());f.advance(at('22:10:00')-f.now());
      const execute=vi.fn(async()=>({})),def={create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded' as const,reason:'completed'})})};
      await runCollectorJob(f.store,s,def,quiet);f.reopen();await runCollectorJob(f.store,s,def,quiet);await runCollectorJob(f.store,s,def,quiet);
      expect(execute).toHaveBeenCalledTimes(1);const rows=f.store.db.prepare('SELECT slot_count FROM collection_schedule_runs ORDER BY rowid').all();expect(rows).toMatchObject([{slot_count:1},{slot_count:3}]);
    }finally{f.close();}
  }
});
test('monitor separates missing current slot from stale success, validates merged ranges, and ignores disabled schedules',()=>{
  const f=fixture();try{
    const now=at('22:10:00'),schedules=loadSchedule(),s=schedules[0],state=new ScheduleState(f.store);
    const old=state.create(s.job,dueSlots(s,now-86400000),null);state.update(old.id,'succeeded','completed',null,now-86400000);
    let findings=monitor(f.store.db,schedules,now,schedulerStatus(now));expect(findings).toContainEqual({job:'discover',code:'missing_slot'});expect(findings.some(f=>f.job==='discover'&&f.code==='last_success_stale')).toBe(true);
    expect(findings.filter(f=>f.code==='missing_slot').map(f=>f.job)).toEqual(['discover','collect']);
    const batch=dueSlots(s,now,old.target_slot!)!,run=state.create(s.job,batch,null);state.update(run.id,'pending','checkpoint_wait',now+60000);
    findings=monitor(f.store.db,schedules,now,schedulerStatus(now));expect(findings.some(f=>f.job==='discover'&&f.code==='missing_slot')).toBe(false);expect(findings.some(f=>f.job==='discover'&&f.code==='last_success_stale')).toBe(true);expect(findings).toContainEqual({job:'discover',code:'waiting_deadline',next_at:now+60000});
    expect(monitor(f.store.db,schedules,now,{...schedulerStatus(now),config_hash:'bad'})).toEqual([{code:'schedule_config_mismatch'}]);
    expect(monitor(f.store.db,schedules,now,{...schedulerStatus(now),heartbeat:now-180000})).toContainEqual({code:'stale_scheduler'});
  }finally{f.close();}
});
test('lock contention is an evaluated call without consuming a slot or pretending success',async()=>{
  const f=fixture();try{
    const s=loadSchedule()[0],state=new ScheduleState(f.store);f.advance(at('22:10:00')-f.now());
    const lock=await f.store.waitForRunLock('crawl');expect(lock.acquired).toBe(true);let t=0;const output:string[]=[];
    const def={create:()=>({enabled:true,run:async()=>({})})};
    await runCollectorJob(f.store,s,def,{...quiet,output:l=>output.push(l),lock:{monotonicNow:()=>t,sleep:async ms=>{t+=ms;}}});
    const call=f.store.db.prepare('SELECT * FROM collection_schedule_calls').get()!;expect(call.expected_slot).toBe(dueSlots(s,f.now())!.target);expect(call.schedule_version).toBe(dueSlots(s,f.now())!.version);expect(state.watermark(s.job)).toBeUndefined();
    expect(output.map(l=>JSON.parse(l).event)).toEqual(['start','result']);expect(JSON.parse(output[1])).toMatchObject({generated_at:new Date(f.now()).toISOString(),outcome:'skipped',counts:{engine:null,invocation:null}});
    const findings=monitor(f.store.db,loadSchedule(),f.now(),schedulerStatus(f.now()));expect(findings).toContainEqual({job:'discover',code:'slot_waiting_lock'});expect(findings.some(f=>f.job==='discover'&&f.code==='missing_slot')).toBe(false);
  }finally{f.close();}
});
test('long-running work continues heartbeat/evaluation output without starting another runner',async()=>{
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const controller=new AbortController(),lines:string[]=[],execute=vi.fn(async()=>{await gate;return {};});
  const worker=new ScheduleWorker(f.store,()=>({create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded',reason:'completed'})})}),[loadSchedule()[0]],{...quiet,output:l=>lines.push(l)});
  vi.useFakeTimers();
  try{
    const running=worker.run(controller.signal);await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1));
    f.advance(180000);await vi.advanceTimersByTimeAsync(180000);
    expect(execute).toHaveBeenCalledTimes(1);expect(lines.map(l=>JSON.parse(l)).filter(e=>e.event==='scheduler_heartbeat').length).toBeGreaterThanOrEqual(3);
    const status=JSON.parse(readFileSync(f.file+'.schedule/scheduler.json','utf8'));expect(status.current_call_id).toMatch(/^[a-f0-9-]{36}$/);expect(status.evaluations.discover).toBe(f.now());
    expect(f.store.db.prepare("SELECT count(*) n FROM collection_schedule_calls WHERE reason='slot_waiting_active_run'").get()!.n).toBe(3);
    controller.abort();release();await running;expect(lines.map(l=>JSON.parse(l)).some(e=>e.outcome==='succeeded'&&e.generated_at)).toBe(true);
  }finally{release();controller.abort();vi.useRealTimers();f.close();}
});
test('stdout and summary publication failures cannot change committed results or repeat collection',async()=>{
  const f=fixture();try{
    const execute=vi.fn(async()=>({state:'finished',url:'private-secret'})),def={create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded' as const,reason:'completed'})})},state=new ScheduleState(f.store);
    let fail=false;const original=ScheduleState.prototype.writeSummary;vi.spyOn(ScheduleState.prototype,'writeSummary').mockImplementation(function(this:ScheduleState,job){if(fail)throw new Error('private-secret');return original.call(this,job);});vi.spyOn(console,'error').mockImplementation(()=>{});
    expect(await runCollectorJob(f.store,loadSchedule()[0],def,{...quiet,fault:p=>{if(p==='after_result')fail=true;},output:()=>{throw new Error('private-secret');}})).toMatchObject({outcome:'succeeded'});
    await runCollectorJob(f.store,loadSchedule()[0],def,quiet);expect(execute).toHaveBeenCalledTimes(1);expect(state.summary('discover').last_success_slot).not.toBeNull();expect(f.store.db.prepare('SELECT outcome FROM collection_schedule_calls ORDER BY rowid LIMIT 1').get()!.outcome).toBe('succeeded');
  }finally{f.close();}
});
test.each(['local-worker.mjs','collector-scheduler.mjs'])('actual JS %s entry emits generated_at on initialization errors without exception/config secrets',entry=>{
  const f=fixture();try{
    const cfg=join(f.dir,'invalid.json');writeFileSync(cfg,'{"secret":"credential-private-secret", invalid');
    const result=spawnSync(process.execPath,['--import','tsx',`crawler/${entry}`,entry.includes('scheduler')?'schedule':'discover'],{encoding:'utf8',timeout:10000,env:{...process.env,COLLECTOR_CONFIG:cfg}});
    expect(result.status).toBe(1);expect(result.stdout+result.stderr).not.toContain('private-secret');expect(result.stdout+result.stderr).not.toContain(cfg);
    const events=result.stdout.trim().split('\n').map(l=>JSON.parse(l));expect(events).toHaveLength(2);expect(events.every(e=>/^\d{4}-.*Z$/.test(e.generated_at))).toBe(true);expect(events.at(-1)).toMatchObject({outcome:'failed',reason:'initialization_failed',counts:{engine:null,invocation:null}});
  }finally{f.close();}
});
test('untracked CLI initialization failure keeps a redacted fixed code on stderr',()=>{
  const f=fixture();try{
    const cfg=join(f.dir,'invalid.json');writeFileSync(cfg,'{"secret":"credential-private-secret", invalid');
    const result=spawnSync(process.execPath,['--import','tsx','crawler/local-worker.mjs','engine-status'],{encoding:'utf8',timeout:10000,env:{...process.env,COLLECTOR_CONFIG:cfg}});
    expect(result.status).toBe(1);expect(result.stdout).toBe('');
    expect(result.stderr).toContain('collector_failed code=internal_error');
    expect(result.stdout+result.stderr).not.toContain('private-secret');expect(result.stdout+result.stderr).not.toContain(cfg);
  }finally{f.close();}
});
test('tracked CLI initialization failure surfaces the fixed code without leaking secrets',()=>{
  const f=fixture();try{
    const result=spawnSync(process.execPath,['--import','tsx','crawler/local-worker.mjs','collect'],{encoding:'utf8',timeout:10000,env:{...process.env,COLLECTOR_DB:'',COLLECTOR_CONFIG:''}});
    expect(result.status).toBe(1);
    const events=result.stdout.trim().split('\n').map(l=>JSON.parse(l));expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({outcome:'failed',reason:'initialization_failed',diagnostics:['call_history_unavailable','collector_failed code=engine_paths_required']});
  }finally{f.close();}
});
test('synthetic waiting rows do not shadow the last real summary invocation and are reported by the monitor',()=>{
  const f=fixture();try{
    const now=at('22:10:00'),schedules=loadSchedule(),s=schedules[0],state=new ScheduleState(f.store);
    f.advance(now-f.now());const slot=dueSlots(s,now)!;
    const real=randomUUID();state.call(real,s.job,'scheduled','new',now-60000,undefined,slot);state.endCall(real,'succeeded','completed');
    const synthetic=randomUUID();state.call(synthetic,s.job,'scheduled','skip',now,undefined,slot);state.endCall(synthetic,'skipped','slot_waiting_active_run');
    expect(state.summary(s.job).call).toMatchObject({id:real,outcome:'succeeded'});
    expect(monitor(f.store.db,schedules,now,schedulerStatus(now))).toContainEqual({job:s.job,code:'slot_waiting_active_run',status:'skipped'});
  }finally{f.close();}
});
test('an idle scheduler tick records evaluations without inserting an already_completed call',async()=>{
  const f=fixture();try{
    const execute=vi.fn(async()=>({}));
    const worker=new ScheduleWorker(f.store,()=>({create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded' as const,reason:'completed'})})}),[loadSchedule()[0]],quiet);
    await worker.tick();const calls=f.store.db.prepare('SELECT count(*) n FROM collection_schedule_calls').get()!.n;expect(calls).toBe(1);
    await worker.tick();expect(f.store.db.prepare('SELECT count(*) n FROM collection_schedule_calls').get()!.n).toBe(calls);
    const {evaluations}=JSON.parse(readFileSync(f.file+'.schedule/scheduler.json','utf8'));expect(evaluations.discover).toBeTypeOf('number');
  }finally{f.close();}
});
test('actual resident scheduler entry produces slot results before shutdown with all sources disabled',async()=>{
  const f=fixture(),cfg=join(f.dir,'disabled.json');writeFileSync(cfg,JSON.stringify({...config,sources:config.sources.map(s=>({...s,enabled:false}))}));
  const guard='data:text/javascript,'+encodeURIComponent(`import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw new Error('transport_forbidden');};net.Socket.prototype.connect=deny;http.request=deny;https.request=deny;globalThis.fetch=deny;syncBuiltinESMExports();`);
  const child=spawn(process.execPath,['--import',guard,'--import','tsx','crawler/collector-scheduler.mjs','schedule'],{env:{...process.env,COLLECTOR_DB:f.file,COLLECTOR_CONFIG:cfg,COLLECTOR_RAW_DIR:join(f.dir,'raw'),COLLECTOR_TRUSTED_EGRESS_CIDRS:''},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',v=>{out+=v;});child.stderr.on('data',v=>{err+=v;});const exited=once(child,'exit');
  try{
    await vi.waitFor(()=>expect(out).toMatch(/"job":"collect"[^\n]+"outcome":"disabled"/),{timeout:10000});expect(child.exitCode,err).toBeNull();
    const events=out.trim().split('\n').map(l=>JSON.parse(l));expect(events.some(e=>e.job==='discover'&&e.event==='result'&&e.generated_at&&e.outcome==='disabled')).toBe(true);expect(events.some(e=>e.job==='collect'&&e.event==='result'&&e.generated_at&&e.outcome==='disabled')).toBe(true);
    child.kill('SIGTERM');await exited;expect(child.exitCode).toBe(0);
  }finally{if(child.exitCode===null){child.kill('SIGKILL');await exited;}f.close();}
},15000);
test('watchdog flock serializes manual invocations and installation marker prevents resetting a lost state',async()=>{
  const f=fixture(),env={...process.env,COLLECTOR_DB:f.file};
  try{
    const init=spawnSync('crawler/collector-watchdog.sh',['--init'],{env,encoding:'utf8',timeout:10000});expect(init.status,init.stderr).toBe(0);expect(f.store.get('collector_meta','watchdog_initialized')).toBe(true);
    const locked=spawn('flock',['--no-fork',f.file+'.watchdog.flock',process.execPath,'-e',"process.stdout.write('locked\\n');setTimeout(()=>{},30000)"],{stdio:['ignore','pipe','pipe']});const stopped=once(locked,'exit');
    try{
      await once(locked.stdout,'data');const blocked=spawnSync('crawler/collector-watchdog.sh',[],{env,encoding:'utf8',timeout:5000});expect(blocked.status).toBe(0);expect(blocked.stdout).toBe('');
    }finally{locked.kill('SIGTERM');await stopped;}
    unlinkSync(f.file+'.watchdog/state.json');const retry=spawnSync('crawler/collector-watchdog.sh',['--init'],{env,encoding:'utf8',timeout:10000});expect(retry.status).toBe(1);expect(retry.stdout).toContain('watchdog_unavailable');
  }finally{f.close();}
},20000);

test('discover event counts measure this invocation rather than cumulative report totals',async()=>{
  const { RunHealth }=await import('../crawler/src/discovery/health');
  const { DiscoveryRunner }=await import('../crawler/src/discovery/run');
  const { jobDefinition }=await import('../crawler/src/collector-runners');
  const f=fixture();try{
    const health=new RunHealth();health.source('fixture','run');health.pageOk('fixture',{kind:'listing',links_found:3,parsed:2,eligible:1,price_checked:0,price_hints:0});health.sent('fixture');health.pageFailed('fixture','network_error');health.subrequestFailed('fixture','network_error');health.subrequestFailed('fixture','network_error');
    const sources=health.finish(new Map([['fixture',{source_blocked:3}]]),new Map([['fixture','links']]));
    vi.spyOn(DiscoveryRunner.prototype,'run').mockResolvedValue({mode:'run',status:'review',sources,review:['fixture']});const lines:string[]=[];
    await runCollectorJob(f.store,loadSchedule()[0],jobDefinition(f.store,'discover'),{...quiet,output:l=>lines.push(l)});
    const result=JSON.parse(lines.at(-1)!);expect(result).toMatchObject({outcome:'partial_failure',reason:'transport_failed',counts:{engine:null,invocation:{pages_attempted:2,pages_ok:1,pages_failed:1,blocked_requests:3,parsed_items:2,eligible_items:1,submissions_accepted:1,subrequest_failures:2,sources_review:1}}});
    expect(f.store.db.prepare('SELECT counts FROM collection_schedule_calls').get()!.counts).toBe(JSON.stringify(result.counts));expect(JSON.stringify(result)).not.toContain('https://');
  }finally{f.close();}
});

test('watchdog shell preflight does not leak paths or exception values',()=>{
  const result=spawnSync('crawler/collector-watchdog.sh',[],{encoding:'utf8',env:{...process.env,COLLECTOR_DB:'/missing/credential-private-secret/collector.sqlite'},timeout:5000});
  expect(result.status).toBe(1);expect(result.stdout+result.stderr).not.toContain('private-secret');expect(result.stdout).toContain('watchdog_preflight_failed');
});
