import type { RequestMeter } from '../engine/types';
import { BLOCKED_CODES, failureCode } from './discovery/health';
import { addressAllowed, type Cidr } from './egress';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { CollectorStore, requireThat } from './store';
import { visitAllowed, type SourcePolicy } from './source-policy';
import { parseRobots, robotsAllows, type Robots, USER_AGENT } from '../lib/external/robots';
export type DomainState = { next_at:number; stopped:boolean; reason?:string; crawl_delay?:number };
export type NetworkResponse = {status:number;headers:Record<string,string>;body:string;bytes?:Buffer;finalUrl?:string};
export function publicAddress(ip:string) {
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88)||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19||b===51)||a===203&&b===0);}
  // Only global unicast; reject mapped IPv4, ULA, link-local, transition and documentation space.
  return isIP(ip)===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!/^2001:(?:db8|0|10|20):/i.test(ip)&&!/^2002:/i.test(ip);
}
export async function pinnedRequest(url:URL,maxBytes:number,trusted:Cidr[]=[],opts:{headers?:Record<string,string>}={}):Promise<NetworkResponse> {
  const addresses=await lookup(url.hostname,{all:true,verbatim:true});requireThat(addresses.length&&addresses.every(a=>addressAllowed(a.address,trusted)),'private_network');
  const chosen=addresses[0];
  return new Promise((resolve,reject)=>{
    let size=0;
    const fail=(code:string)=>reject(Object.assign(new Error(code),{received:Math.min(size,maxBytes)}));
    const req=request(url,{method:'GET',headers:{'user-agent':USER_AGENT,accept:'text/html,application/xml,application/json,text/plain,application/pdf,image/*',...opts.headers},lookup:(_host,options,cb)=>{if(options.all)(cb as unknown as (error:null,addresses:{address:string;family:number}[])=>void)(null,[chosen]);else cb(null,chosen.address,chosen.family);}},res=>{
      const chunks:Buffer[]=[];
      if(typeof res.read!=='function'){
        // Compatibility with event-only injected transports; real IncomingMessage uses bounded reads below.
        res.on('data',(chunk:Buffer)=>{const remaining=maxBytes-size;size+=Math.min(remaining,chunk.length);chunks.push(chunk.subarray(0,remaining));if(chunk.length>remaining){fail('response_size');res.destroy();}});
      }else res.on('readable',()=>{
        while(res.readableLength){
          const remaining=maxBytes-size;
          if(!remaining){fail('response_size');res.destroy();return;}
          const chunk=res.read(Math.min(remaining,res.readableLength)) as Buffer|null;
          if(!chunk)break;
          if(chunk.length>remaining){size+=remaining;chunks.push(chunk.subarray(0,remaining));fail('response_size');res.destroy();return;}
          size+=chunk.length;chunks.push(chunk);
        }
        res.read(0);
      });
      res.on('close',()=>clearTimeout(timer));
      res.on('error',()=>fail('network_error'));
      res.on('end',()=>resolve({status:res.statusCode??500,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v??''])),bytes:Buffer.concat(chunks),body:Buffer.concat(chunks).toString('utf8')}));
    });
    const timeout=()=>{fail('request_timeout');req.destroy();};
    const timer=setTimeout(timeout,30000);
    req.on('close',()=>clearTimeout(timer));
    req.setTimeout(30000,timeout);req.on('error',(e)=>fail(e.message==='request_timeout'?'request_timeout':'network_error'));req.end();
  });
}
export class Scheduler {
  private blockedBySource=new Map<string,Record<string,number>>();
  takeBlocked(){const counts=this.blockedBySource;this.blockedBySource=new Map();return counts;}
  private tails=new Map<string,Promise<unknown>>();
  private robots=new Map<string,Robots>();
  constructor(readonly store:CollectorStore,readonly transport=pinnedRequest,readonly sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms)),readonly meter?:RequestMeter,readonly minimumInterval=store.settings.limits.min_interval_ms) {}
  async slot<T>(domain:string,task:()=>Promise<T>):Promise<T> {
    const previous=this.tails.get(domain)??Promise.resolve();
    const run=previous.catch(()=>{}).then(async()=>{let d=this.store.get<DomainState>('domain_state',domain)??{next_at:0,stopped:false};requireThat(!d.stopped,'domain_stopped',403);const wait=d.next_at-this.store.now();if(wait>0)await this.sleep(wait);d=this.store.get<DomainState>('domain_state',domain)??d;requireThat(!d.stopped,'domain_stopped',403);try{return await task();}finally{const latest=this.store.get<DomainState>('domain_state',domain)??d;latest.next_at=Math.max(latest.next_at,this.store.now()+Math.max(5000,this.minimumInterval,this.store.settings.limits.min_interval_ms,latest.crawl_delay??0));this.store.transaction(()=>this.store.put('domain_state',domain,latest));}});
    this.tails.set(domain,run);return run;
  }
  private async raw(url:URL,opts:{headers?:Record<string,string>}={}):Promise<NetworkResponse> {
    return this.slot(url.hostname,async()=>{
      const ticket=this.meter?.hold(this.store.settings.limits.max_bytes);
      let received=0;
      try {
        const res=await this.transport(url,this.store.settings.limits.max_bytes,[],opts);
        received=res.bytes?.length??Buffer.byteLength(res.body);
        const textual=/text|html|xml|json/i.test(res.headers['content-type']??'text/plain');
        const blocked=textual&&/captcha|access denied|접근.{0,5}차단/i.test(res.body);
        if(res.status===403||res.status===429||res.status>=500||blocked){
          const d=this.store.get<DomainState>('domain_state',url.hostname)??{next_at:0,stopped:false};
          const retry=res.headers['retry-after'];const retryAt=/^\d+$/.test(retry??'')?this.store.now()+Number(retry)*1000:Date.parse(retry??'');
          d.stopped=res.status===403||blocked;d.reason=d.stopped?'blocked':'cooldown';d.next_at=Math.max(this.store.now()+60000,Number.isFinite(retryAt)?retryAt:0);
          this.store.transaction(()=>this.store.put('domain_state',url.hostname,d));
          throw Object.assign(new Error(d.stopped?'source_blocked':'source_cooldown'),{next_at:d.next_at});
        }
        return {...res,finalUrl:url.href};
      } catch(e){received=Math.max(received,Number((e as {received?:number}).received??0));throw e;}
      finally{if(ticket)this.meter!.settle(ticket,received);}
    });
  }
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
  async get(raw:string,source:SourcePolicy,opts:{headers?:Record<string,string>}={}):Promise<NetworkResponse> {
    try{return await this.fetchWithin(raw,source,0,opts);}catch(e){
      const code=failureCode(e);
      if(BLOCKED_CODES.has(code)){
        const counts=this.blockedBySource.get(source.id)??{};counts[code]=(counts[code]??0)+1;this.blockedBySource.set(source.id,counts);
      }
      throw e;
    }
  }
  private async fetchWithin(raw:string,source:SourcePolicy,hop:number,opts:{headers?:Record<string,string>}):Promise<NetworkResponse> {
    requireThat(hop<=3&&visitAllowed(raw,source),'visit_not_allowed',403);const u=new URL(raw),robots=await this.robotsFor(source);requireThat(robotsAllows(robots,u.pathname+u.search),'robots_denied',403);
    const res=await this.raw(u,opts);if(res.status===304&&Object.keys(opts.headers??{}).some(k=>/^if-(none-match|modified-since)$/i.test(k)))return res;if(res.status>=300&&res.status<400){requireThat(res.headers.location,'redirect_missing');const next=new URL(res.headers.location,u);if(/\/(?:accounts\/login|login|checkpoint)(?:\/|$)/i.test(next.pathname))throw new Error('login_required');return this.fetchWithin(next.href,source,hop+1,opts);}if(!(res.status>=200&&res.status<300))throw Object.assign(new Error('source_response'),{http_status:res.status});return res;
  }
}
