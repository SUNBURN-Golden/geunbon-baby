import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, source } from './collector';
import { config, type SourcePolicy } from '../../crawler/src/source-policy';
import { loadProfile } from '../../crawler/src/agamajung/profile';
import { AgamajungPipeline, type PipelineOptions } from '../../crawler/src/agamajung/pipeline';
import { RawStore } from '../../crawler/engine/raw-store';
import { Scheduler, type NetworkResponse } from '../../crawler/src/scheduler';
import type { StageHandler } from '../../crawler/engine';
export const asset=(name:string)=>readFileSync(new URL(`../fixtures/collector-engine/${name}`,import.meta.url),'utf8');
export function engineFixture(body=asset('spec.html'),overrides:Partial<SourcePolicy>={},options:PipelineOptions={}){
  const s={...source,selector:'main',entries:[`${source.origin}/model`],...overrides};
  const f=fixture({...structuredClone(config),sources:[s]});
  const profile=loadProfile(config);profile.domain_policy.sources={[s.id]:{tier:'manufacturer',render:s.browser,raw:'hash_only',content_types:['text/html','application/pdf','image/png','application/json']}};
  const calls:{url:string;headers:Record<string,string>}[]=[];
  let response:(url:URL,headers:Record<string,string>)=>Promise<NetworkResponse>|NetworkResponse=()=>({status:200,headers:{'content-type':'text/html',etag:'"example-v1"'},body});
  const scheduler=new Scheduler(f.store,async(url,_max,_trusted,opts)=>{calls.push({url:url.href,headers:opts?.headers??{}});return url.pathname==='/robots.txt'?{status:200,headers:{'content-type':'text/plain'},body:asset('robots.txt')}:response(url,opts?.headers??{});},async ms=>f.advance(ms));
  const raw=new RawStore(join(f.dir,'raw'),'agamajung',process.cwd(),f.now);
  const make=()=>new AgamajungPipeline(f.store,raw,profile,{scheduler,...options});
  let pipeline=make();
  return {...f,get store(){return f.store;},source:s,profile,raw,calls,get pipeline(){return pipeline;},response:(fn:typeof response)=>{response=fn;},reopen:()=>{f.reopen();pipeline=make();return pipeline;},close:()=>f.close()};
}
export const noop=(run:StageHandler['run']=async()=>({})):StageHandler=>({kind:'transactional',version:'test@1',run});
