import { expect, test } from 'vitest';
import { DiscoveryRunner, type Job } from '../crawler/src/discovery/run';
import { Scheduler, type DomainState, type NetworkResponse } from '../crawler/src/scheduler';
import { config, type CollectorConfig } from '../crawler/src/source-policy';
import type { Binding } from '../shared/collection-schema';
import { fixture, source } from './helpers/collector';

type Attempt = Binding & { id:string; phase:string };
type Budget = { id:string; held:number; spent:number };

function retryFixture(options:{configure?:(settings:CollectorConfig)=>void; nested?:boolean}={}) {
  const settings=structuredClone({...config,sources:[{...source,selector:'main'}]});
  options.configure?.(settings);
  const f=fixture(settings),primary=settings.sources[0],childUrl=primary.origin+'/child?id=1';
  const calls:{url:string;at:number}[]=[],childJobs:Job[]=[];
  let childStatus=503,childHeaders:Record<string,string>={'retry-after':'60'};
  const transport=async(url:URL):Promise<NetworkResponse>=>{
    calls.push({url:url.href,at:f.now()});
    if(url.pathname==='/robots.txt')return {status:404,headers:{},body:''};
    if(url.href===childUrl){
      childJobs.push(f.store.list<Job>('collection_jobs').find(j=>j.url===childUrl&&j.phase==='leased')!);
      return {status:childStatus,headers:{'content-type':'text/html',...childHeaders},body:'<main>Public child fixture</main>'};
    }
    const link=url.href===primary.entries[0]&&options.nested?'/listing':childUrl;
    const body=url.href===primary.entries[0]||url.pathname==='/listing'?`<main><a href="${link}">Public child fixture</a></main>`:'<main>Public fixture</main>';
    return {status:200,headers:{'content-type':'text/html'},body};
  };
  const make=()=>new DiscoveryRunner(f.store,new Scheduler(f.store,transport,async ms=>{f.advance(ms);}));
  let runner=make();
  return {
    ...f,get store(){return f.store;},primary,childUrl,calls,childJobs,get runner(){return runner;},
    respond:(status:number,headers:Record<string,string>={})=>{childStatus=status;childHeaders=headers;},
    reopen:()=>{f.reopen();runner=make();},
    at:(time:number)=>{expect(time).toBeGreaterThanOrEqual(f.now());f.advance(time-f.now());},
    child:(operation:Job['operation']='discovery')=>f.store.list<Job>('collection_jobs').find(j=>j.url===childUrl&&j.operation===operation)!,
    requests:(url=childUrl)=>calls.filter(c=>c.url===url),
    accounting:()=>({
      reservations:f.store.list<Attempt>('intake_reservations'),
      attempts:f.store.list<Attempt>('intake_attempts'),
      receipts:f.store.list<{id:string}>('intake_receipts'),
      budgets:f.store.list<Budget>('daily_budgets'),
    }),
    spent:(operation:Binding['operation'])=>f.store.list<Budget>('daily_budgets').filter(b=>b.id.endsWith(`:${operation}`)).reduce((sum,b)=>sum+b.spent,0),
  };
}

type RetryFixture = ReturnType<typeof retryFixture>;
async function failChild(f:RetryFixture) {
  f.runner.seed();await f.runner.run();
  expect(f.child()).toMatchObject({phase:'failed',attempt:1,failure_reason:'source_cooldown'});
  expect(f.store.recordByUrl(f.childUrl)).toMatchObject({last_checked_at:null,next_recheck_at:null});
  const parent=f.store.recordByUrl(f.primary.entries[0])!;
  expect(parent.last_checked_at).not.toBeNull();
  expect(Date.parse(parent.next_recheck_at!)).toBeGreaterThan(f.now());
  return f.child();
}

function expectHistoryRetained(f:RetryFixture,previous:ReturnType<RetryFixture['accounting']>) {
  for(const row of previous.reservations)expect(f.store.get('intake_reservations',row.id)).toEqual(row);
  for(const row of previous.attempts)expect(f.store.get('intake_attempts',row.id)).toEqual(row);
  for(const row of previous.receipts)expect(f.store.get('intake_receipts',row.id)).toEqual(row);
}

