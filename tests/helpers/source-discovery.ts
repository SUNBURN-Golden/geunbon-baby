import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, source } from './collector';
import { loadDiscoveryConfig } from '../../crawler/src/source-discovery/config';
import type { JsonProviderConfig } from '../../crawler/src/source-discovery/providers/types';
import { loadProfile } from '../../crawler/src/agamajung/profile';
import { RawStore } from '../../crawler/engine/raw-store';
import { Scheduler, type NetworkResponse } from '../../crawler/src/scheduler';
import { SourceDiscoveryRunner, type DiscoveryOptions } from '../../crawler/src/source-discovery/runner';
import { config } from '../../crawler/src/source-policy';
export const discoveryAsset=(name:string)=>readFileSync(new URL(`../fixtures/source-discovery/${name}`,import.meta.url),'utf8');
export const provider:JsonProviderConfig={id:'fixture-search',enabled:true,endpoint:'https://search.example.org/api/search',query_param:'q',cursor_param:'cursor',results_path:'results',url_path:'url',title_path:'title',summary_path:'summary',next_cursor_path:'next',terms:{status:'approved',basis:'Synthetic fixture permission only',checked_at:'2026-10-01T00:00:00Z',storage:'snippets',cursor_storage:true}};
export const productPolicies=()=>['product_no','sku'].map(key=>({host:'new-gear.example.org',path:key==='sku'?'/sku':'/item',version:`fixture-${key}@1`,keys:{[key]:{format:'code' as const,max_length:40}},required_keys:[key],duplicates:'reject' as const}));
export function discoveryFixture(options:DiscoveryOptions={}){
  const settings=structuredClone(config);settings.sources=[{...source,selector:'main',entries:[source.origin+'/list']}];
  const f=fixture(settings),cfg=loadDiscoveryConfig();cfg.enabled=true;cfg.providers=[structuredClone(provider)];cfg.max_queries=1;
  cfg.url_policies=productPolicies();
  const profile=loadProfile();profile.domain_policy.sources={[source.id]:{tier:'manufacturer',render:false,raw:'hash_only',content_types:['text/html','application/xml']}};
  const calls:{url:string;headers:Record<string,string>}[]=[];
  let response:(url:URL)=>NetworkResponse|Promise<NetworkResponse>=url=>({status:200,headers:{'content-type':url.hostname==='search.example.org'?'application/json':'text/html'},body:url.hostname==='search.example.org'?discoveryAsset('search.json'):discoveryAsset('list.html')});
  const scheduler=()=>new Scheduler(f.store,async(url,_m,_t,opts)=>{calls.push({url:url.href,headers:opts?.headers??{}});return url.pathname==='/robots.txt'?{status:200,headers:{'content-type':'text/plain'},body:'User-agent: *\nAllow: /'}:response(url);},async ms=>f.advance(ms));
  const raw=new RawStore(join(f.dir,'raw'),'agamajung',process.cwd(),f.now);
  const make=()=>new SourceDiscoveryRunner(f.store,raw,cfg,{scheduler:scheduler(),profile,...options});let runner=make();
  return {...f,get store(){return f.store;},cfg,profile,raw,calls,scheduler,make,get runner(){return runner;},response:(fn:typeof response)=>{response=fn;},reopen:()=>{f.reopen();runner=make();return runner;},close:()=>f.close()};
}
export async function discover(f:ReturnType<typeof discoveryFixture>,slot='one'){
 const id=f.runner.start({kind:'test',at:slot});f.runner.seed(id);await f.runner.run(id);return id;
}
export const rows=(f:ReturnType<typeof discoveryFixture>,table:string)=>f.store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];
