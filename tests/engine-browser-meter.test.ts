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
  const result=renderDocument(source.origin+'/model',{...source,browser:true},scheduler,{document:{status:200,headers:{'content-type':'text/html'},body:'Example stroller shell'}});
  if(cap===4)await expect(result).resolves.toMatchObject({text:'Example stroller specifications example_only'});else await expect(result).rejects.toBeInstanceOf(CostCapError);
  expect(transport).toHaveBeenCalledTimes(cap);expect(transport.mock.calls.some(([u])=>u.pathname==='/model')).toBe(false);expect(transport.mock.calls.some(([u])=>['/image','/post'].includes(u.pathname))).toBe(false);
  expect(browser.close).toHaveBeenCalledTimes(1);expect((f.store.db.prepare('SELECT spent FROM engine_costs WHERE id=?').get(`run:${r}:requests`) as {spent:number}).spent).toBe(cap);
 }finally{f.close();}
});