test.each([false,true])('a discovered child retries at backoff while its parent stays fresh (restart=%s)',async restart=>{
  const f=retryFixture();try{
    const failed=await failChild(f),history=f.accounting(),deadline=failed.finished_at!+f.settings.limits.failure_backoff_ms;
    const parent=f.store.recordByUrl(f.primary.entries[0]);
    expect(failed).toMatchObject({depth:1,operation:'discovery'});
    expect(f.requests(f.primary.entries[0])).toHaveLength(1);
    expect(f.requests()).toHaveLength(1);expect(f.spent('new_body')).toBe(2);
    if(restart)f.reopen();
    expect(f.child()).toEqual(failed);expect(f.accounting()).toEqual(history);
    f.respond(200);f.at(deadline-1);await f.runner.run();
    expect(f.child()).toEqual(failed);expect(f.accounting()).toEqual(history);
    expect(f.requests()).toHaveLength(1);
    f.at(deadline);await f.runner.run(); // No seed or parent rediscovery.
    expect(f.child()).toMatchObject({id:failed.id,url:failed.url,source_id:failed.source_id,depth:failed.depth,operation:failed.operation,phase:'done',attempt:2,lease_until:0});
    expect(f.child()).not.toHaveProperty('failure_reason');
    expect(f.childJobs[1]).toMatchObject({attempt:2,cursor:0,phase:'leased'});
    expect(f.childJobs[1].lease_until).toBeGreaterThanOrEqual(deadline);
    expect(f.requests()).toHaveLength(2);expect(f.requests()[1].at).toBeGreaterThanOrEqual(deadline);
    expect(f.requests(f.primary.entries[0])).toHaveLength(1);
    expect(f.store.recordByUrl(f.primary.entries[0])).toEqual(parent);
    expect(Date.parse(parent!.next_recheck_at!)).toBeGreaterThan(f.now());
    expect(f.store.recordByUrl(f.childUrl)?.last_checked_at).not.toBeNull();
    const attempts=f.accounting().attempts.filter(a=>a.clip_id===failed.id);
    expect(attempts).toHaveLength(2);expect(new Set(attempts.map(a=>a.attempt_id)).size).toBe(2);
    expect(f.spent('new_body')).toBe(3);expect(f.spent('recheck')).toBe(0);
    expectHistoryRetained(f,history);
  }finally{f.close();}
});

test.each(['disabled','removed'] as const)('a %s original source defers retries without stalling enabled work',async policy=>{
  const f=retryFixture();try{
    const failed=await failChild(f),history=f.accounting();
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);
    const other={...structuredClone(f.primary),id:'other',brand:'Bugaboo',origin:'https://other.example.org',entries:['https://other.example.org/']};
    if(policy==='disabled')f.primary.enabled=false;else f.settings.sources=[];
    f.settings.sources.push(other);f.reopen();
    // Even an explicitly supplied enabled source must not take over this failed job.
    f.runner.enqueue(f.childUrl,other,0);f.runner.seed();await f.runner.run();
    expect(f.child()).toEqual(failed);expect(f.requests()).toHaveLength(1);
    expect(f.requests(other.entries[0])).toHaveLength(1);
    expect(f.accounting().attempts.filter(a=>a.clip_id===failed.id)).toEqual(history.attempts.filter(a=>a.clip_id===failed.id));
    expectHistoryRetained(f,history);
    f.primary.enabled=true;if(policy==='removed')f.settings.sources.push(f.primary);
    await f.runner.run();
    expect(f.child()).toMatchObject({phase:'done',attempt:2,source_id:f.primary.id,depth:1});
    expect(f.requests()).toHaveLength(2);expect(f.requests(f.primary.entries[0])).toHaveLength(1);
  }finally{f.close();}
});

