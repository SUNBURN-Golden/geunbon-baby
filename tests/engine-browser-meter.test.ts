import { clipperDom } from './helpers/clipper-dom';
import { extractRegion } from '../shared/dom-extract';
import { expect, test, vi } from 'vitest';
import { chromium, type Route } from 'playwright';
import { CostLedger, CostCapError, JobEngine } from '../crawler/engine';
import { renderDocument } from '../crawler/src/discovery/browser';
import { Scheduler } from '../crawler/src/scheduler';
import { fixture, source } from './helpers/collector';
import { noop } from './helpers/engine';
function mockPage(){
 let handler:(route:Route)=>Promise<unknown>=async()=>{};
 const fulfills:string[]=[],aborts:string[]=[];
 const close=vi.fn();
 vi.mocked(chromium.launch).mockResolvedValueOnce({newContext:async()=>({routeWebSocket:async()=>{},route:async(_pattern:string,h:typeof handler)=>{handler=h;},newPage:async()=>({
  goto:async()=>{for(const [path,type,method] of [['/model','document','GET'],['/script','script','GET'],['/style','stylesheet','GET'],['/xhr','xhr','GET'],['/image','image','GET'],['/post','fetch','POST']])await handler({request:()=>({resourceType:()=>type,method:()=>method,url:()=>source.origin+path}),fulfill:async()=>{fulfills.push(path);},abort:async()=>{aborts.push(path);}} as unknown as Route);},
  url:()=>source.origin+'/model',evaluate:async()=>({html:'Example stroller specifications example_only',text:'Example stroller specifications example_only',title:'Example stroller',locator:'main'}),
 })}),close} as never);
 return {fulfills,aborts,close};
}
test.each([4,3])('browser reuses the downloaded main document and meters each allowed subrequest (cap=%s)',async cap=>{
 const f=fixture();try{
  const e=new JobEngine(f.store,'fake',['a'],{a:noop()}),r=e.startRun({kind:'test',at:'one'}),l=new CostLedger(f.store,'fake',{run:{requests:cap,bytes:30000000,model_calls:0},day:{requests:20,bytes:40000000,model_calls:0}}).open(r);
  const transport=vi.fn(async(url:URL)=>({status:200,headers:{'content-type':'text/plain'},body:url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':'example_only'}));
  const scheduler=new Scheduler(f.store,transport,async ms=>f.advance(ms),l),browser=mockPage();
  const result=renderDocument(source.origin+'/model',{...source,browser:true},scheduler,{expectedUrl:source.origin+'/model',urlIdentityVersion:2,document:{status:200,headers:{'content-type':'text/html'},body:'Example stroller shell'}});
  if(cap===4)await expect(result).resolves.toMatchObject({text:'Example stroller specifications example_only'});else await expect(result).rejects.toBeInstanceOf(CostCapError);
  expect(transport).toHaveBeenCalledTimes(cap);expect(transport.mock.calls.some(([u])=>u.pathname==='/model')).toBe(false);expect(transport.mock.calls.some(([u])=>['/image','/post'].includes(u.pathname))).toBe(false);
  expect(browser.close).toHaveBeenCalledTimes(1);expect((f.store.db.prepare('SELECT spent FROM engine_costs WHERE id=?').get(`run:${r}:requests`) as {spent:number}).spent).toBe(cap);
 }finally{f.close();}
});

test.each(['region','snapshot'] as const)('Linux evaluates a bound %s callback and rejects navigation before DOM reads',async mode=>{
 const f=fixture(),url=source.origin+'/model?id=A',dom=clipperDom(source.origin+'/model?id=B');
 try{
  const evaluate=vi.fn(async(fn:typeof extractRegion,arg:Parameters<typeof extractRegion>[0])=>dom.run([arg],fn));
  vi.mocked(chromium.launch).mockResolvedValueOnce({newContext:async()=>({routeWebSocket:async()=>{},route:async()=>{},newPage:async()=>({goto:async()=>{},url:()=>source.origin+'/model?id=B',evaluate})}),close:async()=>{}} as never);
  await expect(renderDocument(url,{...source,browser:true},new Scheduler(f.store),{expectedUrl:url,urlIdentityVersion:2,legacy:mode==='region'})).rejects.toThrow('document_changed');
  expect(evaluate).toHaveBeenCalledTimes(1);expect(dom.reads).not.toHaveBeenCalled();
 }finally{f.close();}
});
test('navigation between Linux snapshot and region checks discards snapshot and reads no changed DOM',async()=>{
 const f=fixture(),url=source.origin+'/model?id=A',dom=clipperDom(url);let before=0;
 try{
  const evaluate=vi.fn(async(fn:typeof extractRegion,arg:Parameters<typeof extractRegion>[0])=>{
   const result=dom.run([arg],fn);
   if(arg.mode==='snapshot'){before=dom.reads.mock.calls.length;dom.navigate(source.origin+'/model?id=B');}
   return result;
  });
  vi.mocked(chromium.launch).mockResolvedValueOnce({newContext:async()=>({routeWebSocket:async()=>{},route:async()=>{},newPage:async()=>({goto:async()=>{},url:()=>url,evaluate})}),close:async()=>{}} as never);
  await expect(renderDocument(url,{...source,browser:true},new Scheduler(f.store),{expectedUrl:url,urlIdentityVersion:2})).rejects.toThrow('document_changed');
  expect(evaluate).toHaveBeenCalledTimes(2);expect(before).toBeGreaterThan(0);expect(dom.reads).toHaveBeenCalledTimes(before);
 }finally{f.close();}
});
