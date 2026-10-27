import { expect, test, vi } from 'vitest';
import { JobEngine } from '../crawler/engine';
import { fixture } from './helpers/collector';
import { noop } from './helpers/engine';

test('fake-service stages resume from durable checkpoints, use active/unique slots and preserve attempts',async()=>{
 const f=fixture();try{
  const one=vi.fn(async()=>({})),two=vi.fn(async()=>{throw new Error('network_error');});
  let e=new JobEngine(f.store,'fake',['a','b'],{a:noop(one),b:noop(two)},{rng:()=>0});
  const id=e.startRun({kind:'day',at:'one'});expect(e.startRun({kind:'day',at:'two'})).toBe(id);e.enqueue(id,'a','item');
  await e.runUntilIdle(id);expect(one).toHaveBeenCalledTimes(1);expect(two).toHaveBeenCalledTimes(1);
  let b=e.checkpoint(e.enqueue(id,'b','item'))!;expect(b).toMatchObject({phase:'retry_wait',attempts:1});expect(b.next_at-f.now()).toBe(300000);
  f.advance(300000);f.reopen();e=new JobEngine(f.store,'fake',['a','b'],{a:noop(one),b:noop(two)},{rng:()=>0});await e.runUntilIdle(e.resume(id));
  b=e.checkpoint(b.id)!;expect(b.attempts).toBe(2);expect(one).toHaveBeenCalledTimes(1);
  f.advance(600000);await e.runUntilIdle(id);expect(e.checkpoint(b.id)).toMatchObject({phase:'failed',attempts:3});expect(e.failures()[0]).toMatchObject({reason:'network_error',next_retry_at:null,retryable:1});
  const retry=e.retryFailure(b.id);expect(retry).not.toBe(id);expect(JSON.parse(e.run(retry)!.data)).toMatchObject({parent_run:id});
 }finally{f.close();}
});
test('expired leases recover committed output without running handler; nested transactions in recovery fail closed',async()=>{
 const f=fixture();try{
  const run=vi.fn(async()=>({outputRef:'stable'}));let crash=true;
  const handler={...noop(run),recover:()=>({outputRef:'recovered'})};
  const e=new JobEngine(f.store,'fake',['stage'],{stage:handler},{fault:()=>{if(crash){crash=false;throw new Error('injected');}}});
  const id=e.startRun({kind:'slot',at:'x'}),ck=e.enqueue(id,'stage','key');await expect(e.step(id)).rejects.toThrow('engine_crash');
  expect(e.checkpoint(ck)?.phase).toBe('leased');f.advance(180001);await e.runUntilIdle(id);expect(run).toHaveBeenCalledTimes(1);expect(e.checkpoint(ck)).toMatchObject({phase:'done',output_ref:'recovered'});
  const second=e.startRun({kind:'slot',at:'y'}),c=e.enqueue(second,'stage','nested');
  f.store.db.prepare("UPDATE engine_checkpoints SET phase='leased',lease_until=0 WHERE id=?").run(c);
  handler.recover=()=>f.store.transaction(()=>({outputRef:'invalid'}));await e.runUntilIdle(second);expect(e.checkpoint(c)).toMatchObject({phase:'failed',error_code:'nested_transaction'});
 }finally{f.close();}
});
test('transactional commit and downstream checkpoint roll back together after handler failure',async()=>{
 const f=fixture();try{
  const handler={...noop(),commit:()=>{f.store.put('collector_meta','atomic',true);throw new Error('payload_shape');}};
  const e=new JobEngine(f.store,'fake',['a','b'],{a:handler,b:noop()});const r=e.startRun({kind:'x',at:'x'}),c=e.enqueue(r,'a','i');await e.runUntilIdle(r);
  expect(f.store.get('collector_meta','atomic')).toBeUndefined();expect(e.checkpoint(c)?.phase).toBe('failed');expect(f.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE stage='b'").get()).toBeUndefined();
 }finally{f.close();}
});
test('exhausted carry retains successful ancestors so lost input can rewind without rerunning discovery',async()=>{
 const f=fixture();try{
  const discover=vi.fn(async()=>({})),fetch=vi.fn(async()=>({outputRef:'raw-ref'}));let exhausted=true,lost=false;
  const {CostCapError}=await import('../crawler/engine');
  const e=new JobEngine(f.store,'fake',['discover','fetch','parse'],{discover:noop(discover),fetch:noop(fetch),parse:noop(async()=>{if(exhausted)throw new CostCapError('run');if(lost){lost=false;throw new Error('input_unavailable');}return {};})});
  const first=e.startRun({kind:'day',at:'one'});e.enqueue(first,'discover','item');await e.runUntilIdle(first);expect(e.run(first)?.state).toBe('exhausted');
  exhausted=false;lost=true;const next=e.startRun({kind:'day',at:'two'});await e.runUntilIdle(next);expect(e.run(next)?.state).toBe('finished');expect(discover).toHaveBeenCalledTimes(1);expect(fetch).toHaveBeenCalledTimes(2);
 }finally{f.close();}
});
