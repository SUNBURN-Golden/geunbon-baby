import { expect, test, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { chromium, type Route } from 'playwright';
import { browserExtract } from '../crawler/src/discovery/browser';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressAllowed, inCidr, parseTrustedEgress } from '../crawler/src/egress';
import { pinnedRequest, Scheduler, type NetworkResponse } from '../crawler/src/scheduler';
import { CollectorError } from '../crawler/src/store';
import { DiscoveryRunner, failureCode, type Job } from '../crawler/src/discovery/run';
import { main } from '../crawler/src/local-worker';
import { handleLocal, type LocalAuth } from '../crawler/src/intake-api';
import { cli } from '../crawler/src/cli';
import { fixture, source } from './helpers/collector';
import { config, type CollectorConfig } from '../crawler/src/source-policy';
vi.mock('node:dns/promises',()=>({lookup:vi.fn()}));
vi.mock('node:https',()=>({request:vi.fn()}));
const trusted=parseTrustedEgress('198.18.0.0/15');
test('trusted egress parses only explicit, safe CIDRs',()=>{
 for(const raw of [undefined,'',' , '])expect(parseTrustedEgress(raw)).toEqual([]);
 expect(parseTrustedEgress(' 198.18.0.0/15 , 2001:db8::/32, ')).toHaveLength(2);
 for(const raw of ['198.18.0.1','garbage','198.18.0.0/33','198.18.0.0/-1','127.0.0.0/8','169.254.0.0/16','0.0.0.0/0','96.0.0.0/3','224.0.0.0/4','240.0.0.0/4','::1/128','fe80::/10','::/0','8000::/1','::ffff:0:0/96','::ffff:198.18.0.0/111','ff00::/8','::/128'])expect(()=>parseTrustedEgress(raw),raw).toThrow('trusted_egress_config');
});
test('trusted matching preserves the default and rejects other private addresses and IPv4 aliases',()=>{
 expect(addressAllowed('198.18.0.1',[])).toBe(false);
 for(const ip of ['198.18.0.1','198.19.255.255'])expect(addressAllowed(ip,trusted)).toBe(true);
 for(const ip of ['10.0.0.1','127.0.0.1','169.254.169.254','::ffff:198.18.0.1','::ffff:c612:1','224.0.0.1','fc00::1'])expect(addressAllowed(ip,trusted),ip).toBe(false);
 expect(inCidr('198.20.0.1',trusted[0])).toBe(false);
 expect(addressAllowed('198.20.0.1',trusted)).toBe(true); // Already public under the unchanged default.
 const v6=parseTrustedEgress('2001:db8::/32');
 expect(addressAllowed('2001:db8::1',v6)).toBe(true);
 expect(inCidr('2001:db9::1',v6[0])).toBe(false);
 expect(addressAllowed('2001:db9::1',v6)).toBe(true); // Public addresses do not require the allowlist.
 expect(inCidr('198.18.0.1',v6[0])).toBe(false);
 expect(addressAllowed('::ffff:198.18.0.1',v6)).toBe(false);
 expect(inCidr('2001:db8::192.0.2.1',v6[0])).toBe(true);
 expect(inCidr('2001:0db8:0000:0000:0000:0000:0000:0001',v6[0])).toBe(true);
 // RFC1918, CGNAT and ULA require an explicit entry too.
 for(const [cidr,ip] of [['10.0.0.0/8','10.1.2.3'],['100.64.0.0/10','100.64.1.2'],['fc00::/7','fd00::1']])expect(addressAllowed(ip,parseTrustedEgress(cidr))).toBe(true);
 expect(addressAllowed('8.8.8.8',[])).toBe(true);
});
test('transport checks every DNS result and pins an explicitly trusted address',async()=>{
 const dns=vi.mocked(lookup),https=vi.mocked(request);https.mockClear();
 dns.mockResolvedValue([{address:'198.18.0.1',family:4}] as never);
 await expect(pinnedRequest(new URL(source.origin),1024)).rejects.toThrow('private_network');expect(https).not.toHaveBeenCalled();
 let pinned:unknown;
 https.mockImplementation(((_url:URL,options:{lookup:(host:string,options:object,cb:(error:unknown,address:unknown,family?:number)=>void)=>void},callback:(res:EventEmitter)=>void)=>{
  options.lookup('ignored',{},(_err,address,family)=>{pinned={address,family};});
  const req=Object.assign(new EventEmitter(),{setTimeout:vi.fn(),destroy:vi.fn(),end:()=>{
   const res=Object.assign(new EventEmitter(),{statusCode:200,headers:{}});callback(res);res.emit('data',Buffer.from('ok'));res.emit('end');res.emit('close');req.emit('close');
  }});return req;
 }) as never);
 expect(await pinnedRequest(new URL(source.origin),1024,trusted)).toMatchObject({status:200,body:'ok'});
 expect(pinned).toEqual({address:'198.18.0.1',family:4});expect(https).toHaveBeenCalledTimes(1);
 https.mockClear();dns.mockResolvedValue([{address:'198.18.0.1',family:4},{address:'10.0.0.1',family:4}] as never);
 await expect(pinnedRequest(new URL(source.origin),1024,trusted)).rejects.toThrow('private_network');expect(https).not.toHaveBeenCalled();
});
test('same-origin redirect re-resolves and rejects a newly private DNS result',async()=>{
 const f=fixture();try{
  const addresses=new Map([[new URL(source.origin).hostname,'198.18.0.1']]);let success=0;
  const transport=vi.fn(async(url:URL):Promise<NetworkResponse>=>{
   if(!addressAllowed(addresses.get(url.hostname)!,trusted))throw new CollectorError('private_network');
   success++;
   if(url.pathname==='/robots.txt')return {status:404,headers:{},body:''};
   addresses.set(url.hostname,'10.0.0.1');return {status:302,headers:{location:'/redirect'},body:''};
  });
  await expect(new Scheduler(f.store,transport,async ms=>{f.advance(ms);}).get(source.entries[0],source)).rejects.toThrow('private_network');
  expect(success).toBe(2);expect(transport).toHaveBeenCalledTimes(3);
 }finally{f.close();}
});
test('job reasons persist, failed jobs back off, retry succeeds and clears the reason',async()=>{
 const f=fixture();try{
  const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,async()=>{throw new CollectorError('private_network');},async ms=>{f.advance(ms);}));
  runner.seed();await runner.run();
  expect(f.store.list<Job>('collection_jobs')[0]).toMatchObject({phase:'failed',failure_reason:'private_network',attempt:1});
  f.reopen();expect(f.store.jobSummary().sources.fixture).toMatchObject({failed:1,failures:{private_network:1},last_failure:{reason:'private_network',at:new Date(f.store.now()).toISOString()}});
  const retry=new DiscoveryRunner(f.store,new Scheduler(f.store,async url=>({status:url.pathname==='/robots.txt'?404:200,headers:{},body:'<main></main>'}),async ms=>{f.advance(ms);}));
  retry.seed();expect(f.store.list<Job>('collection_jobs')[0].phase).toBe('failed');
  f.advance(f.store.settings.limits.failure_backoff_ms);retry.seed();expect(f.store.list<Job>('collection_jobs')[0]).toMatchObject({phase:'pending',attempt:2});
  await retry.run();expect(f.store.list<Job>('collection_jobs')[0]).toMatchObject({phase:'done'});expect(f.store.list<Job>('collection_jobs')[0]).not.toHaveProperty('failure_reason');
  retry.seed();expect(f.store.list<Job>('collection_jobs')[0].phase).toBe('done');
 }finally{f.close();}
});
test('unsafe error messages become short codes without URLs',async()=>{
 for(const error of [new Error('bad https://example.invalid/x'),new CollectorError('https://example.invalid'),{},new Error('A'.repeat(41))])expect(failureCode(error)).toBe('error');
 expect(failureCode(new Error('request_timeout'))).toBe('request_timeout');
 const f=fixture();try{
  const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,async()=>{throw new Error('bad https://example.invalid/x');}));runner.seed();await runner.run();
  expect(f.store.list<Job>('collection_jobs')[0].failure_reason).toBe('error');expect(JSON.stringify(f.store.jobSummary())).not.toContain('https:');
 }finally{f.close();}
});
test('invalid env configuration fails before the database opens',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'egress-env-')),file=join(dir,'collector.sqlite'),argv=process.argv;
 const prior={db:process.env.COLLECTOR_DB,trusted:process.env.COLLECTOR_TRUSTED_EGRESS_CIDRS};
 try{
  process.argv=['node','local-worker','discover','--dry-run'];vi.stubEnv('COLLECTOR_DB',file);vi.stubEnv('COLLECTOR_TRUSTED_EGRESS_CIDRS','127.0.0.0/8');
  await expect(main()).rejects.toThrow('trusted_egress_config');expect(existsSync(file)).toBe(false);expect(existsSync(`${file}.lock`)).toBe(false);
 }finally{process.argv=argv;for(const [key,value] of Object.entries({COLLECTOR_DB:prior.db,COLLECTOR_TRUSTED_EGRESS_CIDRS:prior.trusted}))if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(dir,{recursive:true,force:true});}
});
test('existing config files inherit the five-minute failure backoff',()=>{
 const settings=structuredClone({...config,sources:[source]});delete (settings.limits as Partial<CollectorConfig['limits']>).failure_backoff_ms;
 const f=fixture(settings);try{expect(f.store.settings.limits.failure_backoff_ms).toBe(300000);}finally{f.close();}
});
test('jobs API and CLI show local reasons and leave status/report contracts intact',async()=>{
 const f=fixture();try{
  const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,async()=>{throw new CollectorError('private_network');}));runner.seed();await runner.run();
  const auth:LocalAuth={host:'127.0.0.1:4318',extensionOrigin:`chrome-extension://${'a'.repeat(32)}`,intakeToken:'intake-fixture-1234567890123456',reviewToken:'review-fixture-1234567890123456'};
  const send:typeof fetch=async(input,init)=>handleLocal(new Request(String(input),{...init,headers:{...init?.headers,host:auth.host,authorization:`Bearer ${auth.reviewToken}`}}),f.store,auth);
  const summary=await (await send(`http://${auth.host}/v1/collection/jobs`)).json() as {data:unknown};expect(summary.data).toEqual(f.store.jobSummary());
  expect(JSON.parse(await cli(['jobs','--json'],send))).toEqual(summary.data);expect(await cli(['jobs'],send)).toBe('fixture: done 0 · failed 1 · pending 0 · private_network×1');
  const denied=await handleLocal(new Request(`http://${auth.host}/v1/collection/jobs`,{headers:{host:auth.host,authorization:`Bearer ${auth.intakeToken}`}}),f.store,auth);expect(denied.status).toBe(401);
  expect(JSON.parse(await cli(['report','--json'],send))).toEqual(f.store.report());
 }finally{f.close();}
});