test.each([false,true])('a stopped domain stays stopped and its failed job stays unchanged (restart=%s)',async restart=>{
  const f=retryFixture();try{
    f.respond(403);f.runner.seed();await f.runner.run();
    const failed=f.child(),history=f.accounting(),domain=f.store.get<DomainState>('domain_state',new URL(f.childUrl).hostname)!;
    expect(failed).toMatchObject({phase:'failed',failure_reason:'source_blocked'});expect(domain.stopped).toBe(true);
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);
    if(restart)f.reopen();
    const calls=f.calls.slice();
    f.runner.seed();f.runner.enqueue(f.childUrl,f.primary,0);await f.runner.run();
    expect(f.calls).toEqual(calls);expect(f.child()).toEqual(failed);expect(f.accounting()).toEqual(history);
    expect(f.store.get('domain_state',new URL(f.childUrl).hostname)).toEqual(domain);
  }finally{f.close();}
});

test('a persisted cooldown longer than backoff defers retry until its own deadline',async()=>{
  const f=retryFixture();try{
    f.respond(503,{'retry-after':'600'});const failed=await failChild(f),history=f.accounting();
    const domain=f.store.get<DomainState>('domain_state',new URL(f.childUrl).hostname)!;
    const deadline=failed.finished_at!+f.settings.limits.failure_backoff_ms;
    expect(domain.next_at).toBeGreaterThan(deadline);f.reopen();f.respond(200);
    for(const at of [deadline,domain.next_at-1]){
      f.at(at);f.runner.enqueue(f.childUrl,f.primary,0);await f.runner.run();
      expect(f.child()).toEqual(failed);expect(f.accounting()).toEqual(history);expect(f.requests()).toHaveLength(1);
      expect(f.store.get('domain_state',new URL(f.childUrl).hostname)).toEqual(domain);
    }
    f.at(domain.next_at);await f.runner.run();
    expect(f.child()).toMatchObject({phase:'done',attempt:2});expect(f.requests()).toHaveLength(2);
    expect(f.requests()[1].at).toBeGreaterThanOrEqual(domain.next_at);
  }finally{f.close();}
});

test.each(['robots','stop_during_spacing'] as const)('a retry still obeys scheduler checks at transport time (%s)',async gate=>{
  const f=retryFixture();try{
    const failed=await failChild(f),history=f.accounting();
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.reopen();
    const calls:string[]=[],domain=new URL(f.childUrl).hostname;
    const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,async url=>{
      calls.push(url.href);
      return {status:200,headers:{},body:gate==='robots'?'User-agent: *\nDisallow: /child':'User-agent: *\nAllow: /'};
    },async ms=>{
      f.advance(ms);
      if(gate==='stop_during_spacing')f.store.transaction(()=>{
        const state=f.store.get<DomainState>('domain_state',domain)!;
        f.store.put('domain_state',domain,{...state,stopped:true,reason:'blocked'});
      });
    }));
    await runner.run();
    expect(calls).toEqual([f.primary.origin+'/robots.txt']);
    expect(f.child()).toMatchObject({phase:'failed',attempt:2,failure_reason:gate==='robots'?'robots_denied':'domain_stopped'});
    expect(f.spent('new_body')).toBe(3);expectHistoryRetained(f,history);
    if(gate==='stop_during_spacing')expect(f.store.get<DomainState>('domain_state',domain)?.stopped).toBe(true);
  }finally{f.close();}
});

test.each(['paths','query_keys','depth'] as const)('narrowed %s policy cannot be bypassed by rediscovery at a shallower depth',async policy=>{
  const f=retryFixture({nested:policy==='depth'});try{
    const failed=await failChild(f),history=f.accounting(),calls=f.calls.slice();
    const original=structuredClone(f.primary),maxDepth=f.settings.limits.max_depth;
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);
    if(policy==='paths'){f.primary.paths=['/allowed/'];f.primary.entries=[f.primary.origin+'/allowed/'];}
    if(policy==='query_keys')f.primary.query_keys=[];
    if(policy==='depth'){expect(failed.depth).toBe(2);f.settings.limits.max_depth=1;}
    f.reopen();
    f.runner.enqueue(f.childUrl,original,0);await f.runner.run();
    expect(f.child()).toEqual(failed);expect(f.accounting()).toEqual(history);expect(f.calls).toEqual(calls);
    Object.assign(f.primary,original);f.settings.limits.max_depth=maxDepth;
    await f.runner.run();
    expect(f.child()).toMatchObject({phase:'done',attempt:2,depth:failed.depth});
  }finally{f.close();}
});

