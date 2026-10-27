import { expect, test } from 'vitest';
import { discoveryFixture, discover, rows } from './helpers/source-discovery';
import { AgamajungPipeline } from '../crawler/src/agamajung/pipeline';
import { SourceDiscoveryRunner } from '../crawler/src/source-discovery/runner';
import { CostLedger } from '../crawler/engine/cost';
import { JobEngine } from '../crawler/engine/state-machine';
import { dayKey } from '../crawler/engine/util';
import { noop, asset } from './helpers/engine';
const spent=(f:ReturnType<typeof discoveryFixture>,scope:string)=>rows(f,'engine_costs').find(r=>r.scope===scope&&r.kind==='requests');
test.each(['collect-first','discovery-first'])('actual pipelines share one frozen five-request daily cap, %s',async order=>{
 const f=discoveryFixture();try{
  f.profile.cost_caps.day.requests=5;f.cfg.max_queries=4;f.cfg.cost_caps.run.requests=20;f.cfg.cost_caps.day.requests=20;f.cfg.cost_caps.origin.requests=20;f.cfg.cost_caps.provider.requests=20;
  f.response(url=>({status:200,headers:{'content-type':url.hostname==='search.example.org'?'application/json':'text/html'},body:url.hostname==='search.example.org'?'{"results":[]}':asset('spec.html')}));
  const pipeline=new AgamajungPipeline(f.store,f.raw,f.profile,{scheduler:f.scheduler()});
  f.cfg.max_queries=3;let discovery=new SourceDiscoveryRunner(f.store,f.raw,f.cfg,{profile:f.profile,scheduler:f.scheduler()});
  const collect=async()=>{const r=pipeline.start({kind:'test',at:'one'});pipeline.seed(r);return pipeline.run(r);};
  const search=async()=>{const r=discovery.start({kind:'test',at:'one'});discovery.seed(r);return discovery.run(r);};
  if(order==='collect-first'){await collect();expect(f.calls).toHaveLength(2);await search();}else{await search();expect(f.calls).toHaveLength(3);await collect();}
  expect(f.calls).toHaveLength(5);const scope=`day:${dayKey(f.now())}:agamajung`;expect(spent(f,scope)).toMatchObject({cap:5,spent:5,held:0});
  f.cfg.max_queries=4;discovery=new SourceDiscoveryRunner(f.store,f.raw,f.cfg,{profile:f.profile,scheduler:f.scheduler()});
  const extra=discovery.start({kind:'test',at:'two'});discovery.seed(extra);await discovery.run(extra);
  expect(f.calls).toHaveLength(5);expect(discovery.engine.run(extra)?.state).toBe('cost_wait');expect(spent(f,scope)).toMatchObject({cap:5,spent:5,held:0});expect(rows(f,'engine_cost_holds')).toHaveLength(0);
  expect(rows(f,'engine_costs').filter(r=>String(r.scope).startsWith('day:'))).toHaveLength(3);
 }finally{f.close();}
});
test('local origin exhaustion defers A while B runs, and discovery-only exhaustion leaves shared balance for collect',async()=>{
 const f=discoveryFixture();try{
  f.cfg.source_ids=['fixture','second'];f.cfg.providers=[];f.cfg.cost_caps.origin.requests=1;
  f.settings.sources.push({...f.settings.sources[0],id:'second',origin:'https://second.example.org',entries:['https://second.example.org/']});f.profile.domain_policy.sources.second={...f.profile.domain_policy.sources.fixture};
  f.response(()=>({status:200,headers:{'content-type':'text/html'},body:'<main>유모차 2026 신제품 목록입니다.</main>'}));
  await discover(f);expect(f.calls.map(c=>new URL(c.url).hostname)).toEqual(['gear.example.org','second.example.org']); // only robots; both bodies deferred
  expect(rows(f,'engine_checkpoints').filter(c=>c.phase==='deferred')).toHaveLength(2);
  // Fresh daily namespace, discovery can spend just one API request, collection still gets two.
  f.advance(86400000);f.cfg.providers=[(await import('./helpers/source-discovery')).provider];f.cfg.source_ids=[];f.cfg.cost_caps.origin.requests=20;f.cfg.cost_caps.day.requests=1;f.cfg.max_queries=2;
  f.response(url=>({status:200,headers:{'content-type':url.hostname==='search.example.org'?'application/json':'text/html'},body:url.hostname==='search.example.org'?'{"results":[]}':asset('spec.html')}));
  const runner=f.make(),r=runner.start({kind:'test',at:'two'});runner.seed(r);await runner.run(r);
  const before=f.calls.length,p=new AgamajungPipeline(f.store,f.raw,f.profile,{scheduler:f.scheduler()}),run=p.start({kind:'test',at:'collect'});p.seed(run);await p.run(run);
  expect(f.calls.length-before).toBeGreaterThanOrEqual(2);expect(rows(f,'engine_cost_holds')).toHaveLength(0);
 }finally{f.close();}
});
test('reopening and orphan recovery conservatively spend every scope; manual retries retain original run cap and attempts',async()=>{
 const f=discoveryFixture({rng:()=>0});try{
  f.cfg.cost_caps.run.requests=1;f.response(()=>{throw new Error('network_error');});
  const run=await discover(f);expect(f.calls).toHaveLength(1);
  f.advance(300000);await f.runner.run(run);expect(f.runner.engine.run(run)?.state).toBe('exhausted');expect(f.calls).toHaveLength(1);
  // Use a terminal mapping failure after one successful request for manual retry.
 }finally{f.close();}
 const f2=discoveryFixture();try{
  f2.cfg.cost_caps.run.requests=1;f2.response(()=>({status:200,headers:{'content-type':'application/json'},body:'{"wrong":[]}'}));
  const original=await discover(f2),failure=rows(f2,'engine_failures')[0];expect(failure.reason).toBe('search_schema');
  f2.reopen();const manual=f2.runner.engine.retryFailure(String(failure.id));await f2.runner.run(manual);
  expect(f2.calls).toHaveLength(1);expect(f2.runner.engine.run(manual)?.state).toBe('exhausted');expect(spent(f2,`run:${original}`)).toMatchObject({cap:1,spent:1});expect(spent(f2,`run:${manual}`)).toBeUndefined();
  expect(rows(f2,'engine_costs').every(r=>r.held===0)).toBe(true);
 }finally{f2.close();}
 const f3=discoveryFixture();try{
  const e=new JobEngine(f3.store,'fixture',['a'],{a:noop()}),run=e.startRun({kind:'test',at:'orphan'}),caps={run:{requests:5,bytes:100,model_calls:0},day:{requests:5,bytes:100,model_calls:0}};
  const l=new CostLedger(f3.store,'agamajung',caps).open(run);l.holdKinds({requests:1,bytes:10},[{key:'origin:fixture',caps:caps.day,local:true},{key:'provider:fixture',caps:caps.day,local:true}]);
  f3.reopen();const recovered=new CostLedger(f3.store,'agamajung',caps).open(run);recovered.recoverOrphans();recovered.recoverOrphans();
  expect(rows(f3,'engine_costs').filter(r=>r.kind==='requests').every(r=>r.spent===1&&r.held===0)).toBe(true);expect(rows(f3,'engine_cost_holds')).toHaveLength(0);
 }finally{f3.close();}
});
test('caps freeze on their creation day and next KST day uses current common profile despite resuming an older run',async()=>{
 const f=discoveryFixture();try{
  f.profile.cost_caps.day.requests=1;f.cfg.max_queries=2;
  f.response(()=>({status:200,headers:{'content-type':'application/json'},body:'{"results":[]}'}));
  const r=await discover(f),first=dayKey(f.now());expect(f.calls).toHaveLength(1);
  f.profile.cost_caps.day.requests=5;f.reopen();await f.runner.run(f.runner.resume(r));expect(f.calls).toHaveLength(1);expect(spent(f,`day:${first}:agamajung`)?.cap).toBe(1);
  f.advance(86400000);f.reopen();await f.runner.run(f.runner.resume(r));expect(f.calls).toHaveLength(2);expect(spent(f,`day:${dayKey(f.now())}:agamajung`)).toMatchObject({cap:5,spent:1});
 }finally{f.close();}
});

