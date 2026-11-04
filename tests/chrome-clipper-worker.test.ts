import { expect, test, vi } from 'vitest';
import { fixture, binding } from './helpers/collector';
import { clipperDom } from './helpers/clipper-dom';
import { canonicalUrl } from '../shared/privacy-rules';
import type { Binding } from '../shared/collection-schema';
import type { extractRegion } from '../shared/dom-extract';
import type { ClipJob } from '../tools/chrome-clipper/src/delivery';

vi.mock('../tools/chrome-clipper/src/approved',()=>({
 approved:[],policies:[{origin:'https://gear.example.org',paths:['/'],query_keys:['id','page'],brand:'Stokke'}],policyVersion:1,
}));

function workerHarness(){
 const f=fixture(),dom=clipperDom();
 const disk:Record<string,unknown>={settings:{token:'offline-fixture-token-not-a-credential'}};
 let click:(tab:{id:number;url:string})=>void=()=>{},alarm:()=>void=()=>{};
 const onEvent={addListener:vi.fn()};
 const badge=vi.fn<(value:{text:string})=>Promise<void>>(async()=>{});
 const scans=vi.fn();
 const execute=vi.fn(async(options:{target:{tabId:number};world:string;func:typeof extractRegion;args:Parameters<typeof extractRegion>})=>{
  expect(options.target).toEqual({tabId:7});expect(options.world).toBe('ISOLATED');
  return [{result:dom.run(options.args,options.func)}];
 });
 const local={setAccessLevel:vi.fn(async()=>{}),get:vi.fn(async(key:string|null)=>{
  if(key===null)scans();return JSON.parse(JSON.stringify(key===null?disk:{[key]:disk[key]}));
 }),set:vi.fn(async(items:Record<string,unknown>)=>{Object.assign(disk,JSON.parse(JSON.stringify(items)));})};
 vi.stubGlobal('chrome',{
  storage:{local},action:{onClicked:{addListener:(fn:typeof click)=>{click=fn;}},setBadgeText:badge},
  scripting:{executeScript:execute},tabs:{query:vi.fn(async()=>[])},
  alarms:{create:vi.fn(async()=>{}),onAlarm:{addListener:(fn:typeof alarm)=>{alarm=fn;}}},
  runtime:{onStartup:onEvent,onInstalled:onEvent},permissions:{contains:vi.fn(async()=>true),onRemoved:onEvent},
 });
 const calls=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async(raw:string,init:RequestInit)=>{
  const path=new URL(raw).pathname,body=init.body?JSON.parse(String(init.body)):undefined;
  calls(path,body);
  let data:unknown;
  if(path.includes('/clips/'))data=f.store.clip('extension',path.split('/').at(-1)!);
  else if(path==='/v1/intake/reservations')data=f.store.reserve('extension',body as Binding);
  else if(path.endsWith('/start'))data=f.store.start('extension',path.split('/').at(-2)!);
  else if(path==='/v1/intake')data=f.store.submit('extension',body.reservation_id,body.payload);
  else throw new Error('unexpected_request');
  return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
 }));
 vi.spyOn(Date,'now').mockImplementation(f.now);
 const jobs=()=>Object.entries(disk).filter(([key])=>key.startsWith('clip:')).map(([,value])=>JSON.parse(JSON.stringify(value)) as ClipJob);
 return {
  f,dom,disk,jobs,execute,badge,calls,
  boot:async()=>{vi.resetModules();const before=scans.mock.calls.length;await import('../tools/chrome-clipper/src/service-worker');await vi.waitFor(()=>expect(scans.mock.calls.length).toBeGreaterThan(before));},
  click:(url:string)=>click({id:7,url}),
  alarm:()=>alarm(),
  settled:async(phase:ClipJob['phase'])=>{await vi.waitFor(()=>expect(jobs().at(-1)?.phase).toBe(phase));},
 };
}