test.each(['source','global'] as const)('%s page cap leaves a retry pending and recoverable on the next run',async cap=>{
  const f=retryFixture();try{
    const failed=await failChild(f),history=f.accounting();
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);
    if(cap==='source')f.primary.max_pages=1;else f.settings.limits.max_pages=1;
    const fresh=f.primary.origin+'/fresh';f.runner.enqueue(fresh,f.primary);
    await f.runner.run();
    expect(f.requests(fresh)).toHaveLength(1);expect(f.requests()).toHaveLength(1);
    expect(f.child()).toMatchObject({phase:'pending',attempt:2});expect(f.spent('new_body')).toBe(3);
    expectHistoryRetained(f,history);f.reopen();await f.runner.run();
    expect(f.child()).toMatchObject({phase:'done',attempt:2});expect(f.requests()).toHaveLength(2);
    expect(f.spent('new_body')).toBe(4);
  }finally{f.close();}
});

test('an exhausted body budget blocks traffic without refunding the failed attempt; the next day recovers',async()=>{
  const f=retryFixture({configure:s=>{s.limits.new_body=2;}});try{
    const failed=await failChild(f),history=f.accounting();
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);await f.runner.run();
    expect(f.child()).toMatchObject({phase:'failed',attempt:2,failure_reason:'daily_limit'});
    expect(f.requests()).toHaveLength(1);expect(f.spent('new_body')).toBe(2);expect(f.accounting()).toEqual(history);
    f.advance(86400000);f.reopen();await f.runner.run();
    expect(f.child()).toMatchObject({phase:'done',attempt:3});expect(f.requests()).toHaveLength(2);
    expect(f.spent('new_body')).toBe(3);expect(f.spent('recheck')).toBe(1);
    expectHistoryRetained(f,history);
  }finally{f.close();}
});

test('repeated failures start a new backoff and never rescan in the same run',async()=>{
  const f=retryFixture();try{
    const first=await failChild(f);f.at(first.finished_at!+f.settings.limits.failure_backoff_ms);
    await f.runner.run();const second=f.child(),history=f.accounting();
    expect(second).toMatchObject({phase:'failed',attempt:2,failure_reason:'source_cooldown'});
    expect(second.finished_at).toBeGreaterThan(first.finished_at!);expect(f.requests()).toHaveLength(2);
    const deadline=second.finished_at!+f.settings.limits.failure_backoff_ms;
    f.respond(200);f.reopen();f.at(deadline-1);f.runner.enqueue(f.childUrl,f.primary,0);await f.runner.run();
    expect(f.child()).toEqual(second);expect(f.accounting()).toEqual(history);expect(f.requests()).toHaveLength(2);
    f.at(deadline);await f.runner.run();
    expect(f.child()).toMatchObject({phase:'done',attempt:3});expect(f.requests()).toHaveLength(3);
    const attempts=f.accounting().attempts.filter(a=>a.clip_id===first.id);
    expect(attempts).toHaveLength(3);expect(new Set(attempts.map(a=>a.attempt_id)).size).toBe(3);
    expect(f.spent('new_body')).toBe(4);expectHistoryRetained(f,history);
  }finally{f.close();}
});

test('enqueue preserves legacy job bindings, resets cursor/lease, and allocates attempt 2',async()=>{
  const f=retryFixture();try{
    const failed=await failChild(f);delete failed.attempt;failed.cursor=7;failed.lease_until=f.now()+1000;
    f.store.transaction(()=>f.store.put('collection_jobs',failed.id,failed));
    const history=f.accounting();f.reopen();f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);
    f.runner.enqueue(f.childUrl,f.primary,0);
    expect(f.child()).toEqual({id:failed.id,url:failed.url,source_id:failed.source_id,depth:1,operation:'discovery',phase:'pending',attempt:2,cursor:0,lease_until:0});
    f.respond(200);await f.runner.run();expect(f.child()).toMatchObject({phase:'done',attempt:2});
    const attempts=f.accounting().attempts.filter(a=>a.clip_id===failed.id);
    expect(attempts).toHaveLength(2);expect(new Set(attempts.map(a=>a.attempt_id)).size).toBe(2);
    expect(f.spent('new_body')).toBe(3);expectHistoryRetained(f,history);
  }finally{f.close();}
});

