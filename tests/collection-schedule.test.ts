import { expect, test, vi } from 'vitest';
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dueSlots, kstTime, loadSchedule, validateSchedule, type JobSchedule } from '../crawler/src/collection-schedule';
import { runCollectorJob, type JobDefinition, type JobOptions } from '../crawler/src/collector-job';
import { collectAdapter } from '../crawler/src/collector-runners';
import { ScheduleState } from '../crawler/src/schedule-state';
import { ScheduleWorker } from '../crawler/src/schedule-worker';
import { acquireRunLock } from '../crawler/src/run-lock';
import { CollectorStore } from '../crawler/src/store';
import { engineProgress } from '../crawler/engine/progress';
import { asset, engineFixture } from './helpers/engine';
import { fixture } from './helpers/collector';
const schedule=loadSchedule().find(s=>s.job==='collect')!;
const at=(s:string)=>Date.parse(`2026-10-23T${s}+09:00`);
const move=(f:{now:()=>number;advance:(n:number)=>void},n:number)=>f.advance(n-f.now());
const rows=(f:{store:CollectorStore},table:string)=>f.store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];
const silent={log:()=>{}};
const quickLock=()=>{let t=0;return {monotonicNow:()=>t,sleep:async(ms:number)=>{t+=ms;}};};
function job(f:ReturnType<typeof engineFixture>,options:JobOptions={}){return runCollectorJob(f.store,schedule,{profileId:f.profile.id,create:()=>collectAdapter(f.pipeline)},{...silent,...options});}