const product='https://gear.example.org/product';
test.each([
 [product+'?id=A',product+'?id=B',false],
 [product+'?id=A',product,false],
 [product,product+'?id=B',false],
 [product+'?page=1&id=A',product+'?id=A&page=1',true],
 [product+'?id=A&utm_source=old',product+'?utm_source=new&fbclid=new&id=A#details',true],
 [product+'?id=A','https://gear.example.org/other?id=A',false],
])('actual worker passes the reserved URL and handles navigation %s → %s',async(reserved,current,same)=>{
 const h=workerHarness();try{
  await h.boot();
  // The click's tab URL is A; execution happens after the tab has navigated.
  h.dom.navigate(current);h.click(reserved);await h.settled(same?'complete':'needs_reclick');
  expect(h.execute).toHaveBeenCalledTimes(1);expect(h.execute.mock.calls[0][0].args).toEqual(['',true,canonicalUrl(reserved)]);
  expect(h.jobs()[0].url).toBe(canonicalUrl(reserved));
  if(same){expect(h.f.store.list('intake_receipts')).toHaveLength(1);expect(h.badge).toHaveBeenLastCalledWith({text:'접수'});}
  else {
   expect(h.dom.reads).not.toHaveBeenCalled();expect(h.jobs()[0].payload).toBeUndefined();expect(h.badge).toHaveBeenLastCalledWith({text:'재클릭'});
   expect(h.calls.mock.calls.some(([path])=>path==='/v1/intake')).toBe(false);
   expect(h.f.store.list('evidence_assertions')).toHaveLength(0);expect(h.f.store.list('intake_receipts')).toHaveLength(0);
  }
 }finally{h.f.close();}
});

test.each(['reserved','extracting'] as const)('actual worker recovers %s on B without delivering B under A',async phase=>{
 const h=workerHarness(),a=product+'?id=A',b=product+'?id=B';try{
  const input=binding(a),held=h.f.store.reserve('extension',input);
  const reservation=phase==='extracting'?h.f.store.start('extension',held.id):held;
  const job:ClipJob={...input,schema_version:1,tab_id:7,phase,reservation,next_retry_at:0};
  h.disk[`clip:${job.clip_id}`]=JSON.parse(JSON.stringify(job));h.f.reopen();h.dom.navigate(b);
  await h.boot();await h.settled('needs_reclick');
  expect(h.jobs()[0].url).toBe(a);expect(h.dom.reads).not.toHaveBeenCalled();expect(h.badge).toHaveBeenLastCalledWith({text:'재클릭'});
  expect(h.execute).toHaveBeenCalledTimes(phase==='reserved'?1:0);
  if(phase==='reserved')expect(h.execute.mock.calls[0][0].args[2]).toBe(a);
  expect(h.f.store.list('evidence_assertions')).toHaveLength(0);expect(h.f.store.list('intake_receipts')).toHaveLength(0);
  const priorCalls=h.calls.mock.calls.length;
  h.f.reopen();await h.boot();h.alarm();await new Promise<void>(resolve=>setImmediate(resolve));
  expect(h.calls).toHaveBeenCalledTimes(priorCalls);expect(h.dom.reads).not.toHaveBeenCalled();expect(h.f.store.list('intake_reservations')).toHaveLength(1);
  h.click(b);await h.settled('complete');
  expect(h.jobs()).toHaveLength(2);expect(h.jobs()[0].phase).toBe('needs_reclick');
  expect(h.jobs()[1].url).toBe(b);expect(h.jobs()[1].attempt_id).not.toBe(job.attempt_id);
  expect(h.f.store.list('intake_reservations')).toHaveLength(2);expect(h.f.store.list('intake_receipts')).toHaveLength(1);
  expect(h.f.store.recordByUrl(a)?.title).toBeNull();expect(h.f.store.recordByUrl(b)?.title).toBe('Product');
 }finally{h.f.close();}
});