test('provider aliases share their endpoint cap and leave no partial reservations',async()=>{
 const f=discoveryFixture();try{
  f.cfg.providers.push({...structuredClone(f.cfg.providers[0]),id:'alias-search'});f.cfg.max_queries=2;f.cfg.cost_caps.provider.requests=1;
  f.response(()=>({status:200,headers:{'content-type':'application/json'},body:'{"results":[]}'}));
  await discover(f);expect(f.calls).toHaveLength(1);expect(rows(f,'engine_checkpoints').some(c=>c.phase==='deferred')).toBe(true);expect(rows(f,'engine_costs').every(r=>r.held===0)).toBe(true);
 }finally{f.close();}
});
test('manual retries preserve exhausted automatic attempt counts and the original execution ledger',async()=>{
 const f=discoveryFixture({rng:()=>0});try{
  f.response(()=>{throw new Error('network_error');});const run=await discover(f);f.advance(300000);await f.runner.run(run);f.advance(600000);await f.runner.run(run);
  const failed=rows(f,'engine_failures')[0];expect(failed.attempts).toBe(3);const retry=f.runner.engine.retryFailure(String(failed.id));expect(rows(f,'engine_checkpoints').find(c=>c.run_id===retry)?.attempts).toBe(3);
  await f.runner.run(retry);expect(f.calls).toHaveLength(4);expect(spent(f,`run:${run}`)?.spent).toBe(4);expect(spent(f,`run:${retry}`)).toBeUndefined();
 }finally{f.close();}
});