test('job summary counts phases, aggregates sanitized reasons and reports the latest failure',()=>{
 const f=fixture();try{
  const at=f.store.now();
  for(const [id,phase,reason,finished] of [
   ['one','failed','private_network',at-1],['two','failed','private_network',at],
   ['three','failed','bad https://example.invalid',at+1],['four','done',undefined,at],
   ['five','pending',undefined,undefined],['six','leased',undefined,undefined],
   ['seven','failed','constructor',at-2],
  ] as const)f.store.put('collection_jobs',id,{source_id:source.id,phase,failure_reason:reason,finished_at:finished});
  expect(f.store.jobSummary().sources.fixture).toEqual({done:1,failed:4,pending:2,failures:{private_network:2,error:1,constructor:1},last_failure:{reason:'error',at:new Date(at+1).toISOString()}});
 }finally{f.close();}
});

test('browser routes use the same trusted transport and abort private redirect hops',async()=>{
 const f=fixture();try{
  let routeHandler:(route:Route)=>Promise<void>=async()=>{throw new Error('route_missing');};
  const aborted=vi.fn(),fulfilled=vi.fn(),closed=vi.fn();
  const route=(path:string)=>({request:()=>({resourceType:()=> 'document',method:()=> 'GET',url:()=>source.origin+path}),abort:aborted,fulfill:fulfilled}) as unknown as Route;
  const browser={newContext:async()=>({
   routeWebSocket:async()=>{},route:async(_pattern:string,handler:typeof routeHandler)=>{routeHandler=handler;},
   newPage:async()=>({goto:async()=>{await routeHandler(route('/'));await routeHandler(route('/redirect'));},url:()=>source.entries[0],evaluate:async()=>({title:'fixture',documentOrigin:source.origin,text:'',locator:'main'})}),
  }),close:closed};
  vi.mocked(chromium.launch).mockResolvedValueOnce(browser as never);
  let ip='198.18.0.1';
  const scheduler=new Scheduler(f.store,async(url:URL):Promise<NetworkResponse>=>{
   if(!addressAllowed(ip,trusted))throw new CollectorError('private_network');
   if(url.pathname==='/redirect'){ip='10.0.0.1';return {status:302,headers:{location:'/internal'},body:''};}
   return {status:url.pathname==='/robots.txt'?404:200,headers:{},body:'<main></main>'};
  },async ms=>{f.advance(ms);});
  await browserExtract(source.entries[0],{...source,browser:true},scheduler);
  expect(fulfilled).toHaveBeenCalledTimes(1);expect(aborted).toHaveBeenCalledTimes(1);expect(closed).toHaveBeenCalledTimes(1);
 }finally{f.close();}
});
