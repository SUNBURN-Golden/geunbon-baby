import { JobEngine, CostLedger, Downloader, RawStore, SqliteStorage, ToolAdapter, extractPdf, extractImage, renderDocument, DisabledModel } from '../../engine';
import type { Checkpoint, Data, FetchResponse, ModelPort, RenderPort, StageHandler, StageResult } from '../../engine';
import { digest, stable } from '../dedup';
import { CollectorStore, requireThat } from '../store';
import { Scheduler, type DomainState } from '../scheduler';
import { renderDocument as browserDocument } from '../discovery/browser';
import { discoverLinks } from '../discovery/adapters';
import { parseHtml, selectAll, textOf, linesOf } from '../../lib/external/parse';
import { canonicalUrl, filterText } from '../../../shared/privacy-rules';
import type { AssertionInput, ClipPayload } from '../../../shared/collection-schema';
import { aiData, privacyFilter } from '../privacy-filter';
import { sourceFor, visitAllowed, type SourcePolicy } from '../source-policy';
import { loadProfile, validateProfile, type Profile } from './profile';
import { SchedulerFetcher } from './fetcher';
import { extractRules } from './rules';
import { labelRules, type LabelId } from './labeler';
import { AGAMAJUNG_LABELS, REQUIRED_FIELDS } from './vocab';
import { claimSlots, conditionsKey, subjectRef } from './subject';
type Capture={id:string;run_id:string;source_id:string;url_norm:string;content_hash:string;content_type:string;etag:string|null;last_modified:string|null;raw_ref:string|null;fetched_at:string;fetch_seq:number;byte_length:number|null;data:string};
type Parsed={text:string;eligible?:boolean;title?:string;document_origin?:string;assertions?:AssertionInput[]};
type Labeled={labels:LabelId[];status:'labeled'|'ambiguous';method:'rule'|'model'};
export type PipelineOptions={scheduler?:Scheduler;renderer?:RenderPort;tools?:ToolAdapter;model?:ModelPort;fault?:(point:string)=>void;rng?:()=>number;health?:(code:string)=>void};
const string=(data:Data,key:string)=>String(data[key]??'');
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
    this.parseVersion=`parse@1:${profile.extractor_version}:${profile.labeler_version}:${digest(store.settings.sources.map(s=>[s.id,s.origin,s.selector,s.official_fields,s.kind]))}`;
    this.storage=new SqliteStorage(store,{receipt:id=>store.receipt(id),submit:(id,payload,sourceId)=>store.submit('linux',id,payload,sourceId)});this.tools=options.tools??new ToolAdapter(store);
    this.ledger=new CostLedger(store,profile.id,profile.cost_caps);this.ledger.recoverOrphans();
    this.scheduler=options.scheduler?new Scheduler(store,options.scheduler.transport,options.scheduler.sleep,this.ledger,profile.limits.min_interval_ms):new Scheduler(store,undefined,undefined,this.ledger,profile.limits.min_interval_ms);
    this.handlers=this.createHandlers();
    this.engine=new JobEngine(store,profile.id,profile.stages,this.handlers,{fault:options.fault,rng:options.rng,maxAttempts:profile.limits.max_attempts,onHalt:(c,code)=>{
      const source=this.source(c),host=new URL(source.origin).hostname;
      const state=store.get<DomainState>('domain_state',host)??{next_at:0,stopped:false};
      state.stopped=true;state.reason='access_restricted';store.put('domain_state',host,state);options.health?.(code);
    }});
    raw.cleanup(store.now());
  }
  private source(c:Checkpoint){const source=this.store.settings.sources.find(s=>s.id===c.data.source_id&&s.enabled);requireThat(source&&this.profile.domain_policy.sources[source.id],'visit_not_allowed',403);return source!;}
  private capture(c:Checkpoint){const row=this.store.db.prepare('SELECT * FROM engine_captures WHERE id=?').get(string(c.data,'capture_id')) as Capture|undefined;requireThat(row,'capture_missing');return row!;}
  private toolFor(type:string){return type==='application/pdf'?'pdftotext':type.startsWith('image/')?'tesseract':undefined;}
  private async probeType(type:string){const tool=this.toolFor(type);if(tool)await this.tools.probeTool(tool,tool==='pdftotext'?['-v']:['--version']);}
  private cacheTool(sourceId:string,type:string,version:string){
    const tool=this.toolFor(type),support=tool?this.store.db.prepare('SELECT status,version FROM engine_tool_support WHERE tool=?').get(tool):undefined;
    return `${version}:${sourceId}:${tool?digest([tool,support??null]):'text'}`;
  }
  private cache<T>(cap:Capture,stage:string,version:string){return this.storage.cached<T>(cap.content_hash,stage,this.cacheTool(cap.source_id,cap.content_type,version));}
  private reusable(hash:string,source:SourcePolicy,type:string){return !!(this.raw.read(hash)||['parse','label','extract'].every(stage=>this.storage.cached(hash,stage,this.cacheTool(source.id,type,this.version(stage)))));}
  private version(stage:string){return stage==='parse'?this.parseVersion:stage==='label'?this.profile.labeler_version:`${this.profile.extractor_version}:${this.parseVersion}`;}
  private persistReservation(c:Checkpoint,source:SourcePolicy){
    const url=string(c.data,'url'),existing=this.store.recordByUrl(url);
    const r=this.store.reserve('linux',{clip_id:digest([c.run_id,c.item_key]),attempt_id:digest([c.id,c.attempts]),url,brand:source.brand,collection_method:source.browser?'browser_extract':'auto_discovery',operation:existing?.last_checked_at?'recheck':'new_body',policy_version:this.store.settings.policy_version});
    this.store.start('linux',r.id);
    c.data.reservation_id=r.id;
    this.store.transaction(()=>this.store.db.prepare('UPDATE engine_checkpoints SET data=? WHERE id=?').run(stable(c.data),c.id));
    return r.id;
  }
  start(slot={kind:'daily',at:new Date(this.store.now()+9*3600000).toISOString().slice(0,10)}){
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
    if(this.engine.run(runId)?.state!=='running')return;
    const policy=this.profile.domain_policy;
    const sources=this.store.settings.sources.filter(s=>s.enabled&&policy.sources[s.id]).sort((a,b)=>policy.start_order.indexOf(policy.sources[a.id].tier)-policy.start_order.indexOf(policy.sources[b.id].tier));
    for(const source of sources){
      const due=this.store.list<{url:string;source:string;next_recheck_at:string|null}>('collection_records').filter(r=>r.source===source.id&&r.next_recheck_at&&Date.parse(r.next_recheck_at)<=this.store.now()).map(r=>r.url);
      for(const url of [...new Set([...source.entries,...due])].slice(0,Math.min(source.max_pages,this.store.settings.limits.max_pages)))this.engine.enqueue(runId,'discover',digest([source.id,canonicalUrl(url)]),{source_id:source.id,url:canonicalUrl(url),depth:0});
    }
  }
  async run(runId:string){this.ledger.open(runId);return this.engine.runUntilIdle(runId);}
  private parsed(cap:Capture){const p=this.cache<Parsed>(cap,'parse',this.parseVersion);if(!p)throw new Error('input_unavailable');return p;}
  private buildPayload(c:Checkpoint):ClipPayload {
    const cap=this.capture(c),parsed=this.parsed(cap);
    const rows=this.store.db.prepare('SELECT data FROM engine_extracted WHERE capture_id=? ORDER BY id').all(cap.id) as {data:string}[];
    return privacyFilter({title:parsed.title,document_origin:parsed.document_origin,target_model_id:c.data.target_model_id,assertions:rows.map(r=>(JSON.parse(r.data) as {assertion:AssertionInput}).assertion)});
  }
  private serviceRecovery(c:Checkpoint):StageResult|undefined {
    const receipt=this.storage.service!.receipt(string(c.data,'reservation_id'));if(!receipt)return;
    requireThat(receipt.digest===digest(this.buildPayload(c)),'payload_changed');return {outputRef:receipt.id};
  }
  private createHandlers():Record<string,StageHandler>{
    const handler=(version:string,run:StageHandler['run'],commit?:StageHandler['commit']):StageHandler=>({kind:'transactional',version,run,commit});
    return {
      discover:handler('discover@1',async c=>{const s=this.source(c);requireThat(visitAllowed(string(c.data,'url'),s),'visit_not_allowed');this.store.discover(string(c.data,'url'));return {}; }),
      fetch:handler('fetch@1',async c=>{
        const source=this.source(c),policy=this.profile.domain_policy.sources[source.id],url=string(c.data,'url');
        // Mirrors the discovery runner: reserve body/recheck/browser before any transport, including robots.
        if(source.adapter==='links'||Number(c.data.depth)>0||this.store.recordByUrl(url)?.last_checked_at||source.browser)this.persistReservation(c,source);
        const previous=this.store.db.prepare("SELECT * FROM engine_captures WHERE source_id=? AND url_norm=? AND status IN ('ok','not_modified') ORDER BY fetched_at DESC,rowid DESC LIMIT 1").get(source.id,url) as Capture|undefined;
        if(previous)await this.probeType(previous.content_type);
        let result:Awaited<ReturnType<Downloader['download']>>;
        try{result=await new Downloader(new SchedulerFetcher(this.scheduler,source)).download(url,{previous,reusable:h=>this.reusable(h,source,previous?.content_type??'text/html'),render:policy.render});}
        catch(e){
          const code=(e as {code?:string;message?:string}).code??(e as Error).message;
          if(['source_blocked','login_required','access_restricted','empty_page','source_response'].includes(code)){
            const seq=(this.store.db.prepare('SELECT coalesce(max(fetch_seq),0)+1 n FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=?').get(c.run_id,source.id,url) as {n:number}).n;
            this.store.transaction(()=>this.storage.capture({id:digest([c.run_id,source.id,url,seq]),run_id:c.run_id,source_id:source.id,url_norm:url,fetch_seq:seq,fetched_at:new Date(this.store.now()).toISOString(),status:code==='source_response'?'http_error':code==='source_blocked'?'blocked':'restricted',content_hash:null,content_type:null,byte_length:null,etag:null,last_modified:null,raw_ref:null,prev_capture_id:previous?.id??null,data:{reason:code}}));
          }
          throw e;
        }
        const type=(result.response.headers['content-type']??previous?.content_type??'text/html').split(';')[0].trim().toLowerCase();
        requireThat(policy.content_types.some(t=>type===t||t.endsWith('/*')&&type.startsWith(t.slice(0,-1))),'content_type');
        await this.probeType(type);
        let rawRef:string|null=null;
        if(result.bytes){
          this.raw.write(result.bytes);
          const text=new TextDecoder().decode(result.bytes);
          const clean=/text|json|xml|html/.test(type)&&!/<(?:input|textarea|select|script|form)\b|contenteditable|data-private|(?:token|signature|credential|cookie|authorization)\s*["']?\s*[:=]/i.test(text)&&text.split(/[\r\n]+/).every(line=>filterText(line,Number.MAX_SAFE_INTEGER)===line.normalize('NFKC').trim());
          if(policy.raw==='store'&&clean)rawRef=this.raw.write(result.bytes,true);
        }else if(previous?.raw_ref&&this.raw.read(result.hash))rawRef=previous.raw_ref;
        const seq=(this.store.db.prepare('SELECT coalesce(max(fetch_seq),0)+1 n FROM engine_captures WHERE run_id=? AND source_id=? AND url_norm=?').get(c.run_id,source.id,url) as {n:number}).n;
        const cap:Data={id:digest([c.run_id,source.id,url,seq]),run_id:c.run_id,source_id:source.id,url_norm:url,fetch_seq:seq,fetched_at:new Date(this.store.now()).toISOString(),status:result.status,content_hash:result.hash,content_type:type,byte_length:result.bytes?.length??(previous?.byte_length??null),etag:result.response.headers.etag??(result.status==='not_modified'?previous?.etag:null)??null,last_modified:result.response.headers['last-modified']??(result.status==='not_modified'?previous?.last_modified:null)??null,raw_ref:rawRef,prev_capture_id:previous?.id??null,data:{final_url:canonicalUrl(result.response.finalUrl??url)}};
        return {outputRef:String(cap.id),data:{capture:cap,capture_id:cap.id,content_hash:result.hash}};
      },(result)=>{
        this.storage.capture(result.data!.capture as Data);
        const data={...result.data};delete data.capture;return {...result,data};
      }),
      render:handler('render@1',async c=>{
        const cap=this.capture(c),s=this.source(c),policy=this.profile.domain_policy.sources[s.id];
        if(!policy.render||!/html/.test(cap.content_type)||this.cache(cap,'parse',this.parseVersion))return {};
        if(this.cache(cap,'render',this.parseVersion))return {};
        const bytes=this.raw.read(cap.content_hash);if(!bytes)throw new Error('input_unavailable');
        const finalUrl=String(JSON.parse(cap.data).final_url??cap.url_norm);
        const document:FetchResponse={status:200,body:new TextDecoder().decode(bytes),bytes,finalUrl,headers:{'content-type':cap.content_type}};
        const port=this.options.renderer??{render:(url:string,doc:FetchResponse)=>browserDocument(url,s,this.scheduler,{document:doc})};
        const snap=await renderDocument(port,finalUrl,document,true);
        const parsed:Parsed={text:this.cleanLines(snap.regionText??snap.text),eligible:this.eligible(`${snap.text} ${snap.title??''}`),title:filterText(snap.title??'',200),...(snap.documentOrigin?{document_origin:canonicalUrl(snap.documentOrigin)}:{})};
        return {data:{rendered:parsed}};
      },(result,c)=>{if(result.data?.rendered){const cap=this.capture(c);this.storage.cache(cap.content_hash,'render',this.cacheTool(cap.source_id,cap.content_type,this.parseVersion),result.data.rendered);}return {data:{}};}),
      parse:handler(this.parseVersion,async c=>{
        const cap=this.capture(c);await this.probeType(cap.content_type);if(this.cache(cap,'parse',this.parseVersion))return {};
        const s=this.source(c),rendered=this.cache<Parsed>(cap,'render',this.parseVersion);
        let parsed:Parsed;
        if(rendered)parsed=rendered;
        else {
          const bytes=this.raw.read(cap.content_hash);if(!bytes)throw new Error('input_unavailable');
          if(/pdf|^image\//.test(cap.content_type)){
            const path=this.raw.path(cap.content_hash,true);
            this.raw.write(bytes);
            const extracted=cap.content_type==='application/pdf'?await extractPdf(this.tools,path):await extractImage(this.tools,path);
            if(extracted.status==='unsupported')throw Object.assign(new Error('unsupported'),{tool:extracted.tool});
            parsed={text:this.cleanLines(extracted.text)};
          } else if(s.adapter==='cpsc'){
            const found=discoverLinks(new TextDecoder().decode(bytes),cap.url_norm,'cpsc').filter(f=>this.eligible(`${f.title??''} ${f.recall?.name??''}`));
            parsed={text:found.map(f=>filterText(`Recall: ${f.title??f.recall?.name??''}`)).join('\n'),assertions:privacyFilter({assertions:found.filter(f=>f.recall).slice(0,30).map(f=>({field:'recalls',value:f.recall,quote:f.title??f.recall!.name,locator:`$.Recall[RecallID=${f.recall!.id}]`}))}).assertions};
          } else {
            const body=new TextDecoder().decode(bytes),root=parseHtml(body),region=s.selector?selectAll(root,s.selector)[0]:root;
            requireThat(region,'region_missing');
            const rows=selectAll(region,'tr');
            const text=rows.length?[...selectAll(region,'h1,h2').map(textOf),...rows.map(row=>selectAll(row,'th,td').map(cell=>textOf(cell).trim()).join(' | '))].join('\n'):linesOf(region).join('\n');
            parsed={text:this.cleanLines(text),title:filterText(selectAll(root,'h1,h2,title').map(textOf)[0]??'',200)};
            const origin=selectAll(root,'link[rel=original]')[0]?.attrs.href;
            if(origin)parsed.document_origin=canonicalUrl(new URL(origin,cap.url_norm).href);
          }
        }
        return {data:{parsed}};
      },(result,c)=>{
        const cap=this.capture(c),parsed=result.data?.parsed as Parsed|undefined;
        if(parsed)this.storage.cache(cap.content_hash,'parse',this.cacheTool(cap.source_id,cap.content_type,this.parseVersion),parsed);
        // Discovery uses the existing adapter and the same allow policy; never follows external sellers.
        const s=this.source(c),bytes=this.raw.read(cap.content_hash);
        if(bytes&&Number(c.data.depth)<this.store.settings.limits.max_depth&&!s.browser&&s.adapter!=='cpsc'){
          const max=Math.min(s.max_pages,this.store.settings.limits.max_pages);
          let count=(this.store.db.prepare("SELECT count(*) n FROM engine_checkpoints WHERE run_id=? AND stage='fetch' AND json_extract(data,'$.source_id')=?").get(c.run_id,s.id) as {n:number}).n;
          for(const f of discoverLinks(new TextDecoder().decode(bytes),cap.url_norm,s.adapter)){
            if(count>=max)break;
            if(!visitAllowed(f.url,s)||sourceFor(f.url,this.store.settings)?.id!==s.id)continue;
            const url=canonicalUrl(f.url),key=digest([s.id,url]);
            if(this.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='discover' AND item_key=?").get(c.run_id,key))continue;
            this.engine.enqueueInside(c.run_id,'discover',key,{source_id:s.id,url,depth:Number(c.data.depth)+1},digest(url));count++;
          }
        }
        this.raw.removeSpool(cap.content_hash);
        const output=parsed??this.parsed(cap),eligible=output.eligible??this.eligible(output.text);
        return {nextStage:eligible?undefined:null,data:{eligible}};
      }),
      label:handler(this.profile.labeler_version,async c=>{
        const cap=this.capture(c),cached=this.cache<Labeled>(cap,'label',this.profile.labeler_version);if(cached)return {data:{label_result:cached}};
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
        this.storage.cache(cap.content_hash,'label',this.cacheTool(cap.source_id,cap.content_type,this.profile.labeler_version),labeled);
        for(const label of labeled.labels)this.storage.label({id:digest([cap.id,this.profile.labeler_version,label]),capture_id:cap.id,label:AGAMAJUNG_LABELS[label],method:labeled.method,status:labeled.status,fact_status:labeled.method==='model'?'ai_inference':'unverified',extractor:this.profile.labeler_version,data:{}});
        return {data:{label_status:labeled.status}};
      }),
      extract:handler(this.profile.extractor_version,async c=>{
        const cap=this.capture(c),source=this.source(c),parsed=this.parsed(cap);
        let assertions=this.cache<AssertionInput[]>(cap,'extract',this.version('extract'));
        if(!assertions){
          assertions=privacyFilter({assertions:parsed.assertions??extractRules(parsed.text,source.selector||'document')}).assertions;
        }
        return {data:{assertions}};
      },(result,c)=>{
        const cap=this.capture(c),source=this.source(c),neutral=result.data!.assertions as AssertionInput[];
        this.storage.cache(cap.content_hash,'extract',this.cacheTool(cap.source_id,cap.content_type,this.version('extract')),neutral);
        const assertions=neutral.map(a=>a.field==='official_msrp'&&!(source.official_fields.includes('official_msrp')&&a.msrp_explicit&&['manufacturer','importer'].includes(source.kind))?{...a,field:'clue_price' as const}:a),subject=subjectRef({target_model_id:c.data.target_model_id as string|undefined,assertions},cap.url_norm),slots=claimSlots(assertions);
        assertions.forEach((a,index)=>{
          const key=conditionsKey(a,['clue_price','group_buy_terms'].includes(a.field)?new URL(cap.url_norm).origin:'');
          const previous=this.store.db.prepare('SELECT e.* FROM engine_extracted e JOIN engine_captures c ON e.capture_id=c.id WHERE e.subject_ref=? AND e.field=? AND e.conditions_key=? AND c.source_id=? AND e.collected_at<? ORDER BY e.collected_at DESC,e.id DESC LIMIT 1').get(subject,a.field,key,cap.source_id,cap.fetched_at) as {data:string;collected_at:string;change_window_start:string|null}|undefined;
          const stated=a.conditions?.effective_at,validDate=stated&&Number.isFinite(Date.parse(stated));
          const window=previous?(stable(JSON.parse(previous.data).assertion.value)===stable(a.value)?previous.change_window_start:previous.collected_at):null;
          this.storage.extracted({id:digest([cap.id,this.profile.extractor_version,subject,a.field,key,slots[index]]),capture_id:cap.id,subject_ref:subject,field:a.field,conditions_key:key,claim_slot:slots[index],source_url:cap.url_norm,locator:a.locator,quote:a.quote.slice(0,300),collected_at:cap.fetched_at,effective_from:validDate?new Date(stated!).toISOString():cap.fetched_at,effective_from_basis:validDate?'stated':'observed',change_window_start:window,fact_status:'source_claim',extractor:this.profile.extractor_version,data:{assertion:a}});
        });
        return {data:{completeness:Object.fromEntries(REQUIRED_FIELDS.map(field=>[field,assertions.some(a=>a.field===field)?'present':'missing']))}};
      }),
      service:{kind:'external',version:'service@1',recover:c=>this.serviceRecovery(c),run:async c=>{
        const old=this.serviceRecovery(c);if(old)return old;
        const oldReservation=c.data.reservation_id?this.store.reservation('linux',String(c.data.reservation_id)):undefined;
        if(!oldReservation||((c.data.parent_run||c.data.carried_from)&&(oldReservation.submit_until??0)<this.store.now()))this.persistReservation(c,this.source(c));
        const source=this.source(c),receipt=await this.storage.service!.submit(string(c.data,'reservation_id'),this.buildPayload(c),source.adapter==='cpsc'?source.id:undefined);
        return {outputRef:receipt.id};
      }},
    };
  }
  private eligible(text:string){const normalized=text.toLocaleLowerCase();return !this.profile.excluded_keywords.some(k=>normalized.includes(k.toLocaleLowerCase()))&&this.profile.categories.some(category=>[...category.ko,...category.en].some(k=>normalized.includes(k.toLocaleLowerCase())));}
  private cleanLines(text:string){return text.split(/[\r\n]+/).map(line=>filterText(line,1000)).filter(Boolean).join('\n').slice(0,20000);}
}