test('normal boundary, one missed slot, many missed days, initial adoption and backward clocks use KST wall time',()=>{
  const first=dueSlots(schedule,at('09:40:00'))!;expect(first).toMatchObject({first:at('09:40:00'),target:at('09:40:00'),count:1});
  expect(dueSlots(schedule,at('15:39:59'),first.target)).toBeUndefined();
  expect(dueSlots(schedule,at('15:40:00'),first.target)).toMatchObject({first:at('15:40:00'),count:1});
  expect(dueSlots(schedule,at('21:50:00')+3*86400000,first.target)).toMatchObject({first:at('15:40:00'),target:at('21:40:00')+3*86400000,count:11});
  expect(dueSlots(schedule,at('21:50:00')+1000*86400000)?.count).toBe(1);
  expect(dueSlots(schedule,at('09:00:00'),first.target)).toBeUndefined();
  expect(dueSlots(schedule,at('00:00:00'))?.target).toBe(at('21:40:00')-86400000);
  vi.stubEnv('TZ','UTC');expect(kstTime(at('09:40:00'))).toBe('2026-10-23T09:40:00.000+09:00');
  expect(dueSlots(schedule,at('15:40:00'),first.target)?.target).toBe(at('15:40:00'));
});
test('configuration rejects unknown/duplicate jobs, empty or invalid times without enabling sources',()=>{
  for(const alter of [(s:JobSchedule[])=>s[0].times.push('24:00'),(s:JobSchedule[])=>s[0].times.push('09:20'),(s:JobSchedule[])=>{s[0].times=[];},(s:JobSchedule[])=>{s[0].job=s[1].job;}]){
    const jobs=loadSchedule();alter(jobs);expect(()=>validateSchedule({jobs})).toThrow('schedule_config');
  }
  expect(loadSchedule().filter(s=>s.enabled).map(s=>s.job)).toEqual(['discover','collect']);
});
test('morning and afternoon manual calls fetch separate runs; repeating a completed slot preserves success time',async()=>{
  const f=engineFixture();try{
    move(f,at('09:40:00'));const morning=await job(f);expect(morning.outcome).toBe('succeeded');const captures=rows(f,'engine_captures').length;
    move(f,at('15:40:00'));const afternoon=await job(f);expect(afternoon.outcome).toBe('succeeded');expect(afternoon.run_id).not.toBe(morning.run_id);expect(rows(f,'engine_captures')).toHaveLength(captures+1);
    const before=new ScheduleState(f.store).summary('collect'),calls=f.calls.length;f.advance(60000);
    expect((await job(f,{source:'scheduled'})).outcome).toBe('already_completed');expect(f.calls).toHaveLength(calls);
    const after=new ScheduleState(f.store).summary('collect');expect(after.last_success_at).toBe(before.last_success_at);expect(after.last_success_slot).toBe(kstTime(at('15:40:00')));
  }finally{f.close();}
});
test.each(['manual','scheduled'] as const)('%s wins a concurrent slot with exactly one logical run and capture',async source=>{
  const f=engineFixture();try{
    move(f,at('15:40:00'));let entered!:()=>void,release!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const original=f.pipeline.handlers.fetch.run;f.pipeline.handlers.fetch.run=async c=>{entered();await gate;return original(c);};
    const winner=job(f,{source});await ready;
    const loser=await job(f,{source:source==='manual'?'scheduled':'manual',lock:quickLock()});expect(loser.reason).toBe('run_locked');expect(rows(f,'collection_schedule_runs')).toHaveLength(1);
    release();expect((await winner).outcome).toBe('succeeded');await job(f,{source:'scheduled'});
    expect(rows(f,'engine_captures')).toHaveLength(1);expect(rows(f,'collection_schedule_runs')).toHaveLength(1);
  }finally{f.close();}
});
test('many missed slots merge once after a long suspension; changed schedules and clock rollback keep ownership',async()=>{
  const f=engineFixture();try{
    move(f,at('09:40:00'));await job(f);move(f,at('21:41:00')+4*86400000);await job(f,{source:'scheduled'});
    const runs=rows(f,'collection_schedule_runs');expect(runs).toHaveLength(2);expect(runs[1].slot_count).toBe(14);
    const count=f.calls.length;move(f,at('15:40:00'));await job(f);expect(f.calls).toHaveLength(count);
    const changed={...schedule,times:['09:30','15:30','21:30']};await runCollectorJob(f.store,changed,{profileId:f.profile.id,create:()=>collectAdapter(f.pipeline)},silent);expect(f.calls).toHaveLength(count);
    expect(()=>f.store.db.prepare('UPDATE collection_schedule_runs SET target_slot=target_slot+1').run()).toThrow('immutable_schedule_ownership');
  }finally{f.close();}
});
test('living crawl owner makes no claim or runner call and runs once after release',async()=>{
  const f=engineFixture();try{
    const lock=acquireRunLock(f.store,'crawl');const create=vi.fn(()=>collectAdapter(f.pipeline));
    try{expect((await runCollectorJob(f.store,schedule,{profileId:f.profile.id,create},{...silent,lock:quickLock()})).reason).toBe('run_locked');expect(create).not.toHaveBeenCalled();expect(rows(f,'collection_schedule_runs')).toHaveLength(0);}finally{lock.release();}
    expect((await job(f)).outcome).toBe('succeeded');expect(rows(f,'collection_schedule_runs')).toHaveLength(1);
  }finally{f.close();}
});
test('completed daily ID and explicit resume do not credit the latest slot; dry-run never adopts an active engine',async()=>{
  const f=engineFixture();try{
    const daily=f.pipeline.start();f.pipeline.seed(daily);await f.pipeline.run(daily);const calls=f.calls.length;
    expect((await job(f,{resumeId:daily})).outcome).toBe('already_completed');expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();expect(rows(f,'collection_schedule_runs')).toHaveLength(0);
    expect((await job(f)).run_id).not.toBe(daily);expect(f.calls.length).toBeGreaterThan(calls);
    move(f,at('15:40:00'));f.response(()=>{throw new Error('network_error');});const active=await job(f);expect(active.outcome).toBe('pending');const before=rows(f,'collection_schedule_runs');
    expect((await job(f,{dryRun:true})).outcome).toBe('dry_run');expect(rows(f,'collection_schedule_runs')).toEqual(before);
  }finally{f.close();}
});
test('a start adapter returning an old completed ID cannot attach it to the current slot',async()=>{
  const f=engineFixture();try{
    const old=f.pipeline.start();f.pipeline.seed(old);await f.pipeline.run(old);
    await expect(runCollectorJob(f.store,schedule,{profileId:f.profile.id,create:()=>({...collectAdapter(f.pipeline),start:()=>old})},silent)).rejects.toThrow('engine_identity_conflict');
    expect(rows(f,'collection_schedule_runs')[0]).toMatchObject({engine_id:null,status:'intent'});expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
    expect((await job(f)).outcome).toBe('succeeded');
  }finally{f.close();}
});
test('retry_wait skips transport and attempts before deadline, then resumes the same engine/checkpoint/slot',async()=>{
  const f=engineFixture(undefined,{}, {rng:()=>0});try{
    move(f,at('09:40:00'));f.response(()=>{throw new Error('network_error');});const first=await job(f);expect(first.outcome).toBe('pending');
    const ck=rows(f,'engine_checkpoints').find(c=>c.phase==='retry_wait')!,calls=f.calls.length;expect(ck.attempts).toBe(1);expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
    f.reopen();move(f,Number(ck.next_at)-1);expect((await job(f)).outcome).toBe('pending');expect(f.calls).toHaveLength(calls);expect(rows(f,'engine_checkpoints').find(c=>c.id===ck.id)?.attempts).toBe(1);
    f.response(()=>({status:200,headers:{'content-type':'text/html'},body:asset('spec.html')}));move(f,Number(ck.next_at));
    const resumed=await job(f);expect(resumed).toMatchObject({outcome:'succeeded',run_id:first.run_id});expect(rows(f,'engine_checkpoints').find(c=>c.id===ck.id)).toMatchObject({phase:'done',attempts:1});expect(rows(f,'collection_schedule_runs')[0].target_slot).toBe(at('09:40:00'));
  }finally{f.close();}
});
test('a previous run resumed after a later slot only succeeds its original slot; next tick claims the new slot',async()=>{
  const f=engineFixture(undefined,{}, {rng:()=>0});try{
    move(f,at('09:40:00'));f.response(()=>{throw new Error('network_error');});const a=await job(f);move(f,at('15:50:00'));
    f.response(()=>({status:200,headers:{'content-type':'text/html'},body:asset('spec.html')}));expect((await job(f)).run_id).toBe(a.run_id);
    expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBe(kstTime(at('09:40:00')));expect(rows(f,'collection_schedule_runs')).toHaveLength(1);
    const b=await job(f);expect(b.run_id).not.toBe(a.run_id);expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBe(kstTime(at('15:40:00')));
  }finally{f.close();}
});
test('legacy active engines remain unassigned after recovery, followed by a new current-slot execution',async()=>{
  const f=engineFixture();try{
    const old=f.pipeline.start();f.pipeline.seed(old);const result=await job(f);expect(result).toMatchObject({run_id:old,reason:'legacy_unassigned'});expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
    expect((await job(f)).run_id).not.toBe(old);expect(rows(f,'collection_schedule_runs')).toHaveLength(2);
  }finally{f.close();}
});
test.each([undefined,'explicit'] as const)('an interrupted intent survives separate failure retry recovery (%s resume)',async mode=>{
  const f=engineFixture();try{
    const failed=f.pipeline.start();f.pipeline.seed(failed);
    f.response(()=>{throw new Error('payload_shape');});await f.pipeline.run(failed);
    const checkpoint=rows(f,'engine_checkpoints').find(c=>c.phase==='failed')!;
    move(f,at('09:40:00'));
    await expect(job(f,{fault:point=>{if(point==='before_engine_start')throw new Error('injected');}})).rejects.toThrow('injected');
    const intent=rows(f,'collection_schedule_runs')[0];
    const retry=f.pipeline.engine.retryFailure(String(checkpoint.id));
    f.response(()=>({status:200,headers:{'content-type':'text/html'},body:asset('spec.html')}));
    f.reopen();move(f,at('15:50:00'));
    const execute=vi.spyOn(f.pipeline,'run'),seed=vi.spyOn(f.pipeline,'seed');
    const result=await job(f,mode?{resumeId:retry}:{});
    expect(result).toMatchObject({outcome:'succeeded',run_id:retry,reason:'legacy_unassigned'});
    expect(execute).toHaveBeenCalledExactlyOnceWith(retry);expect(seed).not.toHaveBeenCalled();
    expect(rows(f,'collection_schedule_runs').find(r=>r.id===intent.id)).toEqual(intent);
    expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
    expect(rows(f,'collection_schedule_runs').find(r=>r.engine_id===retry)).toMatchObject({target_slot:null,slot_count:0,engine_origin:'legacy_unassigned'});
    // The next invocation recovers the original intent, without moving it to the afternoon slot.
    expect(await job(f)).toMatchObject({outcome:'succeeded',run_id:intent.engine_key});
    expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBe(kstTime(at('09:40:00')));
    expect(new ScheduleState(f.store).summary('collect').run).toMatchObject({id:intent.id,status:'succeeded'});
    expect(await job(f)).toMatchObject({outcome:'succeeded'});
    expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBe(kstTime(at('15:40:00')));
    expect(execute).toHaveBeenCalledTimes(3);expect(rows(f,'engine_captures')).toHaveLength(3);
    expect(rows(f,'engine_runs')).toHaveLength(4);
  }finally{f.close();}
});
test('isolated recovery waits and survives restart ahead of its parked intent, retaining crawl and DB exclusion',async()=>{
  const f=engineFixture(undefined,{}, {rng:()=>0});try{
    const failed=f.pipeline.start();f.pipeline.seed(failed);
    f.response(()=>{throw new Error('payload_shape');});await f.pipeline.run(failed);
    const checkpoint=rows(f,'engine_checkpoints').find(c=>c.phase==='failed')!;
    await expect(job(f,{fault:point=>{if(point==='after_claim')throw new Error('injected');}})).rejects.toThrow('injected');
    const intent=rows(f,'collection_schedule_runs')[0],retry=f.pipeline.engine.retryFailure(String(checkpoint.id));
    const lock=acquireRunLock(f.store,'crawl');
    try{expect(await job(f,{lock:quickLock()})).toMatchObject({outcome:'skipped',reason:'run_locked'});expect(rows(f,'collection_schedule_runs')).toEqual([intent]);}finally{lock.release();}
    f.response(()=>{throw new Error('network_error');});
    expect(await job(f)).toMatchObject({outcome:'pending',run_id:retry});
    const recovery=rows(f,'collection_schedule_runs').find(r=>r.engine_id===retry)!,calls=f.calls.length;
    const retryCheckpoint=rows(f,'engine_checkpoints').find(c=>c.run_id===retry&&c.phase==='retry_wait')!;
    // A second slot intent and a second active recovery are both forbidden.
    const state=new ScheduleState(f.store);
    expect(()=>state.create('collect',dueSlots(schedule,at('15:40:00'),Number(intent.target_slot)),null)).toThrow('UNIQUE constraint failed');
    expect(()=>state.adopt('collect',failed)).toThrow('UNIQUE constraint failed');
    expect(()=>f.store.db.prepare('UPDATE collection_schedule_runs SET engine_id=? WHERE id=?').run(failed,String(intent.id))).toThrow('UNIQUE constraint failed');
    f.reopen();move(f,Number(retryCheckpoint.next_at)-1);
    const execute=vi.spyOn(f.pipeline,'run');
    expect(await job(f)).toMatchObject({outcome:'pending',run_id:retry});expect(execute).not.toHaveBeenCalled();expect(f.calls).toHaveLength(calls);
    expect(rows(f,'engine_checkpoints').find(c=>c.id===retryCheckpoint.id)).toEqual(retryCheckpoint);
    expect(new ScheduleState(f.store).active('collect')?.id).toBe(recovery.id);
    f.response(()=>({status:200,headers:{'content-type':'text/html'},body:asset('spec.html')}));move(f,Number(retryCheckpoint.next_at));
    expect(await job(f,{resumeId:retry})).toMatchObject({outcome:'succeeded',run_id:retry,reason:'legacy_unassigned'});
    expect(rows(f,'collection_schedule_runs').find(r=>r.id===intent.id)).toEqual(intent);
    expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
    expect(await job(f)).toMatchObject({outcome:'succeeded',run_id:intent.engine_key});
    expect(rows(f,'engine_runs')).toHaveLength(3);expect(rows(f,'engine_captures')).toHaveLength(2);
  }finally{f.close();}
});
test('an exhausted isolated retry cannot use a parked intent to bypass the same-day budget gate',async()=>{
  const f=engineFixture();try{
    const failed=f.pipeline.start();f.pipeline.seed(failed);
    f.response(()=>{throw new Error('payload_shape');});await f.pipeline.run(failed);
    const checkpoint=rows(f,'engine_checkpoints').find(c=>c.phase==='failed')!;
    await expect(job(f,{fault:point=>{if(point==='after_claim')throw new Error('injected');}})).rejects.toThrow('injected');
    const intent=rows(f,'collection_schedule_runs')[0],retry=f.pipeline.engine.retryFailure(String(checkpoint.id));
    // Retry inherits the failed run's persisted execution budget.
    f.store.db.prepare("UPDATE engine_costs SET cap=spent WHERE scope=? AND kind='requests'").run(`run:${failed}`);f.reopen();
    expect(await job(f)).toMatchObject({outcome:'exhausted',run_id:retry});const calls=f.calls.length;
    expect(await job(f)).toMatchObject({outcome:'exhausted',reason:'next_day_required'});
    expect(rows(f,'collection_schedule_runs').find(r=>r.id===intent.id)).toEqual(intent);expect(rows(f,'engine_runs')).toHaveLength(2);expect(f.calls).toHaveLength(calls);
    move(f,at('00:00:00')+86400000);f.profile.cost_caps.run.requests=100;f.reopen();
    f.response(()=>({status:200,headers:{'content-type':'text/html'},body:asset('spec.html')}));
    expect(await job(f)).toMatchObject({outcome:'succeeded',run_id:intent.engine_key});
    expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBe(kstTime(Number(intent.target_slot)));
    expect(rows(f,'engine_checkpoints').some(c=>JSON.parse(String(c.data)).carried_from)).toBe(true);
  }finally{f.close();}
});
test('maximum retry attempts yield partial failure and never create another engine for the same slot',async()=>{
  const f=engineFixture(undefined,{}, {rng:()=>0});try{
    f.response(()=>{throw new Error('network_error');});let result=await job(f);
    for(let i=0;i<2;i++){const c=rows(f,'engine_checkpoints').find(c=>c.phase==='retry_wait')!;move(f,Number(c.next_at));result=await job(f);}
    expect(result.outcome).toBe('partial_failure');expect(rows(f,'engine_checkpoints').find(c=>c.phase==='failed')?.attempts).toBe(3);
    const calls=f.calls.length;await job(f);expect(f.calls).toHaveLength(calls);expect(rows(f,'engine_runs')).toHaveLength(1);expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
  }finally{f.close();}
});
test('unexpired lease survives restart; expired external lease recovers receipt without duplicate budget, outbox or attempts',async()=>{
  let armed=true;const f=engineFixture(undefined,{}, {fault:p=>{if(armed&&p==='after_external_commit'){armed=false;throw new Error('injected');}}});try{
    await expect(job(f)).rejects.toThrow('engine_crash');const run=rows(f,'collection_schedule_runs')[0];const ck=rows(f,'engine_checkpoints').find(c=>c.phase==='leased')!;
    const before=['intake_receipts','daily_budgets','sync_outbox','engine_costs'].map(t=>rows(f,t)),calls=f.calls.length;
    f.reopen();const recover=vi.spyOn(f.pipeline.handlers.service,'recover'),execute=vi.spyOn(f.pipeline.handlers.service,'run');
    move(f,Number(ck.lease_until)-1);expect((await job(f)).outcome).toBe('pending');expect(recover).not.toHaveBeenCalled();expect(f.calls).toHaveLength(calls);
    move(f,Number(ck.lease_until));expect((await job(f))).toMatchObject({outcome:'succeeded',run_id:run.engine_id});expect(recover).toHaveBeenCalledTimes(1);expect(execute).not.toHaveBeenCalled();expect(['intake_receipts','daily_budgets','sync_outbox','engine_costs'].map(t=>rows(f,t))).toEqual(before);
    expect(rows(f,'engine_checkpoints').find(c=>c.id===ck.id)).toMatchObject({phase:'done',attempts:0});
  }finally{f.close();}
});
test('cost_wait before midnight resumes the same original run after midnight without reseeding',async()=>{
  const f=engineFixture();try{
    move(f,at('21:40:00'));f.store.settings.limits.new_body=0;const first=await job(f);expect(first.outcome).toBe('pending');expect(f.pipeline.engine.run(first.run_id!)?.state).toBe('cost_wait');
    const next=engineProgress(f.store,first.run_id!).nextAt!,seed=vi.spyOn(f.pipeline,'seed');move(f,next-1);expect((await job(f)).outcome).toBe('pending');expect(f.calls).toHaveLength(0);
    f.store.settings.limits.new_body=100;move(f,next);expect((await job(f))).toMatchObject({run_id:first.run_id,outcome:'succeeded'});expect(seed).not.toHaveBeenCalled();expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBe(kstTime(at('21:40:00')));
  }finally{f.close();}
});
test('exhaustion blocks same-day slot budget bypass; next KST day carries attempts and ancestors',async()=>{
  const f=engineFixture();try{
    f.profile.cost_caps.run.requests=0;f.reopen();move(f,at('09:40:00'));const first=await job(f);expect(first.outcome).toBe('exhausted');
    const ck=rows(f,'engine_checkpoints').find(c=>c.stage==='fetch')!;f.store.db.prepare('UPDATE engine_checkpoints SET attempts=2 WHERE id=?').run(String(ck.id));
    move(f,at('15:40:00'));expect((await job(f)).reason).toBe('next_day_required');expect(rows(f,'engine_runs')).toHaveLength(1);
    move(f,at('00:00:00')+86400000);f.profile.cost_caps.run.requests=100;f.reopen();const next=await job(f);expect(next.run_id).not.toBe(first.run_id);expect(next.outcome).toBe('succeeded');
    const carried=rows(f,'engine_checkpoints').find(c=>JSON.parse(String(c.data)).carried_from===ck.id)!;expect(carried.attempts).toBe(2);expect(rows(f,'collection_schedule_runs')[1].slot_count).toBe(2);
  }finally{f.close();}
});
test.each(['before_claim','after_claim','before_engine_start','after_engine_start','after_engine_link','before_result','after_result'])('fault at %s recovers deterministic ownership without duplicate capture or fake completion time',async point=>{
  const f=engineFixture();try{
    let armed=true;const fault=(p:string)=>{if(armed&&p===point){armed=false;throw new Error('injected');}};
    await expect(job(f,{fault})).rejects.toThrow('injected');const old=rows(f,'engine_runs')[0],finished=old?.finished_at;
    f.advance(60000);f.reopen();await job(f);expect(rows(f,'engine_runs')).toHaveLength(1);expect(rows(f,'engine_captures')).toHaveLength(1);
    if(finished)expect(new ScheduleState(f.store).summary('collect').last_success_at).toBe(kstTime(Date.parse(String(finished))));
    expect(rows(f,'collection_schedule_runs')).toHaveLength(1);expect(rows(f,'collection_schedule_runs')[0].status).toBe('succeeded');
  }finally{f.close();}
});
test('interrupted non-engine work is recorded with observation time and is never automatically repeated',async()=>{
  const f=fixture();try{
    const s={...schedule,job:'discover'} as JobSchedule,execute=vi.fn(async()=>{throw new Error('credential=do-not-emit https://private.invalid');});const lines:string[]=[];
    const def:JobDefinition={create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded',reason:'completed'})})};
    await expect(runCollectorJob(f.store,s,def,{log:line=>lines.push(line)})).rejects.toThrow();await runCollectorJob(f.store,s,def,silent);expect(execute).toHaveBeenCalledTimes(1);expect(lines.join('\n')).not.toContain('do-not-emit');
    expect(new ScheduleState(f.store).summary('discover').last_success_at).toBeNull();
  }finally{f.close();}
});
test('summaries contain KST times, fixed outcomes and counts, use private permissions, reject symlinks, and do not control execution',async()=>{
  const f=engineFixture();try{
    const lines:string[]=[];await job(f,{log:line=>lines.push(line)});const dir=f.file+'.schedule',path=join(dir,'collect.json'),summary=JSON.parse(readFileSync(path,'utf8'));
    expect(statSync(dir).mode&0o777).toBe(0o700);expect(statSync(path).mode&0o777).toBe(0o600);expect(summary.call).toMatchObject({outcome:'succeeded',action:'new'});expect(summary.call.started_at).toMatch(/\+09:00$/);expect(summary.call.ended_at).toMatch(/\+09:00$/);
    expect(lines).toHaveLength(2);expect(lines.every(line=>/at=.+\+09:00 .*call_id=/.test(line))).toBe(true);
    const calls=f.calls.length;unlinkSync(path);await job(f);expect(f.calls).toHaveLength(calls);expect(existsSync(path)).toBe(true);
    unlinkSync(path);symlinkSync(join(f.dir,'do-not-create'),path);await expect(job(f)).rejects.toThrow('unsafe_file');expect(f.calls).toHaveLength(calls);expect(existsSync(join(f.dir,'do-not-create'))).toBe(false);
  }finally{f.close();}
});
test('corrupt checkpoint times stop automatic work without transport, attempts or a replacement engine',async()=>{
  const f=engineFixture();try{
    f.response(()=>{throw new Error('network_error');});await job(f);const calls=f.calls.length;
    f.store.db.prepare("UPDATE engine_checkpoints SET next_at=-1 WHERE phase='retry_wait'").run();await expect(job(f)).rejects.toThrow('engine_checkpoint_time');expect(f.calls).toHaveLength(calls);expect(rows(f,'engine_runs')).toHaveLength(1);
  }finally{f.close();}
});
test('worker immediately checks, uses one scheduler owner, and keeps other jobs moving during an engine wait',async()=>{
  const f=fixture();try{
    const executions:string[]=[],def=(job:string):JobDefinition=>({create:()=>({enabled:true,run:async()=>{executions.push(job);return {};},result:()=>({status:'succeeded',reason:'completed'})})});
    const controller=new AbortController(),worker=new ScheduleWorker(f.store,def,loadSchedule(),silent);
    const sleep=vi.fn(async(ms:number)=>{expect(ms).toBe(60000);expect((await new ScheduleWorker(f.store,def,loadSchedule(),silent).run(new AbortController().signal,{lock:quickLock()})).reason).toBe('run_locked');controller.abort();});
    await worker.run(controller.signal,{sleep});expect(executions).toEqual(['discover','collect']);expect(sleep).toHaveBeenCalledTimes(1);
    await worker.tick();expect(executions).toHaveLength(2);
  }finally{f.close();}
});

test('preexisting completed scheduled engine without an intent marker is never a fresh slot success',async()=>{
  const f=engineFixture();try{
    move(f,at('09:40:00'));const id=f.pipeline.start({kind:'scheduled',at:new Date(at('09:40:00')).toISOString()});f.pipeline.seed(id);await f.pipeline.run(id);const calls=f.calls.length;
    expect((await job(f))).toMatchObject({outcome:'already_completed',reason:'existing_engine'});expect(f.calls).toHaveLength(calls);expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();expect(rows(f,'collection_schedule_runs')[0].engine_id).toBeNull();
    move(f,at('15:40:00'));expect((await job(f)).outcome).toBe('succeeded');
  }finally{f.close();}
});
test('an adoption intent interrupted before linking recovers its known legacy engine without assigning a slot',async()=>{
  const f=engineFixture();try{
    const id=f.pipeline.start();f.pipeline.seed(id);new ScheduleState(f.store).create('collect',undefined,id);f.reopen();
    expect((await job(f))).toMatchObject({outcome:'succeeded',run_id:id,reason:'legacy_unassigned'});expect(rows(f,'engine_runs')).toHaveLength(1);expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBeNull();
  }finally{f.close();}
});
test('a process lost during non-engine work has no invented end time and never repeats that slot',async()=>{
  const f=fixture();try{
    const state=new ScheduleState(f.store),s=loadSchedule()[0],run=state.create('discover',dueSlots(s,f.now()),null);
    state.call('f9c01f60-baf9-4544-ad10-e01f1eb5ef77','discover','manual','new',f.now(),run);state.update(run.id,'running','started');f.advance(60000);f.reopen();
    const execute=vi.fn(async()=>({}));await runCollectorJob(f.store,s,{create:()=>({enabled:true,run:execute,result:()=>({status:'succeeded',reason:'completed'})})},silent);expect(execute).not.toHaveBeenCalled();
    const old=rows(f,'collection_schedule_calls')[0];expect(old).toMatchObject({ended_at:null,observed_at:f.now(),outcome:'interrupted',reason:'owner_gone'});expect(new ScheduleState(f.store).summary('discover').last_success_at).toBeNull();
  }finally{f.close();}
});
test('runnable checkpoints proceed while another checkpoint has an unexpired lease',async()=>{
  const f=engineFixture();try{
    f.source.entries.push(f.source.origin+'/second');const id=f.pipeline.start();f.pipeline.seed(id);
    const first=rows(f,'engine_checkpoints')[0],until=f.now()+180000;
    f.store.db.prepare("UPDATE engine_checkpoints SET phase='leased',lease_until=?,lease_owner='previous-process' WHERE id=?").run(until,String(first.id));
    expect(engineProgress(f.store,id).nextAt).toBe(0);expect((await job(f))).toMatchObject({outcome:'pending',run_id:id});expect(rows(f,'engine_captures')).toHaveLength(1);expect(rows(f,'engine_checkpoints').find(c=>c.id===first.id)).toMatchObject({phase:'leased',attempts:0});
    move(f,until);expect((await job(f))).toMatchObject({outcome:'succeeded',run_id:id});expect(rows(f,'engine_captures')).toHaveLength(2);
  }finally{f.close();}
});
test('disabled sources have a distinct result and never update successful slot state',async()=>{
  const f=fixture();try{
    const result=await runCollectorJob(f.store,schedule,{create:()=>({enabled:false,run:async()=>{throw new Error('must_not_run');}})},silent);
    expect(result).toMatchObject({outcome:'disabled',reason:'sources_disabled'});expect(new ScheduleState(f.store).summary('collect').last_success_at).toBeNull();
  }finally{f.close();}
});
test('a pending collect releases crawl for the next job in the same worker tick',async()=>{
  const f=engineFixture();try{
    f.response(()=>{throw new Error('network_error');});const executed=vi.fn(async()=>({}));
    const worker=new ScheduleWorker(f.store,kind=>kind==='collect'?{profileId:f.profile.id,create:()=>collectAdapter(f.pipeline)}:{create:()=>({enabled:true,run:executed,result:()=>({status:'succeeded',reason:'completed'})})},[schedule,loadSchedule()[0]],silent);
    await worker.tick();expect(rows(f,'collection_schedule_runs').find(r=>r.job==='collect')?.status).toBe('pending');expect(executed).toHaveBeenCalledTimes(1);expect(rows(f,'collection_schedule_runs').find(r=>r.job==='discover')?.status).toBe('succeeded');
  }finally{f.close();}
});

test('a newly created enabled engine with no due work is a successful no-work completion',async()=>{
  const f=engineFixture();try{
    f.source.entries=[];const result=await job(f);expect(result).toMatchObject({outcome:'succeeded',reason:'no_work'});expect(f.calls).toHaveLength(0);expect(new ScheduleState(f.store).summary('collect').last_success_at).not.toBeNull();
  }finally{f.close();}
});

test('explicit manual execution of an unscheduled job stays independent and keeps its completion reason',async()=>{
  const f=engineFixture();try{
    const manual={...schedule,enabled:false};const result=await runCollectorJob(f.store,manual,{profileId:f.profile.id,create:()=>collectAdapter(f.pipeline)},silent);
    expect(result).toMatchObject({outcome:'succeeded',reason:'completed'});expect(rows(f,'collection_schedule_runs')[0]).toMatchObject({target_slot:null,slot_count:0,engine_origin:'created'});expect(new ScheduleState(f.store).summary('collect').last_success_slot).toBeNull();
  }finally{f.close();}
});
