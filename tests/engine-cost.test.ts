import { expect, test, vi } from 'vitest';
import { CostCapError, CostLedger, JobEngine } from '../crawler/engine';
import { Scheduler } from '../crawler/src/scheduler';
import { fixture, source } from './helpers/collector';
import { noop } from './helpers/engine';
const caps={run:{requests:20,bytes:100000000,model_calls:0},day:{requests:40,bytes:200000000,model_calls:0}};
function setup(){const f=fixture(),e=new JobEngine(f.store,'fake',['a'],{a:noop()}),id=e.startRun({kind:'d',at:'one'}),l=new CostLedger(f.store,'fake',structuredClone(caps)).open(id);return {f,e,id,l};}
const spent=(f:ReturnType<typeof fixture>,id:string,kind='requests')=>(f.store.db.prepare('SELECT spent FROM engine_costs WHERE id=?').get(`run:${id}:${kind}`) as {spent:number}).spent;
test('every transport is metered: robots, two redirects, three browser subrequests and a 403 response',async()=>{
 const {f,id,l}=setup();try{
  let count=0,bytes=0;const transport=vi.fn(async(url:URL)=>{
   count++;const body=url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':'example_only body';bytes+=Buffer.byteLength(body);
   return {status:url.pathname==='/blocked'?403:url.pathname==='/a'||url.pathname==='/b'?302:200,headers:{'content-type':'text/plain',location:url.pathname==='/a'?'/b':'/c'},body};
  });
  const s=new Scheduler(f.store,transport,async ms=>f.advance(ms),l);
  await s.get(source.origin+'/a',source);
  await Promise.all(['/script','/style','/xhr'].map(p=>s.get(source.origin+p,source)));
  await expect(s.get(source.origin+'/blocked',source)).rejects.toThrow('source_blocked');
  expect(count).toBe(8);expect(spent(f,id)).toBe(count);expect(spent(f,id,'bytes')).toBe(bytes);
 }finally{f.close();}
});
test('cap prevents N+1 transport; partial receive failures settle bytes; orphan holds spend reservations',async()=>{
 const {f,id}=setup();try{
  const small=structuredClone(caps);small.run.requests=2;const l=new CostLedger(f.store,'fake',small).open(id);
  // Existing scopes keep their original caps; exercise an isolated profile/run.
  const e=new JobEngine(f.store,'small',['a'],{a:noop()}),r=e.startRun({kind:'d',at:'one'}),ledger=new CostLedger(f.store,'small',small).open(r);
  const transport=vi.fn(async()=>{throw Object.assign(new Error('response_size'),{received:321});});
  const s=new Scheduler(f.store,transport,async ms=>f.advance(ms),ledger);
  await expect(s.get(source.origin+'/one',source)).rejects.toThrow('response_size');await expect(s.get(source.origin+'/two',source)).rejects.toThrow('response_size');
  await expect(s.get(source.origin+'/three',source)).rejects.toBeInstanceOf(CostCapError);expect(transport).toHaveBeenCalledTimes(2);expect(spent(f,r,'bytes')).toBe(642);
  l.hold(1000);f.reopen();const recovered=new CostLedger(f.store,'fake',caps).open(id);recovered.recoverOrphans();expect(spent(f,id)).toBe(1);expect(spent(f,id,'bytes')).toBe(1000);expect(f.store.db.prepare('SELECT * FROM engine_cost_holds').all()).toEqual([]);
 }finally{f.close();}
});
test('daily deferral resumes the same run after KST midnight; exhausted run carries only unfinished stages',async()=>{
 const f=fixture();try{
  let ledger:CostLedger;const action=vi.fn(async()=>{const t=ledger.hold(10);ledger.settle(t,1);return {};});
  const e=new JobEngine(f.store,'fake',['a'],{a:noop(action)}),id=e.startRun({kind:'daily',at:'one'}),cap={run:{requests:5,bytes:100,model_calls:0},day:{requests:1,bytes:100,model_calls:0}};ledger=new CostLedger(f.store,'fake',cap).open(id);
  e.enqueue(id,'a','one');e.enqueue(id,'a','two');await e.runUntilIdle(id);expect(e.run(id)?.state).toBe('cost_wait');expect(e.checkpoint(e.enqueue(id,'a','two'))).toMatchObject({phase:'deferred',attempts:0});
  f.advance(86400000);expect(e.startRun({kind:'daily',at:'two'})).toBe(id);await e.runUntilIdle(id);expect(e.run(id)?.state).toBe('finished');expect(spent(f,id)).toBe(2);
  f.advance(86400000);const next=e.startRun({kind:'daily',at:'three'});ledger=new CostLedger(f.store,'fake',{run:{requests:0,bytes:100,model_calls:0},day:{requests:5,bytes:100,model_calls:0}}).open(next);e.enqueue(next,'a','unfinished');await e.runUntilIdle(next);expect(e.run(next)?.state).toBe('exhausted');expect(()=>e.resume(next)).toThrow('run_not_resumable');
  const fresh=e.startRun({kind:'daily',at:'four'});expect(fresh).not.toBe(next);const carried=f.store.db.prepare('SELECT data FROM engine_checkpoints WHERE run_id=?').all(fresh) as {data:string}[];expect(carried).toHaveLength(1);expect(JSON.parse(carried[0].data).carried_from).toBeTruthy();
 }finally{f.close();}
});
test('when both scopes are short, day takes precedence and no partial hold remains',()=>{
 const {f,id}=setup();try{const l=new CostLedger(f.store,'fake',caps).open(id);f.store.db.prepare('UPDATE engine_costs SET cap=0').run();expect(()=>l.hold(1)).toThrow(expect.objectContaining({scope:'day'}));expect(f.store.db.prepare('SELECT * FROM engine_cost_holds').all()).toEqual([]);}finally{f.close();}
});
