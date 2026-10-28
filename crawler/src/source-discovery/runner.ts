import { JobEngine } from '../../engine/state-machine';
import { Downloader } from '../../engine/download';
import { RawStore } from '../../engine/raw-store';
import { SqliteStorage } from '../../engine/storage';
import { CostCapError, type Checkpoint, type Data, type StageHandler } from '../../engine/types';
import { dayKey, digest, hashBytes, stable } from '../../engine/util';
import { agamajungCosts } from '../agamajung/cost-policy';
import { loadProfile, validateProfile, type Profile } from '../agamajung/profile';
import { CollectorStore, requireThat } from '../store';
import { Scheduler, type DomainState } from '../scheduler';
import { visitAllowed, type SourcePolicy } from '../source-policy';
import { cleanText, extractDocument } from '../discovery/document';
import { SourceCandidateStore, type CandidateObservation } from './store';
import { loadDiscoveryConfig, validateDiscoveryConfig, linkCacheTool, type DiscoveryConfig } from './config';
import { combinationAt, combinationCount, feedbackQueries, resolvedYears } from './queries';
import { explicitSubjects, subjectsFromFacts, type ExistingFact } from './entities';
import { relevance } from './relevance';
import { JsonApiSearchProvider } from './providers/json-api';
import { providerApproved, validCursor, type JsonProviderConfig, type SearchProvider } from './providers/types';
import { candidateUrl } from './url-policy';
import type { DocumentLinks, SearchQuery, Subject } from './types';
import { enumerateSlots } from '../missing-field/targets';
import { inputDigest } from '../missing-field/evaluate';
export const DISCOVERY_RUN_ID='agamajung-source-discovery';
const VERSION='source-discovery@1';
type Work={kind:'document'|'search'|'capture';depth:number;page:number;ancestry:string[];source_id?:string;url?:string;query?:SearchQuery;provider_id?:string;cursor?:string;cursor_history?:string[];parent_id?:string;origin_capture?:string;subject?:Subject;capture_id?:string};
type Capture={id:string;run_id:string;url_norm:string;source_id:string;content_hash:string;fetched_at:string;data:string};
type ResponseCache={document:DocumentLinks;nextCursor?:string};
export type DiscoveryOptions={scheduler?:Scheduler;profile?:Profile;offline?:boolean;fault?:(point:string)=>void;rng?:()=>number;health?:(code:string)=>void;provider?:(config:JsonProviderConfig,scheduler:Scheduler)=>SearchProvider};
export class SourceDiscoveryRunner {
  readonly engine:JobEngine;
  readonly ledger:ReturnType<typeof agamajungCosts>;
  readonly storage:SqliteStorage;
  readonly candidates:SourceCandidateStore;
  readonly profile:Profile;
  readonly transport:Scheduler;
  private schedulers=new Map<string,Scheduler>();
  constructor(readonly store:CollectorStore,readonly raw:RawStore,readonly config:DiscoveryConfig=loadDiscoveryConfig(),readonly options:DiscoveryOptions={}){
    validateDiscoveryConfig(config);this.profile=validateProfile(options.profile??loadProfile(store.settings),store.settings);this.transport=options.scheduler??new Scheduler(store);
    this.candidates=new SourceCandidateStore(store,config);this.storage=new SqliteStorage(store);
    this.ledger=agamajungCosts(store,this.profile,config.cost_caps.run);if(!options.offline)this.ledger.recoverOrphans();
    const handlers:Record<string,StageHandler>={
      plan:{kind:'transactional',version:VERSION,run:async()=>({nextStage:null}),commit:(_r,c)=>this.planInside(c)},
      request:{kind:'transactional',version:VERSION,run:c=>this.request(c),commit:(r)=>{
        const cap=r.data?.capture as Data|undefined,cache=r.data?.cache as ResponseCache|undefined;
        if(cap){this.storage.capture(cap);this.storage.cache(String(cap.content_hash),'source-discovery',this.responseTool(String(cap.id)),cache);}
        return {data:{capture_id:r.data!.capture_id}};
      }},
      apply:{kind:'transactional',version:VERSION,run:async()=>({nextStage:null}),commit:(_r,c)=>this.applyInside(c)}
    };
    this.engine=new JobEngine(store,DISCOVERY_RUN_ID,['plan','request','apply'],handlers,{fault:options.fault,rng:options.rng,maxAttempts:3,onHalt:(c,code)=>{
      const work=c.data as unknown as Work,source=this.store.settings.sources.find(s=>s.id===work.source_id),provider=config.providers.find(p=>p.id===work.provider_id);
      const origin=source?.origin??(provider?new URL(provider.endpoint).origin:undefined);
      if(origin){const host=new URL(origin).hostname,d=store.get<DomainState>('domain_state',host)??{stopped:false,next_at:0};d.stopped=true;d.reason=code;store.put('domain_state',host,d);}
      options.health?.(code);
    }});
    if(!options.offline)raw.cleanup(store.now());
  }
  private providers(){return this.config.providers.filter(providerApproved);}
  private approvedSources(){return this.store.settings.sources.filter(s=>s.enabled&&this.config.source_ids.includes(s.id)&&this.profile.domain_policy.sources[s.id]&&!s.browser&&s.adapter!=='cpsc'&&!this.denied(new URL(s.origin).hostname)).sort((a,b)=>this.profile.domain_policy.start_order.indexOf(this.profile.domain_policy.sources[a.id].tier)-this.profile.domain_policy.start_order.indexOf(this.profile.domain_policy.sources[b.id].tier));}
  private denied(host:string){return [...this.profile.domain_policy.denied_hosts,'instagram.com','facebook.com','cdninstagram.com','fbcdn.net'].some(h=>host===h||host.endsWith(`.${h}`));}
  preview(){return {dry_run:true,enabled:this.config.enabled,providers:this.providers().map(p=>p.id),sources:this.approvedSources().map(s=>s.id),years:resolvedYears(this.config,this.store.now()),planned_combinations:combinationCount(this.config,this.profile),query_limit:this.config.max_queries,max_depth:this.config.max_depth,min_relevance:this.config.min_relevance,shared_owner:'agamajung',shared_day_caps:this.profile.cost_caps.day,cost_caps:this.config.cost_caps,sample_queries:this.providers().flatMap(p=>{const q=combinationAt(0,this.config,this.profile,resolvedYears(this.config,this.store.now()),p.id);return q?[q.text]:[];})};}
  start(slot={kind:'daily',at:dayKey(this.store.now())}){
    const halted=this.store.db.prepare("SELECT id FROM engine_runs WHERE profile_id=? AND state='halted' ORDER BY started_at DESC LIMIT 1").get(DISCOVERY_RUN_ID) as {id:string}|undefined;
    if(halted)return halted.id;
    const id=this.engine.startRun({...slot,data:{years:resolvedYears(this.config,this.store.now()),planner_version:VERSION,plan:{regions:this.config.regions,languages:this.config.languages,events:this.config.events,categories:this.profile.categories,providers:this.providers().map(p=>p.id),max_queries:this.config.max_queries}}});this.ledger.open(id);return id;
  }
  resume(id:string){
    const run=this.engine.run(id);
    if(run?.profile_id===DISCOVERY_RUN_ID&&run.state==='halted'){
      requireThat(!this.store.list<DomainState>('domain_state').some(d=>d.stopped),'domain_stopped',403);
      this.store.transaction(()=>{
        this.store.db.prepare("UPDATE engine_runs SET state='running' WHERE id=?").run(id);
        this.store.db.prepare("UPDATE engine_checkpoints SET phase='pending' WHERE run_id=? AND phase='failed' AND error_code IN ('source_blocked','domain_stopped','login_required','access_restricted','empty_page')").run(id);
      });
    }
    this.engine.resume(id);this.ledger.open(id);return id;
  }
  seed(runId:string){
    if(!this.config.enabled||this.engine.run(runId)?.state!=='running'||JSON.parse(this.engine.run(runId)!.data).parent_run)return;
    this.store.transaction(()=>{
      const currentSlots=new Map(enumerateSlots(this.store).map(s=>[s.id,s]));
      const requests=this.store.db.prepare("SELECT l.action_id,l.ref,l.data,q.provider_id,q.data AS query_data,s.id AS slot_id,m.input_digest AS assessment_digest FROM missing_field_action_links l JOIN source_discovery_queries q ON q.id=l.ref JOIN missing_field_actions a ON a.id=l.action_id JOIN missing_field_slots s ON s.id=a.slot_id AND s.assessment_id=a.assessment_id JOIN missing_field_assessments m ON m.id=a.assessment_id WHERE l.kind='source_query' AND s.stale=0 AND NOT json_extract(m.data,'$.fulfilled') ORDER BY l.id").all() as {action_id:string;ref:string;data:string;provider_id:string;query_data:string;slot_id:string;assessment_digest:string}[];
      for(const request of requests){
        const slot=currentSlots.get(request.slot_id);
        if(!slot||inputDigest(this.store,slot)!==request.assessment_digest)continue;
        const context=JSON.parse(request.data),query=JSON.parse(request.query_data) as SearchQuery;
        if(this.searchInside(runId,query,request.provider_id,{depth:context.depth,ancestry:[],origin_capture:context.origin_capture})){
          const data=stable({run_id:runId,query_id:request.ref}),id=digest([request.action_id,'discovery_run',runId]);
          if(!this.store.db.prepare('SELECT 1 FROM missing_field_action_links WHERE id=?').get(id))this.store.db.prepare("INSERT INTO missing_field_action_links VALUES(?,?,'discovery_run',?,?)").run(id,request.action_id,runId,data);
          const checkpoints=this.store.db.prepare("SELECT id FROM engine_checkpoints WHERE run_id=? AND stage='request' AND json_extract(data,'$.query.id')=? AND json_extract(data,'$.provider_id')=?").all(runId,request.ref,request.provider_id);
          for(const c of checkpoints){const lid=digest([request.action_id,'checkpoint',c.id]),body=stable({run_id:runId,stage:'request'});if(!this.store.db.prepare('SELECT 1 FROM missing_field_action_links WHERE id=?').get(lid))this.store.db.prepare("INSERT INTO missing_field_action_links VALUES(?,?,'checkpoint',?,?)").run(lid,request.action_id,c.id,body);}
        }
      }
      this.engine.enqueueInside(runId,'plan','planner',{index:0},digest(0));
      for(const s of this.approvedSources())for(const url of s.entries.slice(0,Math.min(s.max_pages,this.config.max_pages)))this.documentInside(runId,{kind:'document',url,source_id:s.id,depth:0,page:0,ancestry:[]});
      // Reuse only existing collector captures, not this discoverer's own results. Depth
      // is inherited from the original capture cache; a daily rerun cannot reset it.
      const caps=this.store.db.prepare("SELECT c.* FROM engine_captures c JOIN engine_runs r ON r.id=c.run_id WHERE r.profile_id='agamajung' AND c.status IN ('ok','not_modified') ORDER BY c.fetched_at DESC LIMIT 500").all() as unknown as Capture[];
      for(const cap of caps){
        if(!this.store.settings.sources.some(s=>s.id===cap.source_id&&s.enabled&&this.profile.domain_policy.sources[s.id]))continue;
        const cached=this.findCached(cap);
        if(!cached)continue;
        const checkpoint=this.store.db.prepare("SELECT json_extract(data,'$.depth') depth FROM engine_checkpoints WHERE run_id=? AND json_extract(data,'$.capture_id')=? AND stage='fetch' LIMIT 1").get(cap.run_id,cap.id) as {depth:number}|undefined;
        const depth=JSON.parse(cap.data).discovery_depth??(cached.document as DocumentLinks&{depth?:number}).depth??checkpoint?.depth;
        if(!Number.isSafeInteger(depth)||depth<0)continue;
        const work:Work={kind:'capture',capture_id:cap.id,source_id:cap.source_id,depth,page:0,ancestry:[cap.url_norm]};
        this.enqueueInside(runId,work);
      }
    });
  }
  async run(id:string){this.ledger.open(id);return this.engine.runUntilIdle(id);}
  report(id:string){return {run_id:id,state:this.engine.run(id)?.state,candidates:(this.store.db.prepare('SELECT count(*) n FROM source_candidates').get() as {n:number}).n,truncated_checkpoints:(this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND json_extract(data,'$.truncated')=1").get(id) as {n:number}).n,checkpoints:this.store.db.prepare('SELECT phase,count(*) count FROM engine_checkpoints WHERE run_id=? GROUP BY phase').all(id)};}
  private enqueueInside(run:string,work:Work){const key=digest(work);this.engine.enqueueInside(run,'request',key,work as unknown as Data,digest(work));}
  private withinPages(run:string,source:SourcePolicy,url:string){
    if(this.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='request' AND json_extract(data,'$.kind')='document' AND json_extract(data,'$.source_id')=? AND json_extract(data,'$.url')=? LIMIT 1").get(run,source.id,url))return true;
    const count=this.store.db.prepare("SELECT count(DISTINCT json_extract(data,'$.url')) n FROM engine_checkpoints WHERE run_id=? AND stage='request' AND json_extract(data,'$.kind')='document' AND json_extract(data,'$.source_id')=?").get(run,source.id) as {n:number};
    return count.n<Math.min(source.max_pages,this.store.settings.limits.max_pages,this.config.max_pages);
  }
  private documentInside(run:string,work:Work){
    if(!work.url||work.depth>this.config.max_depth)return false;
    const destination=candidateUrl(work.url,this.config.url_policies);if(!destination.canonical_url)return false;work={...work,url:destination.canonical_url};
    if(work.ancestry.includes(work.url!))return false;
    const source=this.approvedSources().find(s=>visitAllowed(work.url!,s));if(!source)return false;
    if(!this.withinPages(run,source,work.url!))return false;
    this.enqueueInside(run,{...work,source_id:source.id});return true;
  }
  private searchInside(run:string,q:SearchQuery,p:string,context:Partial<Work>={}){
    if(!this.config.enabled||!this.providers().some(v=>v.id===p))return false;
    const depth=context.depth??0;if(depth>=this.config.max_depth||(context.ancestry??[]).includes(q.id))return false;
    const count=this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND stage='request' AND json_extract(data,'$.kind')='search'").get(run) as {n:number};
    if(count.n>=this.config.max_queries)return false;
    this.candidates.queryInside(p,q);
    this.enqueueInside(run,{kind:'search',page:0,ancestry:[],...context,depth,query:q,provider_id:p});return true;
  }
  private planInside(c:Checkpoint){
    const index=Number(c.data.index),run=JSON.parse(this.engine.run(c.run_id)!.data),years=run.years as string[]??resolvedYears(this.config,this.store.now());
    const plan=run.plan as {regions:string[];languages:string[];events:DiscoveryConfig['events'];categories:Profile['categories'];providers:string[];max_queries:number}|undefined;
    const cfg={...this.config,regions:plan?.regions??this.config.regions,languages:plan?.languages??this.config.languages,events:plan?.events??this.config.events,max_queries:plan?.max_queries??this.config.max_queries,years},profile={...this.profile,categories:plan?.categories??this.profile.categories},ps=plan?.providers??this.providers().map(p=>p.id);
    const provider=ps[index%ps.length],q=provider&&combinationAt(Math.floor(index/ps.length),cfg,profile,years,provider);
    if(q){this.searchInside(c.run_id,q,provider);if(index+1<Math.min(this.config.max_queries,cfg.max_queries,combinationCount(cfg,profile)*ps.length))this.engine.enqueueInside(c.run_id,'plan',`planner:${index+1}`,{index:index+1},digest(index+1));}
    return {nextStage:null,data:{planner_cursor:index,planned_truncated:combinationCount(cfg,profile)*ps.length>this.config.max_queries}};
  }
  private scheduler(work:Work,origin:string,provider?:JsonProviderConfig){
    const key=stable([work.source_id??'',origin,provider?.endpoint??'']);
    const previous=this.schedulers.get(key);if(previous)return previous;
    const meter=this.ledger.scoped(()=>{
      const day=dayKey(this.store.now()),caps=this.config.cost_caps;
      return [{key:`discovery:${day}:agamajung`,caps:caps.day,local:true},{key:`origin:${day}:${digest(origin)}`,caps:caps.origin,local:true},...(work.source_id?[{key:`source:${day}:${digest(work.source_id)}`,caps:caps.origin,local:true}]:[]),...(provider?[{key:`provider:${day}:${digest(provider.endpoint)}`,caps:caps.provider,local:true}]:[])];
    });
    const scheduler=new Scheduler(this.store,this.transport.transport,this.transport.sleep,meter,this.profile.limits.min_interval_ms);this.schedulers.set(key,scheduler);return scheduler;
  }
  private capture(id:string){const cap=this.store.db.prepare('SELECT * FROM engine_captures WHERE id=?').get(id) as Capture|undefined;if(!cap)throw new Error('capture_missing');return cap;}
  private responseTool(id:string){return `${VERSION}:${id}:${digest(this.config.url_policies)}`;}
  private findCached(cap:Capture):ResponseCache|undefined {
    const own=this.storage.cached<ResponseCache>(cap.content_hash,'source-discovery',this.responseTool(cap.id));if(own)return own;
    const links=this.storage.cached<DocumentLinks>(cap.content_hash,'source-links',linkCacheTool(this.config,cap.url_norm,cap.source_id,Number(JSON.parse(cap.data).discovery_depth??0)));if(links)return {document:links};
    if(this.engine.run(cap.run_id)?.profile_id==='agamajung'){
      const parse=this.store.db.prepare("SELECT data FROM engine_cache WHERE content_hash=? AND stage='parse' AND instr(tool,?)>0 ORDER BY tool DESC LIMIT 1").get(cap.content_hash,`:${cap.source_id}:`) as {data:string}|undefined;
      const parsed=parse?JSON.parse(parse.data):undefined;
      if(parsed?.text)return {document:{kind:'html',links:[],text:String(parsed.text).split('\n').map(l=>cleanText(l,500)).join('\n').slice(0,20000),truncated:false}};
    }
  }
  private cached(cap:Capture):ResponseCache {
    const cache=this.findCached(cap);if(!cache)throw new Error('capture_cache_missing');return cache;
  }
  private async request(c:Checkpoint){
    const w=c.data as unknown as Work;
    if(!this.config.enabled)throw new Error('discovery_disabled');
    if(w.kind==='capture'){this.cached(this.capture(w.capture_id!));return {data:{capture_id:w.capture_id}};}
    if(w.depth>this.config.max_depth)throw new Error('depth_limit');
    let source:SourcePolicy|undefined,provider:JsonProviderConfig|undefined,url:string;
    if(w.kind==='search'){
      provider=this.providers().find(p=>p.id===w.provider_id);requireThat(provider&&w.query,'search_permission');url=provider!.endpoint;
      if(w.cursor&&!validCursor(w.cursor))throw new Error('search_cursor');
      const row=this.store.db.prepare('SELECT capture_id,next_requery_at FROM source_discovery_queries WHERE id=?').get(w.query!.id) as {capture_id:string|null;next_requery_at:number}|undefined;
      if(row&&row.next_requery_at>this.store.now()){
        const cap=w.cursor?this.store.db.prepare("SELECT * FROM engine_captures WHERE json_extract(data,'$.query_id')=? AND json_extract(data,'$.cursor')=? AND fetched_at>=? ORDER BY fetched_at DESC LIMIT 1").get(w.query!.id,w.cursor,new Date(this.store.now()-this.config.requery_ms).toISOString()) as Capture|undefined:row.capture_id?this.capture(row.capture_id):undefined;
        if(cap&&this.findCached(cap))return {data:{capture_id:cap.id}};
      }
    }else{
      source=this.approvedSources().find(s=>s.id===w.source_id&&visitAllowed(w.url!,s));requireThat(source,'visit_not_allowed');url=w.url!;
      const previous=this.store.db.prepare("SELECT * FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=? AND status='ok' ORDER BY rowid DESC LIMIT 1").get(c.run_id,source!.id,url) as Capture|undefined;
      if(previous&&this.findCached(previous))return {data:{capture_id:previous.id}};
    }
    const scheduler=this.scheduler(w,new URL(url).origin,provider);
    let cache:ResponseCache,hash:string,bytes:number,type:string,finalUrl=url;
    try{
      if(provider){
        // The provider maps transient raw results; URLs are immediately passed to the
        // candidate policy, before ordinary canonicalUrl can erase product IDs.
        const adapter=this.options.provider?.(provider,scheduler)??new JsonApiSearchProvider(provider,scheduler);
        const page=await adapter.search(w.query!,w.cursor);
        cache={document:{kind:'html',text:'',truncated:page.truncated??false,links:page.results.slice(0,500).map((h,i)=>({destination:candidateUrl(h.url,this.config.url_policies),title:cleanText(h.title??'',200),quote:cleanText(h.summary??''),locator:h.locator??`results[${i}]`,relation:'search_result'}))},...(page.nextCursor?{nextCursor:page.nextCursor}:{})};
        // The API adapter supplies a raw body hash only; raw API bodies, request
        // URLs and authorization headers are never persisted by this component.
        const encoded=Buffer.from(stable(cache));hash=page.capture?.contentHash??hashBytes(encoded);bytes=page.capture?.byteLength??encoded.length;type='application/json';
      }else{
        const result=await new Downloader({get:(u,o)=>scheduler.get(u,source!,{...o,validateUrl:raw=>candidateUrl(raw,this.config.url_policies).identity==='preserved'})}).download(url,{reusable:()=>false,render:false});
        type=(result.response.headers['content-type']??'text/html').split(';')[0];
        requireThat(/^(?:text\/(?:html|plain|xml)|application\/(?:xml|rss\+xml|atom\+xml))$/i.test(type),'discovery_content_type');
        hash=result.hash;bytes=result.bytes!.length;finalUrl=result.response.finalUrl??url;
        const adapter=/<sitemapindex\b|<urlset\b/i.test(result.response.body)?'sitemap':/<rss\b|<feed\b/i.test(result.response.body)?'rss':source!.adapter as 'links'|'rss'|'sitemap';
        cache={document:extractDocument(result.response.body,finalUrl,adapter,this.config.url_policies,this.config.pagination_selectors?.[source!.id])};
      }
    }catch(e){
      const code=(e as {code?:string;message?:string}).code??(e as Error).message;
      if(['source_blocked','login_required','access_restricted','empty_page'].includes(code))this.store.transaction(()=>{
        this.storage.capture({id:digest([c.id,'blocked',c.attempts,this.sequence(c.run_id,source?.id??`search:${provider!.id}`,url)]),run_id:c.run_id,source_id:source?.id??`search:${provider!.id}`,url_norm:url,fetch_seq:this.sequence(c.run_id,source?.id??`search:${provider!.id}`,url),fetched_at:new Date(this.store.now()).toISOString(),status:'restricted',data:{reason:code}});
        const host=new URL(url).hostname,state=this.store.get<DomainState>('domain_state',host)??{next_at:0,stopped:false};state.stopped=true;state.reason=code;this.store.put('domain_state',host,state);
      });
      throw e;
    }
    const sourceId=source?.id??`search:${provider!.id}`,seq=this.sequence(c.run_id,sourceId,url);
    const cap={id:digest([c.run_id,sourceId,url,seq]),run_id:c.run_id,source_id:sourceId,url_norm:url,fetch_seq:seq,fetched_at:new Date(this.store.now()).toISOString(),status:'ok',content_hash:hash,content_type:type,byte_length:bytes,raw_ref:null,data:{query_id:w.query?.id??null,cursor:w.cursor??null,final_url:finalUrl,discovery_depth:w.depth}};
    return {data:{capture:cap,cache,capture_id:cap.id}};
  }
  private sequence(run:string,source:string,url:string){return (this.store.db.prepare('SELECT coalesce(max(fetch_seq),0)+1 n FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=?').get(run,source,url) as {n:number}).n;}
  private applyInside(c:Checkpoint){
    const w=c.data as unknown as Work,cap=this.capture(w.capture_id!),cache=this.cached(cap),doc=cache.document;
    const facts=this.store.db.prepare("SELECT subject_ref,field,conditions_key,data,locator FROM engine_extracted WHERE capture_id=? AND fact_status IN ('source_claim','verified') ORDER BY id").all(cap.id) as ExistingFact[];
    const offset=Number(c.data.observation_offset??0),all:CandidateObservation[]=[];
    for(const link of doc.links){
      const depth=link.relation==='pagination'?w.depth:w.depth+1;
      const exactSubjects=subjectsFromFacts(facts.filter(f=>f.locator===link.locator),cap.url_norm);
      const contexts=exactSubjects.length?exactSubjects:[w.subject];
      for(const subject of contexts){
        const hint=w.kind!=='search'?(this.config.source_hints?.[w.source_id??'']??''):'';
        const score=relevance(`${link.title} ${link.quote} ${link.destination.display_url??''} ${hint}`,this.profile,{query:w.query,subject,approved:w.kind!=='search',identity:link.destination.identity});
        const approved=link.destination.canonical_url&&this.approvedSources().find(s=>visitAllowed(link.destination.canonical_url!,s));
        const cycle=link.destination.canonical_url&&(w.ancestry.includes(link.destination.canonical_url)||w.url===link.destination.canonical_url);
        const deferred=depth>this.config.max_depth?'depth_limit':score.reason??(cycle?'cycle_url':score.score<this.config.min_relevance?'low_relevance':link.relation==='attachment'||!approved?'approval_required':!this.withinPages(c.run_id,approved,link.destination.canonical_url!)?'page_limit':undefined);
        all.push({destination:link.destination,score:score.score,evidence:{capture_id:cap.id,source_url:String(JSON.parse(cap.data).final_url??cap.url_norm),collected_at:cap.fetched_at,locator:link.locator,relation:link.relation,subject_ref:subject?.subject_ref??w.query?.subject_ref??`entity:${digest(cap.url_norm)}`,conditions:subject?.conditions??w.query?.conditions??{},quote:link.quote,title:link.title,query_id:w.query?.id,parent_id:w.parent_id,origin_capture:w.origin_capture,depth,fact_status:w.kind==='search'?'unverified':'source_claim',extractor_version:VERSION,...(deferred?{deferred_reason:deferred}:{})}});
      }
    }
    // Commit a prefix when a response spans the remaining candidate allowance.
    // The continuation owns the same capture and resumes after the last committed
    // observation, so even a configured cap smaller than a response makes progress.
    const today=this.store.db.prepare('SELECT count(*) n FROM source_candidates WHERE profile_id=? AND added_day=?').get('agamajung',dayKey(this.store.now())) as {n:number};
    let remaining=Math.max(0,this.config.max_candidates_day-today.n),end=offset;
    const newIds=new Set<string>();
    for(;end<all.length;end++){
      const o=all[end],id=this.candidates.candidateId(o.destination,o.evidence);
      if(!newIds.has(id)&&!this.store.db.prepare('SELECT id FROM source_candidates WHERE id=?').get(id)){
        if(!remaining)break;remaining--;newIds.add(id);
      }
    }
    if(end===offset&&offset<all.length)throw new CostCapError('day',true,'discovery_candidates');
    const observations=all.slice(offset,end);
    let held=0;
    for(const o of observations){
      if(o.evidence.deferred_reason||!o.destination.canonical_url){held++;continue;}
      const ancestry=[...w.ancestry,...(w.url?[w.url]:[]),...(w.query?[w.query.id]:[])];
      const inherited=w.subject?.subject_ref===o.evidence.subject_ref?w.subject:{};
      const subject={...inherited,subject_ref:o.evidence.subject_ref,conditions:o.evidence.conditions};
      const allowed=o.evidence.relation!=='attachment'&&this.documentInside(c.run_id,{kind:'document',url:o.destination.canonical_url,depth:o.evidence.depth,page:o.evidence.relation==='pagination'?w.page+1:0,ancestry,parent_id:this.candidates.candidateId(o.destination,o.evidence),origin_capture:w.origin_capture,subject});
      if(!allowed){held++;o.evidence.deferred_reason='page_limit';}
    }
    this.candidates.recordInside(observations);
    if(end<all.length){
      const next={...c.data,observation_offset:end};this.engine.enqueueInside(c.run_id,'apply',digest([c.item_key,end]),next,digest(next));
      return {nextStage:null,data:{candidate_observations:observations.length,truncated:true,stopped_reason:'candidate_day_limit',held_relations:held}};
    }
    let cursorStop:string|undefined;
    if(w.kind==='search'&&w.query){
      this.store.db.prepare('UPDATE source_discovery_queries SET cursor=?,capture_id=CASE WHEN ? IS NULL THEN ? ELSE capture_id END,next_requery_at=? WHERE id=?').run(cache.nextCursor??null,w.cursor??null,cap.id,Date.parse(cap.fetched_at)+this.config.requery_ms,w.query.id);
      if(cache.nextCursor){
        const history=w.cursor_history??[];
        if(!validCursor(cache.nextCursor)||history.includes(cache.nextCursor)||cache.nextCursor===w.cursor){held++;cursorStop='cycle_cursor';}
        else if(w.page+1<this.config.max_pages){if(!this.searchInside(c.run_id,w.query,w.provider_id!,{...w,page:w.page+1,cursor:cache.nextCursor,cursor_history:[...history,...(w.cursor?[w.cursor]:[])]})){held++;cursorStop='query_limit';}}
        else {held++;cursorStop='page_limit';}
      }
    }
    // Feed only explicit rule-parsed entities and existing facts back into search.
    const subjects=[...subjectsFromFacts(facts,cap.url_norm),...explicitSubjects(doc.text,cap.url_norm)];
    let feedbackStop:string|undefined;
    const textScore=relevance(doc.text,this.profile,{approved:w.kind!=='search'});
    if(w.kind!=='search'&&!textScore.reason&&textScore.score>=this.config.min_relevance&&w.depth+1<this.config.max_depth){
      for(const s of subjects){
        const known=this.store.db.prepare("SELECT subject_ref,field,conditions_key,data FROM engine_extracted WHERE subject_ref IN (?,?) AND fact_status IN ('source_claim','verified')").all(s.subject_ref,`doc:${cap.url_norm}`) as ExistingFact[];
        for(const p of this.providers())for(const q of feedbackQueries(p.id,s,this.profile,known.map(f=>({field:f.field,subject_ref:f.subject_ref.startsWith('doc:')?`entity:${digest([cap.url_norm,f.subject_ref])}`:f.subject_ref,conditions:JSON.parse(f.conditions_key)}))))if(!this.searchInside(c.run_id,q,p.id,{depth:w.depth+1,ancestry:[...w.ancestry,...(w.url?[w.url]:[])],subject:s,parent_id:w.parent_id,origin_capture:w.origin_capture}))feedbackStop='query_limit';
      }
    }
    const stopped=cursorStop??feedbackStop??(observations.some(o=>o.evidence.deferred_reason==='page_limit')?'page_limit':undefined);
    return {nextStage:null,data:{candidate_observations:observations.length,truncated:doc.truncated||!!stopped,...(stopped?{stopped_reason:stopped}:{}),held_relations:held}};
  }
}
