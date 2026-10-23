import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { CollectorStore, requireThat } from './store';
import { visitAllowed, type SourcePolicy } from './source-policy';
import { parseRobots, robotsAllows, type Robots, USER_AGENT } from '../lib/external/robots';
export type DomainState = { next_at:number; stopped:boolean; reason?:string; crawl_delay?:number };
export type NetworkResponse = {status:number;headers:Record<string,string>;body:string};
export function publicAddress(ip:string) {
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88)||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19||b===51)||a===203&&b===0);}
  // Only global unicast; reject mapped IPv4, ULA, link-local, transition and documentation space.
  return isIP(ip)===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!/^2001:(?:db8|0|10|20):/i.test(ip)&&!/^2002:/i.test(ip);
}
export async function pinnedRequest(url:URL,maxBytes:number):Promise<NetworkResponse> {
  const addresses=await lookup(url.hostname,{all:true,verbatim:true});requireThat(addresses.length&&addresses.every(a=>publicAddress(a.address)),'private_network');
  const chosen=addresses[0];
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'GET',headers:{'user-agent':USER_AGENT,accept:'text/html,application/xml,application/json,text/plain'},lookup:(_host,options,cb)=>{if(options.all)(cb as unknown as (error:null,addresses:{address:string;family:number}[])=>void)(null,[chosen]);else cb(null,chosen.address,chosen.family);}},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(new Error('response_size'));}else chunks.push(chunk);});
      res.on('close',()=>clearTimeout(timer));
      res.on('error',()=>reject(new Error('network_error')));
      res.on('end',()=>resolve({status:res.statusCode??500,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v??''])),body:Buffer.concat(chunks).toString('utf8')}));
    });
    const timer=setTimeout(()=>req.destroy(new Error('request_timeout')),30000);
    req.on('close',()=>clearTimeout(timer));
    req.setTimeout(30000,()=>req.destroy(new Error('request_timeout')));req.on('error',()=>reject(new Error('network_error')));req.end();
  });
}
export class Scheduler {
  private tails=new Map<string,Promise<unknown>>();
  private robots=new Map<string,Robots>();
  constructor(readonly store:CollectorStore,readonly transport=pinnedRequest,readonly sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))) {}
  async slot<T>(domain:string,task:()=>Promise<T>):Promise<T> {
    const previous=this.tails.get(domain)??Promise.resolve();
    const run=previous.catch(()=>{}).then(async()=>{let d=this.store.get<DomainState>('domain_state',domain)??{next_at:0,stopped:false};requireThat(!d.stopped,'domain_stopped',403);const wait=d.next_at-this.store.now();if(wait>0)await this.sleep(wait);d=this.store.get<DomainState>('domain_state',domain)??d;requireThat(!d.stopped,'domain_stopped',403);try{return await task();}finally{const latest=this.store.get<DomainState>('domain_state',domain)??d;latest.next_at=Math.max(latest.next_at,this.store.now()+Math.max(this.store.settings.limits.min_interval_ms,latest.crawl_delay??0));this.store.transaction(()=>this.store.put('domain_state',domain,latest));}});
    this.tails.set(domain,run);return run;
  }
  private async raw(url:URL):Promise<NetworkResponse> {return this.slot(url.hostname,async()=>{const res=await this.transport(url,this.store.settings.limits.max_bytes);if(res.status===403||res.status===429||res.status>=500||/captcha|access denied|접근.{0,5}차단/i.test(res.body)){const d=this.store.get<DomainState>('domain_state',url.hostname)??{next_at:0,stopped:false};const retry=res.headers['retry-after'];const retryAt=/^\d+$/.test(retry??'')?this.store.now()+Number(retry)*1000:Date.parse(retry??'');d.stopped=res.status===403||/captcha|access denied|접근.{0,5}차단/i.test(res.body);d.reason=d.stopped?'blocked':'cooldown';d.next_at=Math.max(this.store.now()+60000,Number.isFinite(retryAt)?retryAt:0);this.store.transaction(()=>this.store.put('domain_state',url.hostname,d));throw new Error('source_cooldown');}return res;});}
  async robotsFor(source:SourcePolicy) {
    if(this.robots.has(source.origin))return this.robots.get(source.origin)!;
    const res=await this.raw(new URL('/robots.txt',source.origin));
    requireThat(res.status===404||res.status>=200&&res.status<300,'robots_unavailable',403);
    const rules=parseRobots(res.status===404?'':res.body);this.robots.set(source.origin,rules);
    // Conservative maximum also respects a slower site's Crawl-delay.
    const delays=[...res.body.matchAll(/^crawl-delay:\s*([\d.]+)/gim)].map(x=>Number(x[1])*1000);
    if(delays.length){const domain=new URL(source.origin).hostname;const d=this.store.get<DomainState>('domain_state',domain)!;d.crawl_delay=Math.max(...delays);d.next_at=Math.max(d.next_at,this.store.now()+d.crawl_delay);this.store.transaction(()=>this.store.put('domain_state',domain,d));}
    return rules;
  }
  async get(raw:string,source:SourcePolicy,hop=0):Promise<NetworkResponse> {
    requireThat(hop<=3&&visitAllowed(raw,source),'visit_not_allowed',403);const u=new URL(raw),robots=await this.robotsFor(source);requireThat(robotsAllows(robots,u.pathname+u.search),'robots_denied',403);
    const res=await this.raw(u);if(res.status>=300&&res.status<400){requireThat(res.headers.location,'redirect_missing');return this.get(new URL(res.headers.location,u).href,source,hop+1);}requireThat(res.status>=200&&res.status<300,'source_response',502);return res;
  }
}
