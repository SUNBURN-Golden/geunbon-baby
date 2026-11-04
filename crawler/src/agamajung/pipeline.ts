import { failureCode } from '../discovery/health';
import { isPangpang, pangpangIdentityAllowed, PANGPANG_VERSION, type PangpangPage, type PangpangProduct } from '../../lib/external/pangpang';
import { pangpangLog, pangpangContext, reportPangpang, type PangpangLog } from '../discovery/pangpang-diagnostics';
import { JobEngine, Downloader, RawStore, SqliteStorage, ToolAdapter, DisabledModel, errorCode } from '../../engine';
import type { CostLedger } from '../../engine';
import { agamajungCosts } from './cost-policy';
import { loadDiscoveryConfig, linkCacheTool, type DiscoveryConfig } from '../source-discovery/config';
import type { Checkpoint, Data, ModelPort, RenderPort, StageHandler, StageResult } from '../../engine';
import { digest, stable } from '../dedup';
import { CollectorStore, requireThat } from '../store';
import { Scheduler, type DomainState } from '../scheduler';
import { canonicalUrl } from '../../../shared/privacy-rules';
import type { AssertionInput, ClipPayload } from '../../../shared/collection-schema';
import { aiData, privacyFilter } from '../privacy-filter';
import { sourceFor, visitAllowed, type SourcePolicy } from '../source-policy';
import { loadProfile, validateProfile, type Profile } from './profile';
import { SchedulerFetcher } from './fetcher';
import { requiredClaimValid } from '../evidence-policy';
import type { ProvenanceInput } from '../evidence-provenance';
import { extractRules } from './rules';
import { labelRules, type LabelId } from './labeler';
import { AGAMAJUNG_LABELS, REQUIRED_FIELDS } from './vocab';
import { claimSlots, conditionsKey, subjectRef } from './subject';
type Capture={id:string;run_id:string;source_id:string;url_norm:string;content_hash:string;content_type:string;etag:string|null;last_modified:string|null;raw_ref:string|null;fetched_at:string;fetch_seq:number;byte_length:number|null;data:string};
export type Parsed={inspection?:{version:string;complete:boolean;truncated:boolean;region:string;tool_status:string;locator_base:string;locator_space?:string;filter_changed?:boolean};text:string;eligible?:boolean;title?:string;document_origin?:string;assertions?:AssertionInput[];pangpang?:PangpangPage};
type Labeled={labels:LabelId[];status:'labeled'|'ambiguous';method:'rule'|'model'};
export type PipelineOptions={offline?:boolean;scheduler?:Scheduler;renderer?:RenderPort;tools?:ToolAdapter;model?:ModelPort;discoveryConfig?:DiscoveryConfig;fault?:(point:string)=>void;rng?:()=>number;health?:(code:string)=>void;linkLog?:PangpangLog};
import { prepare, validatePrepared, requireMemoryRenderer, safeEtag, safeModified, PREPARATION_VERSION, type Prepared } from './pre-storage';
const string=(data:Data,key:string)=>String(data[key]??'');
export const collectionParseVersion=(store:CollectorStore,profile:Profile,options:PipelineOptions={})=>`parse@5:${PREPARATION_VERSION}:${PANGPANG_VERSION}:${profile.extractor_version}:${profile.labeler_version}:${digest([store.settings.sources,options.discoveryConfig??loadDiscoveryConfig(),options.renderer?.capability??null,options.tools?.memory?.capability??null,profile.domain_policy])}`;
export class AgamajungPipeline {
  readonly engine:JobEngine;
  readonly ledger:CostLedger;
  readonly scheduler:Scheduler;
  readonly storage:SqliteStorage;
  readonly tools:ToolAdapter;
  readonly profile:Profile;
  readonly handlers:Record<string,StageHandler>;
  readonly parseVersion:string;
  constructor(readonly store:CollectorStore,readonly raw:RawStore,profile=loadProfile(store.settings),readonly options:PipelineOptions={}){
    this.profile=validateProfile(profile,store.settings);
    this.parseVersion=collectionParseVersion(store,profile,options);
    this.storage=new SqliteStorage(store,{receipt:id=>store.receipt(id),submit:(id,payload,sourceId)=>store.submit('linux',id,payload,sourceId)});this.tools=options.tools??new ToolAdapter(store);
    this.ledger=agamajungCosts(store,profile);if(!options.offline)this.ledger.recoverOrphans();
    this.scheduler=options.scheduler?new Scheduler(store,options.scheduler.transport,options.scheduler.sleep,this.ledger,profile.limits.min_interval_ms):new Scheduler(store,undefined,undefined,this.ledger,profile.limits.min_interval_ms);
    this.handlers=this.createHandlers();
    this.engine=new JobEngine(store,profile.id,profile.stages,this.handlers,{fault:options.fault,rng:options.rng,maxAttempts:profile.limits.max_attempts,onHalt:(c,code)=>{
      const source=this.source(c),host=new URL(source.origin).hostname;
      const state=store.get<DomainState>('domain_state',host)??{next_at:0,stopped:false};
      state.stopped=true;state.reason='access_restricted';store.put('domain_state',host,state);options.health?.(code);
    }});
    if(!options.offline)raw.cleanup(new Set((store.db.prepare('SELECT raw_ref FROM engine_captures WHERE raw_ref IS NOT NULL').all() as {raw_ref:string}[]).map(c=>c.raw_ref)),store.now());
  }
  private source(c:Checkpoint){const source=this.store.settings.sources.find(s=>s.id===c.data.source_id&&s.enabled);requireThat(source&&this.profile.domain_policy.sources[source.id],'visit_not_allowed',403);return source!;}
  private capture(c:Checkpoint){const row=this.store.db.prepare('SELECT * FROM engine_captures WHERE id=?').get(string(c.data,'capture_id')) as Capture|undefined;requireThat(row,'capture_missing');return row!;}
  private cacheTool(sourceId:string,type:string,version:string,url?:string){return `${version}:${sourceId}:${type}:${digest(url??'')}`;}
  private cache<T>(cap:Capture,stage:string,version:string){return this.storage.cached<T>(cap.content_hash,stage,this.cacheTool(cap.source_id,cap.content_type,version,cap.url_norm));}
  private prepared(cap:Capture):Prepared|undefined {
    try {
      const meta=JSON.parse(cap.data),source=this.store.settings.sources.find(s=>s.id===cap.source_id);
      if(!source||meta.preparation_identity!==this.parseVersion)return;
      const cfg=this.options.discoveryConfig??loadDiscoveryConfig(),parsed=this.cache<Parsed>(cap,'parse',this.parseVersion),links=this.storage.cached<Prepared['links']>(cap.content_hash,'source-links',this.linksTool(source,cap.url_norm,Number(meta.discovery_depth),cfg));
      if(!parsed||!links)return;
      const prepared:Prepared={version:meta.preparation_version,mode:meta.preparation_mode,parsed,links,hash:meta.derivative_hash};
      validatePrepared(prepared,cfg);
      if((this.profile.domain_policy.sources[source.id].render||source.browser)&&prepared.mode!=='rendered')return;
      return prepared;
    }catch{return;}
  }
  private reusable(cap:Capture|undefined){return !!cap&&!!this.prepared(cap);}
  private version(stage:string){return stage==='parse'?this.parseVersion:stage==='label'?`${this.profile.labeler_version}:${this.parseVersion}`:`${this.profile.extractor_version}:${this.parseVersion}`;}
  private pangpang(id:string){const s=this.store.settings.sources.find(s=>s.id===id);return !!s&&isPangpang(s);}
  private labeler(id:string){return this.pangpang(id)?`${this.profile.labeler_version}:${PANGPANG_VERSION}`:this.profile.labeler_version;}
  private extractor(id:string){return this.pangpang(id)?`${this.profile.extractor_version}:${PANGPANG_VERSION}`:this.profile.extractor_version;}
  private linksTool(s:SourcePolicy,url:string,depth:number,cfg:DiscoveryConfig){return `${linkCacheTool(cfg,url,s.id,depth)}:${this.parseVersion}`;}
  private current(c:Checkpoint){
    if(!this.prepared(this.capture(c))){c.data.restart_stage='fetch';throw new Error('input_unavailable');}
  }
  private productEligibility(p:PangpangProduct):'excluded_category'|'profile_category_mismatch'|null {
    const text=`${p.title} ${p.category_text}`.toLocaleLowerCase();
    return this.profile.excluded_keywords.some(k=>text.includes(k.toLocaleLowerCase()))?'excluded_category':this.eligible(text)?null:'profile_category_mismatch';
  }
  private persistReservation(c:Checkpoint,source:SourcePolicy){
    const url=string(c.data,'url'),existing=this.store.recordByUrl(url);
    const r=this.store.reserve('linux',{clip_id:digest([c.run_id,c.item_key]),attempt_id:digest([c.id,c.attempts]),url,brand:source.brand,collection_method:source.browser?'browser_extract':'auto_discovery',operation:existing?.last_checked_at?'recheck':'new_body',policy_version:this.store.settings.policy_version});
    this.store.start('linux',r.id);
    c.data.reservation_id=r.id;
    this.store.transaction(()=>this.store.db.prepare('UPDATE engine_checkpoints SET data=? WHERE id=?').run(stable(c.data),c.id));
    return r.id;
  }
  start(slot:{kind:string;at:string;data?:Data}={kind:'daily',at:new Date(this.store.now()+9*3600000).toISOString().slice(0,10)}){
    const halted=this.store.db.prepare("SELECT id FROM engine_runs WHERE profile_id=? AND state='halted' ORDER BY started_at DESC LIMIT 1").get(this.profile.id) as {id:string}|undefined;
    if(halted&&this.store.list<DomainState>('domain_state').some(d=>d.stopped))return halted.id;
    const id=this.engine.startRun(slot);this.ledger.open(id);return id;
  }
  resume(id:string){
    const run=this.engine.run(id);if(run?.state==='halted'){
      requireThat(!this.store.list<DomainState>('domain_state').some(d=>d.stopped),'domain_stopped',403);
      this.store.transaction(()=>{
        this.store.db.prepare("UPDATE engine_runs SET state='running' WHERE id=?").run(id);
        this.store.db.prepare("UPDATE engine_checkpoints SET phase='pending' WHERE run_id=? AND phase='failed' AND error_code IN ('source_blocked','domain_stopped','login_required','access_restricted','empty_page')").run(id);
      });
    }
    this.engine.resume(id);this.ledger.open(id);return id;
  }
  seed(runId:string){
    const run=this.engine.run(runId);
    if(run?.state!=='running'||JSON.parse(run.data).collection_seeded)return;
    const now=this.store.now(),records=this.store.list<{url:string;source:string;next_recheck_at:string|null}>('collection_records');
    const policy=this.profile.domain_policy;
    const sources=this.store.settings.sources.filter(s=>s.enabled&&policy.sources[s.id]).sort((a,b)=>policy.start_order.indexOf(policy.sources[a.id].tier)-policy.start_order.indexOf(policy.sources[b.id].tier));
    for(const source of sources){
      const due=records.filter(r=>r.source===source.id).flatMap(r=>{
        const at=r.next_recheck_at?Date.parse(r.next_recheck_at):NaN;
        return Number.isFinite(at)&&at<=now?[{url:canonicalUrl(r.url),at}]:[];
      }).sort((a,b)=>a.at-b.at||(a.url<b.url?-1:a.url>b.url?1:0));
      const seen=new Set<string>(),limit=Math.min(source.max_pages,this.store.settings.limits.max_pages);
      for(const candidate of [...due.map(r=>r.url),...source.entries]){
        const url=canonicalUrl(candidate);
        if(seen.has(url))continue;
        seen.add(url);
        this.engine.enqueue(runId,'discover',digest([source.id,url]),{source_id:source.id,url,depth:0});
        if(seen.size>=limit)break;
      }
    }
    this.store.transaction(()=>this.store.db.prepare("UPDATE engine_runs SET data=json_set(data,'$.collection_seeded',1) WHERE id=?").run(runId));
  }
  async run(runId:string){
    this.ledger.open(runId);const result=await this.engine.runUntilIdle(runId);
    for(const s of this.store.settings.sources.filter(s=>s.enabled&&isPangpang(s)&&this.profile.domain_policy.sources[s.id])){
      const count=(stage:string,done=false)=>(this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND stage=? AND json_extract(data,'$.source_id')=? AND (?=0 OR phase='done') AND (?<>'discover' OR json_extract(data,'$.depth')>0)").get(runId,stage,s.id,Number(done),stage) as {n:number}).n;
      const failures=this.store.db.prepare("SELECT f.reason FROM engine_failures f JOIN engine_checkpoints c ON c.id=f.id WHERE f.run_id=? AND c.stage='fetch' AND json_extract(c.data,'$.source_id')=?").all(runId,s.id) as {reason:string}[];
      const transport_failures:Record<string,number>={};
      for(const f of failures){const code=failureCode(new Error(f.reason));transport_failures[code]=(transport_failures[code]??0)+1;}
      (this.options.linkLog??pangpangLog)({...pangpangContext('collect',runId,'run'),event:'run_summary',scheduled:count('discover'),submitted:count('service',true),transport_failures});
    }
    return result;
  }
  private parsed(cap:Capture){const p=this.prepared(cap)?.parsed;if(!p)throw new Error('input_unavailable');return p;}
  private serviceInput(c:Checkpoint):{payload:ClipPayload;provenance:ProvenanceInput} {
    const cap=this.capture(c),extractor=String(c.data.extractor_version??this.extractor(cap.source_id));
    const rows=this.store.db.prepare('SELECT id,data FROM engine_extracted WHERE capture_id=? AND extractor=? ORDER BY id').all(cap.id,extractor) as {id:string;data:string}[];
    // Filter each claim separately so rejected claims cannot shift its identity.
    const parseTool=rows[0]?JSON.parse(rows[0].data).parse_tool:undefined;
    const parsed=(parseTool?this.storage.cached<Parsed>(cap.content_hash,'parse',parseTool):undefined)??this.parsed(cap);
    const claims=rows.flatMap(r=>privacyFilter({assertions:[JSON.parse(r.data).assertion]}).assertions.map(a=>({id:r.id,assertion:a})));
    return {payload:privacyFilter({title:parsed.title,document_origin:parsed.document_origin,target_model_id:c.data.target_model_id,assertions:claims.map(c=>c.assertion)}),provenance:{capture_id:cap.id,extractor,ids:claims.map(c=>c.id)}};
  }
  private serviceRecovery(c:Checkpoint):StageResult|undefined {
    const receipt=this.storage.service!.receipt(string(c.data,'reservation_id'));if(!receipt)return;
    const input=this.serviceInput(c);requireThat(receipt.digest===digest(input.payload)&&this.store.receipt(receipt.id)?.provenance_digest===digest(input.provenance),'payload_changed');return {outputRef:receipt.id};
  }
  private createHandlers():Record<string,StageHandler>{
    const handler=(version:string,run:StageHandler['run'],commit?:StageHandler['commit']):StageHandler=>({kind:'transactional',version,run,commit});
    return {
      discover:handler('discover@1',async c=>{const s=this.source(c);requireThat(visitAllowed(string(c.data,'url'),s),'visit_not_allowed');this.store.discover(string(c.data,'url'));return {}; }),
      fetch:handler('fetch@1',async c=>{
        const source=this.source(c),policy=this.profile.domain_policy.sources[source.id],url=string(c.data,'url');
        requireMemoryRenderer(policy.render||source.browser,this.options.renderer);
        // Mirrors the discovery runner: reserve body/recheck/browser before any transport, including robots.
        if(source.adapter==='links'||Number(c.data.depth)>0||this.store.recordByUrl(url)?.last_checked_at||source.browser)this.persistReservation(c,source);
        const previous=this.store.db.prepare("SELECT * FROM engine_captures WHERE source_id=? AND url_norm=? AND status IN ('ok','not_modified') ORDER BY fetched_at DESC,rowid DESC LIMIT 1").get(source.id,url) as Capture|undefined;
        let result:Awaited<ReturnType<Downloader['download']>>;
        try{result=await new Downloader(new SchedulerFetcher(this.scheduler,source),{etag:safeEtag,modified:safeModified}).download(url,{previous,reusable:()=>this.reusable(previous),render:policy.render||source.browser});}
        catch(e){
          const code=(e as {code?:string;message?:string}).code??(e as Error).message;
          if(isPangpang(source))(this.options.linkLog??pangpangLog)({...pangpangContext('collect',c.run_id,url),event:'transport',reason:failureCode(e)});
          if(['source_blocked','login_required','access_restricted','empty_page','source_response','robots_denied','visit_not_allowed','redirect_identity'].includes(code)){
            const seq=(this.store.db.prepare('SELECT coalesce(max(fetch_seq),0)+1 n FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=?').get(c.run_id,source.id,url) as {n:number}).n;
            this.store.transaction(()=>this.storage.capture({id:digest([c.run_id,source.id,url,seq]),run_id:c.run_id,source_id:source.id,url_norm:url,fetch_seq:seq,fetched_at:new Date(this.store.now()).toISOString(),status:code==='source_response'&&Number((e as {http_status?:number}).http_status)!==401?'http_error':code==='source_blocked'?'blocked':'restricted',content_hash:null,content_type:null,byte_length:null,etag:null,last_modified:null,raw_ref:null,prev_capture_id:previous?.id??null,data:{reason:code}}));
          }
          throw e;
        }
        if(isPangpang(source))requireThat(pangpangIdentityAllowed(url,result.response.finalUrl??url),'redirect_identity');
        const type=(result.response.headers['content-type']??previous?.content_type??'text/html').split(';')[0].trim().toLowerCase();
        requireThat(policy.content_types.some(t=>type===t||t.endsWith('/*')&&type.startsWith(t.slice(0,-1))),'content_type');
        const cfg=this.options.discoveryConfig??loadDiscoveryConfig();
        let prepared:Prepared|undefined;
        try {prepared=result.bytes?await prepare({bytes:result.bytes,document:result.response,url,type,source,render:policy.render||source.browser,renderer:this.options.renderer,tools:this.tools,config:cfg,now:new Date(this.store.now()),maxBytes:this.store.settings.limits.max_bytes,eligible:text=>this.eligible(text)}):previous?this.prepared(previous):undefined;}catch(e){
          const reason=errorCode(e),seq=(this.store.db.prepare('SELECT coalesce(max(fetch_seq),0)+1 n FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=?').get(c.run_id,source.id,url) as {n:number}).n;
          this.store.transaction(()=>this.storage.capture({id:digest([c.run_id,source.id,url,seq]),run_id:c.run_id,source_id:source.id,url_norm:url,fetch_seq:seq,fetched_at:new Date(this.store.now()).toISOString(),status:['source_blocked','login_required','access_restricted','empty_page'].includes(reason)?'restricted':'skipped_policy',content_hash:result.hash,content_type:type,byte_length:result.bytes?.length??null,raw_ref:null,etag:null,last_modified:null,prev_capture_id:previous?.id??null,data:{reason,preparation_outcome:reason==='unsupported'?'unsupported':'failed',preparation_version:PREPARATION_VERSION}}));
          throw e;
        }
        if(!prepared)throw new Error('input_unavailable');
        validatePrepared(prepared,cfg);
        const artifact=policy.raw==='store'&&prepared.parsed.text?this.raw.writeInspected({text:prepared.parsed.text,fullTextAllowed:source.full_text_allowed,permissionBasis:source.permission_basis??''}):undefined;
        const seq=(this.store.db.prepare('SELECT coalesce(max(fetch_seq),0)+1 n FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=?').get(c.run_id,source.id,url) as {n:number}).n;
        const cap:Data={id:digest([c.run_id,source.id,url,seq]),run_id:c.run_id,source_id:source.id,url_norm:url,fetch_seq:seq,fetched_at:new Date(this.store.now()).toISOString(),status:result.status,content_hash:result.hash,content_type:type,byte_length:result.bytes?.length??(previous?.byte_length??null),etag:safeEtag(result.response.headers.etag??(result.status==='not_modified'?previous?.etag:null)),last_modified:safeModified(result.response.headers['last-modified']??(result.status==='not_modified'?previous?.last_modified:null)),raw_ref:artifact?.path??null,prev_capture_id:previous?.id??null,data:{final_url:canonicalUrl(result.response.finalUrl??url),discovery_depth:Number(c.data.depth),preparation_identity:this.parseVersion,preparation_version:prepared.version,preparation_mode:prepared.mode,derivative_hash:prepared.hash,...(artifact?{artifact_hash:artifact.hash,artifact_format:'sanitized_text'}:{})}};
        return {outputRef:String(cap.id),data:{capture:cap,prepared,capture_id:cap.id,content_hash:result.hash}};
      },(result,c)=>{
        const cap=result.data!.capture as Data,p=result.data!.prepared as Prepared,s=this.source(c),cfg=this.options.discoveryConfig??loadDiscoveryConfig();
        validatePrepared(p,cfg); // final runtime gate immediately before binding any content
        this.storage.capture(cap);
        this.storage.cache(String(cap.content_hash),'parse',this.cacheTool(s.id,String(cap.content_type),this.parseVersion,String(cap.url_norm)),p.parsed);
        this.storage.cache(String(cap.content_hash),'source-links',this.linksTool(s,String(cap.url_norm),Number(c.data.depth),cfg),p.links);
        return {outputRef:String(cap.id),data:{capture_id:cap.id,content_hash:cap.content_hash,preparation_identity:this.parseVersion,restart_stage:'fetch'}};
      }),
      render:handler('render@2',async c=>{this.current(c);return {};}),
      parse:handler(this.parseVersion,async c=>{this.current(c);return {};},(_result,c)=>{
        const cap=this.capture(c),s=this.source(c),prepared=this.prepared(cap);
        if(!prepared)throw new Error('input_unavailable');
        const output=prepared.parsed;
        if(isPangpang(s)){
          const page=output.pangpang;if(!page)throw new Error('input_unavailable');
          let scheduled=0;const deferred=new Set<string>();
          if(!page.detail){
            const max=Math.min(s.max_pages,this.store.settings.limits.max_pages);
            let count=(this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND stage='discover' AND json_extract(data,'$.source_id')=?").get(c.run_id,s.id) as {n:number}).n;
            for(const p of page.products){
              const url=p.source_url,key=digest([s.id,url]);
              if(this.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='discover' AND item_key=?").get(c.run_id,key))continue;
              if(Number(c.data.depth)>=this.store.settings.limits.max_depth||s.browser||count>=max){deferred.add(url);continue;}
              this.engine.enqueueInside(c.run_id,'discover',key,{source_id:s.id,url,depth:Number(c.data.depth)+1},digest(url));count++;scheduled++;
              (this.options.linkLog??pangpangLog)({...pangpangContext('collect',c.run_id,cap.id),event:'progress',stage:'scheduled',product_ref:digest(url)});
            }
          }
          reportPangpang(page,pangpangContext('collect',c.run_id,cap.id),this.options.linkLog??pangpangLog,p=>this.productEligibility(p),deferred,scheduled);
        }else if(Number(c.data.depth)<this.store.settings.limits.max_depth&&!s.browser&&s.adapter!=='cpsc'){
          const max=Math.min(s.max_pages,this.store.settings.limits.max_pages);
          let count=(this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND stage='fetch' AND json_extract(data,'$.source_id')=?").get(c.run_id,s.id) as {n:number}).n;
          for(const link of prepared.links.links){
            if(count>=max)break;
            if(!link.destination.canonical_url)continue;
            const url=canonicalUrl(link.destination.canonical_url),key=digest([s.id,url]);
            if(!visitAllowed(url,s)||sourceFor(url,this.store.settings)?.id!==s.id)continue;
            if(this.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='discover' AND item_key=?").get(c.run_id,key))continue;
            this.engine.enqueueInside(c.run_id,'discover',key,{source_id:s.id,url,depth:Number(c.data.depth)+1},digest(url));count++;
          }
        }
        const eligible=output.eligible??this.eligible(output.text);
        return {nextStage:eligible?undefined:null,data:{eligible,preparation_identity:this.parseVersion,...(isPangpang(s)?{pangpang_version:PANGPANG_VERSION,pangpang_parse_version:this.parseVersion}:{}),restart_stage:'fetch'}};
      }),
      label:handler(this.profile.labeler_version,async c=>{
        this.current(c);
        const cap=this.capture(c),cached=this.cache<Labeled>(cap,'label',this.version('label'));if(cached)return {data:{label_result:cached}};
        const parsed=this.parsed(cap),result=labelRules(parsed.text);let labeled:Labeled={...result,method:'rule'};
        if(result.status==='ambiguous'&&this.profile.model.enabled){
          if(!this.options.model||this.options.model instanceof DisabledModel)throw Object.assign(new Error('unsupported'),{tool:'model'});
          const ticket=this.ledger.holdKinds({model_calls:1});
          try {
            const answer=await (this.options.model??new DisabledModel()).classify(aiData({assertions:[],full_text:parsed.text}));
            if(answer.status==='unsupported')throw Object.assign(new Error('unsupported'),{tool:'model'});
            requireThat(answer.labels.every(x=>Object.hasOwn(AGAMAJUNG_LABELS,x)),'payload_shape');
            labeled={labels:[...new Set(answer.labels)] as LabelId[],status:answer.labels.length?'labeled':'ambiguous',method:'model'};
          }finally{this.ledger.settleKinds(ticket,{model_calls:1});}
        }
        return {data:{label_result:labeled}};
      },(result,c)=>{
        const cap=this.capture(c),labeled=result.data!.label_result as Labeled;
        this.storage.cache(cap.content_hash,'label',this.cacheTool(cap.source_id,cap.content_type,this.version('label'),cap.url_norm),labeled);
        for(const label of labeled.labels)this.storage.label({id:digest([cap.id,this.labeler(cap.source_id),label]),capture_id:cap.id,label:AGAMAJUNG_LABELS[label],method:labeled.method,status:labeled.status,fact_status:labeled.method==='model'?'ai_inference':'unverified',extractor:this.labeler(cap.source_id),data:{}});
        return {data:{label_status:labeled.status}};
      }),
      extract:handler(this.profile.extractor_version,async c=>{
        this.current(c);
        const cap=this.capture(c),source=this.source(c),parsed=this.parsed(cap);
        let assertions=this.cache<AssertionInput[]>(cap,'extract',this.version('extract'));
        if(!assertions){
          assertions=privacyFilter({assertions:parsed.assertions??extractRules(parsed.text,source.selector||'document')}).assertions;
        }
        return {data:{assertions}};
      },(result,c)=>{
        const cap=this.capture(c),source=this.source(c),neutral=result.data!.assertions as AssertionInput[];
        this.storage.cache(cap.content_hash,'extract',this.cacheTool(cap.source_id,cap.content_type,this.version('extract'),cap.url_norm),neutral);
        const assertions=neutral.map(a=>a.field==='official_msrp'&&!(source.official_fields.includes('official_msrp')&&a.msrp_explicit&&['manufacturer','importer'].includes(source.kind))?{...a,field:'clue_price' as const}:a),subject=subjectRef({target_model_id:c.data.target_model_id as string|undefined,assertions},cap.url_norm),slots=claimSlots(assertions);
        assertions.forEach((a,index)=>{
          const key=conditionsKey(a,['clue_price','group_buy_terms','shipping_fee'].includes(a.field)?new URL(cap.url_norm).origin:'');
          const previous=this.store.db.prepare('SELECT e.* FROM engine_extracted e JOIN engine_captures c ON e.capture_id=c.id WHERE e.subject_ref=? AND e.field=? AND e.conditions_key=? AND c.source_id=? AND e.collected_at<? ORDER BY e.collected_at DESC,e.id DESC LIMIT 1').get(subject,a.field,key,cap.source_id,cap.fetched_at) as {data:string;collected_at:string;change_window_start:string|null}|undefined;
          const stated=a.conditions?.effective_at,validDate=stated&&Number.isFinite(Date.parse(stated));
          const window=previous?(stable(JSON.parse(previous.data).assertion.value)===stable(a.value)?previous.change_window_start:previous.collected_at):null;
          this.storage.extracted({id:digest([cap.id,this.extractor(cap.source_id),subject,a.field,key,slots[index]]),capture_id:cap.id,subject_ref:subject,field:a.field,conditions_key:key,claim_slot:slots[index],source_url:cap.url_norm,locator:a.locator,quote:a.quote.slice(0,300),collected_at:cap.fetched_at,effective_from:validDate?new Date(stated!).toISOString():cap.fetched_at,effective_from_basis:validDate?'stated':'observed',change_window_start:window,fact_status:'source_claim',extractor:this.extractor(cap.source_id),data:{assertion:a,parse_tool:this.cacheTool(cap.source_id,cap.content_type,this.parseVersion,cap.url_norm),discovery_depth:Number(c.data.depth)}});
        });
        return {data:{extractor_version:this.extractor(cap.source_id),completeness_stage:'preliminary',completeness:Object.fromEntries(REQUIRED_FIELDS.map(field=>[field,assertions.some(a=>a.field===field&&requiredClaimValid(a))?'present':'missing']))}};
      }),
      service:{kind:'external',version:'service@1',recover:c=>this.serviceRecovery(c),run:async c=>{
        const old=this.serviceRecovery(c);if(old)return old;
        this.current(c);
        const oldReservation=c.data.reservation_id?this.store.reservation('linux',String(c.data.reservation_id)):undefined;
        if(!oldReservation||((c.data.parent_run||c.data.carried_from)&&(oldReservation.submit_until??0)<this.store.now()))this.persistReservation(c,this.source(c));
        const source=this.source(c),input=this.serviceInput(c),receipt=this.store.submitExtracted(string(c.data,'reservation_id'),input.payload,input.provenance,source.adapter==='cpsc'?source.id:undefined);
        if(isPangpang(source))(this.options.linkLog??pangpangLog)({...pangpangContext('collect',c.run_id,input.provenance.capture_id),event:'progress',stage:'submitted',product_ref:digest(string(c.data,'url'))});
        return {outputRef:receipt.id};
      }},
    };
  }
  private eligible(text:string){const normalized=text.toLocaleLowerCase();return !this.profile.excluded_keywords.some(k=>normalized.includes(k.toLocaleLowerCase()))&&this.profile.categories.some(category=>[...category.ko,...category.en].some(k=>normalized.includes(k.toLocaleLowerCase())));}
}