test('failed rechecks retain priority and their separate daily budget across retry',async()=>{
  const f=retryFixture({configure:s=>{s.limits.recheck=1;}});try{
    const failed=await failChild(f);f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);
    f.respond(200);await f.runner.run();expect(f.spent('new_body')).toBe(3);
    f.runner.enqueue(f.childUrl,f.primary,1,'recheck');f.respond(503);await f.runner.run();
    const recheck=f.child('recheck'),history=f.accounting();
    expect(recheck).toMatchObject({phase:'failed',attempt:1,operation:'recheck'});expect(f.spent('recheck')).toBe(1);
    f.at(recheck.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);f.reopen();
    f.primary.max_pages=1;const fresh=f.primary.origin+'/fresh';f.runner.enqueue(fresh,f.primary);
    await f.runner.run();
    // The exhausted recheck takes the one page slot before new discovery, without transport.
    expect(f.child('recheck')).toMatchObject({phase:'failed',attempt:2,operation:'recheck',failure_reason:'daily_limit'});
    expect(f.requests()).toHaveLength(3);expect(f.requests(fresh)).toHaveLength(0);
    expect(f.spent('new_body')).toBe(3);expect(f.spent('recheck')).toBe(1);expectHistoryRetained(f,history);
    // Restore capacity to isolate successful retry accounting from the next day's other rechecks.
    f.settings.limits.recheck=2;f.at(f.child('recheck').finished_at!+f.settings.limits.failure_backoff_ms);
    await f.runner.run();
    expect(f.child('recheck')).toMatchObject({phase:'done',attempt:3,operation:'recheck'});
    expect(f.requests()).toHaveLength(4);expect(f.requests(fresh)).toHaveLength(0);
    const attempts=f.accounting().attempts.filter(a=>a.clip_id===recheck.id);
    expect(attempts).toHaveLength(2);expect(attempts.every(a=>a.operation==='recheck')).toBe(true);
    expect(new Set(attempts.map(a=>a.attempt_id)).size).toBe(2);
    expect(f.spent('new_body')).toBe(3);expect(f.spent('recheck')).toBe(2);expectHistoryRetained(f,history);
  }finally{f.close();}
});

test('dry-run probes leave due failures and intake history untouched while retaining probe spend',async()=>{
  const f=retryFixture();try{
    const failed=await failChild(f),history=f.accounting(),jobs=f.store.list<Job>('collection_jobs');
    f.at(failed.finished_at!+f.settings.limits.failure_backoff_ms);f.respond(200);f.reopen();
    const health=await f.runner.run(true);
    expect(health.mode).toBe('dry_run');expect(f.store.list('collection_jobs')).toEqual(jobs);
    const after=f.accounting();expect(after.attempts).toEqual(history.attempts);expect(after.reservations).toEqual(history.reservations);expect(after.receipts).toEqual(history.receipts);
    expect(f.spent('new_body')).toBe(4);expect(f.requests()).toHaveLength(2);
    expect(f.store.recordByUrl(f.childUrl)?.last_checked_at).toBeNull();
    // Probe traffic also persists the scheduler's request-spacing deadline.
    await f.runner.run();expect(f.child()).toEqual(failed);expect(f.spent('new_body')).toBe(4);
    f.at(f.store.get<DomainState>('domain_state',new URL(f.childUrl).hostname)!.next_at);
    await f.runner.run();expect(f.child()).toMatchObject({phase:'done',attempt:2});
    expect(f.spent('new_body')).toBe(5);expect(f.requests()).toHaveLength(3);expectHistoryRetained(f,history);
  }finally{f.close();}
});
