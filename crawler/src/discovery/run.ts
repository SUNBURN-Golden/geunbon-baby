import { randomUUID } from 'node:crypto';
import { isPangpang, pangpangIdentityAllowed } from '../../lib/external/pangpang';
import { eligibilityReason } from '../../lib/external/filter';
import { SchedulerFetcher } from '../agamajung/fetcher';
import { pangpangLog, pangpangContext, reportPangpang, type PangpangLog } from './pangpang-diagnostics';
import { diagnosticContext, eligibilityLog as defaultEligibilityLog, isSnapup, reportEligibilityPage, type DiagnosticContext, type DiagnosticStage, type EligibilityLog } from './eligibility-diagnostics';
import { Scheduler, type DomainState } from '../scheduler';
import { CollectorStore, requireThat } from '../store';
import { RunHealth, failureCode } from './health';
import { measurePage, measureBrowser } from './measure';
import { sourceFor, visitAllowed, type SourcePolicy } from '../source-policy';
import { browserExtract } from './browser';
import { extractFacts } from '../../../shared/fact-extract';
import { parseHtml, selectAll, textOf } from '../../lib/external/parse';
import type { ClipPayload, CollectionRecord } from '../../../shared/collection-schema';
import { canonicalUrl, URL_IDENTITY_VERSION, isUrlRejection } from '../../../shared/privacy-rules';
import { digest } from '../dedup';
export { failureCode } from './health';
export const DRY_RUN_ITEM_PROBES=2;
const itemRejection=(e:unknown)=>isUrlRejection(e)||e instanceof Error&&e.message==='url_identity_changed';
export type Job={url_identity_version:number;id:string;url:string;source_id:string;depth:number;operation:'discovery'|'recheck';phase:'pending'|'leased'|'done'|'failed';lease_until:number;cursor:number;finished_at?:number;attempt?:number;failure_reason?:string};
export class DiscoveryRunner {
  private runRef:string = randomUUID();
  constructor(readonly store:CollectorStore,readonly scheduler=new Scheduler(store),readonly log:PangpangLog=pangpangLog,readonly eligibilityLog:EligibilityLog=defaultEligibilityLog) {}
  enqueue(raw:string,source:SourcePolicy,depth=0,operation:Job['operation']='discovery') {
    if(isPangpang(source))requireThat(visitAllowed(raw,source),'visit_not_allowed');
    const url=canonicalUrl(raw),id=digest([URL_IDENTITY_VERSION,url,operation]),old=this.store.get<Job>('collection_jobs',id);
    if(old?.phase==='failed'){this.retryFailed(old);return;}
    requireThat(visitAllowed(raw,source),'visit_not_allowed');
    requireThat(depth<=this.store.settings.limits.max_depth,'depth_limit');
    if(old&&(old.phase==='pending'||old.phase==='leased'||(old.finished_at??0)+source.recheck_ms>this.store.now()))return;
    this.store.transaction(()=>this.store.put('collection_jobs',id,{url_identity_version:URL_IDENTITY_VERSION,id,url,source_id:source.id,depth,operation,phase:'pending',lease_until:0,cursor:0,attempt:old?(old.attempt??1)+1:1} satisfies Job));
  }
  private retryFailed(job:Job) {
    if(job.url_identity_version!==URL_IDENTITY_VERSION)return;
    const record=this.store.recordByUrl(job.url);if(record&&!this.store.recordIdentityCurrent(record))return;
    if(job.finished_at===undefined||job.finished_at+this.store.settings.limits.failure_backoff_ms>this.store.now())return;
    const source=this.store.settings.sources.find(s=>s.id===job.source_id&&s.enabled);
    if(!source||!visitAllowed(job.url,source))return;
    if(!Number.isSafeInteger(job.depth)||job.depth<0||job.depth>this.store.settings.limits.max_depth)return;
    const domain=this.store.get<DomainState>('domain_state',new URL(job.url).hostname);
    if(domain?.stopped||(domain?.next_at??0)>this.store.now())return;
    // Keep the original binding and spent attempts; the next reservation must be fresh.
    const {id,url,source_id,depth,operation}=job;
    this.store.transaction(()=>this.store.put('collection_jobs',id,{url_identity_version:URL_IDENTITY_VERSION,id,url,source_id,depth,operation,phase:'pending',lease_until:0,cursor:0,attempt:(job.attempt??1)+1} satisfies Job));
  }
  seed(){for(const source of this.store.settings.sources.filter(s=>s.enabled))for(const url of source.entries){try{this.enqueue(url,source);}catch(e){if(!itemRejection(e))throw e;}}}
  async run(dryRun=false,runRef:string=randomUUID()) {
    this.runRef=runRef;
    const mode=dryRun?'dry_run':'run',health=new RunHealth();
    this.scheduler.takeBlocked();
    const enabled=this.store.settings.sources.filter(s=>s.enabled);
    for(const source of enabled){
      health.source(source.id,mode);
      if(isSnapup(source)&&!source.browser&&source.adapter==='links')health.enableEligibilityDiagnostics(source.id);
    }
    let sources:ReturnType<RunHealth['finish']>=[];
    try {
      if(dryRun)await this.probe(health);
      else await this.runJobs(health);
    } finally {
      sources=health.finish(this.scheduler.takeBlocked(),new Map(enabled.map(s=>[s.id,s.browser?'browser':s.adapter])));
      for(const h of sources)if(h.eligibility_diagnostics){
        const source=enabled.find(s=>s.id===h.source_id)!;
        this.eligibilityLog({...diagnosticContext(mode,this.runRef,'run-summary','run-summary',this.store.now(),source,this.store.settings.policy_version),event:'run_summary',totals:h.eligibility_diagnostics});
      }
    }
    const attempted=sources.filter(s=>s.pages_attempted>0);
    const status=attempted.length===0?'idle':attempted.every(s=>s.status==='ok')?'ok':'review';
    return {mode,status,sources,review:sources.filter(s=>s.status==='review').map(s=>s.source_id)};
  }
  private async runJobs(health:RunHealth) {
    this.store.reconcileIdentity();
    // One scan per normal run, including children whose successful parent is still fresh.
    for(const job of this.store.list<Job>('collection_jobs'))if(job.phase==='failed')this.retryFailed(job);
    for(const r of this.store.list<CollectionRecord>('collection_records').filter(r=>this.store.recordIdentityCurrent(r)&&r.next_recheck_at&&Date.parse(r.next_recheck_at)<=this.store.now())){const s=sourceFor(r.url,this.store.settings);if(s?.enabled)this.enqueue(r.url,s,0,'recheck');}
    const pages=new Map<string,number>();
    for(;;){
      const jobs=this.store.list<Job>('collection_jobs').filter(j=>j.url_identity_version===URL_IDENTITY_VERSION&&(j.phase==='pending'||j.phase==='leased'&&j.lease_until<=this.store.now())&&(pages.get(j.source_id)??0)<Math.min(this.store.settings.sources.find(s=>s.id===j.source_id)?.max_pages??0,this.store.settings.limits.max_pages)).sort((a,b)=>Number(b.operation==='recheck')-Number(a.operation==='recheck')||a.depth-b.depth);
      const j=jobs[0];if(!j)break;
      const source=this.store.settings.sources.find(s=>s.id===j.source_id&&s.enabled);if(!source){pages.set(j.source_id,Infinity);continue;}
      pages.set(source.id,(pages.get(source.id)??0)+1);
      this.store.transaction(()=>{j.phase='leased';j.lease_until=this.store.now()+180000;this.store.put('collection_jobs',j.id,j);});
      const diagnostic=this.beginEligibility(health,source,'run',j.url);
      let phase:DiagnosticStage='transport';
      try {
        if(source.browser){health.pageOk(source.id,await this.collect(j,source,health));}
        else {
          // Reserve every HTML/body attempt before reading, not just successful records.
          const reservation=(source.adapter==='links'||j.depth>0||j.operation==='recheck')?this.reservation(j,source,j.url,'body'):null;
          const response=await new SchedulerFetcher(this.scheduler,source).get(j.url);
          if(isPangpang(source))requireThat(pangpangIdentityAllowed(j.url,response.finalUrl??j.url),'redirect_identity');
          requireThat(canonicalUrl(response.finalUrl??j.url)===j.url,'document_changed');
          phase='extraction';
          const m=measurePage(response.body,response.finalUrl??j.url,source,this.store.settings,new Date(this.store.now()),{listing:!!reservation});
          if(diagnostic&&m.eligibility_diagnostics){
            diagnostic.captured_at=new Date(this.store.now()).toISOString();
            if(health.diagnosticMeasured(source.id,diagnostic.attempt_ref,m.eligibility_diagnostics))reportEligibilityPage(m.eligibility_diagnostics,diagnostic,this.eligibilityLog);
          }
          phase='submission';
          const found=m.found;
          let scheduled=0,submitted=0;const deferred=new Set<string>();
          try {
          for(let index=j.cursor;index<found.length;index++){
            const f=found[index];
            if(m.pangpang&&(j.depth>=this.store.settings.limits.max_depth||scheduled>=Math.max(0,Math.min(source.max_pages,this.store.settings.limits.max_pages)-(pages.get(source.id)??0)))){deferred.add(f.url);continue;}
            try{
              this.store.discover(f.url,'auto_discovery',f.title??null);
              if(f.recall?.id.trim()&&(f.recall.name?.trim()||f.title?.trim())){const r=this.reservation(j,source,f.url,`recall:${index}`);this.store.submit('linux',r.id,{title:f.title,assertions:[{field:'recalls',value:f.recall,quote:f.title??f.recall.name,locator:`$.Recall[RecallID=${f.recall.id}]`}]},source.id);health.sent(source.id);}
              const next=sourceFor(f.url,this.store.settings);
              if(j.depth<this.store.settings.limits.max_depth&&next?.id===source.id){
                if(m.pangpang&&scheduled>=Math.max(0,Math.min(source.max_pages,this.store.settings.limits.max_pages)-(pages.get(source.id)??0)))deferred.add(f.url);
                else {this.enqueue(f.url,source,j.depth+1);scheduled++;if(m.pangpang)this.log({...pangpangContext('discover',this.runRef,j.id),event:'progress',stage:'scheduled',product_ref:digest(f.url)});}
              }else if(m.pangpang)deferred.add(f.url);
            }catch(e){if(m.pangpang&&failureCode(e)==='daily_limit'){deferred.add(f.url);continue;}if(!itemRejection(e))throw e;health.subrequestFailed(source.id,failureCode(e));}
            j.cursor=index+1;this.store.transaction(()=>this.store.put('collection_jobs',j.id,j));
          }
          if(reservation){
            // Existing baby-only classifier and model matches are retained; never follow sellers.
            for(const [index,{item,legacy}] of (m.listing??[]).entries()){
              if(m.pangpang&&!m.pangpang.detail&&deferred.has(item.source_url))continue;
              let r;try{r=this.reservation(j,source,item.source_url,`listing:${index}`);}catch(e){if(m.pangpang&&failureCode(e)==='daily_limit'){deferred.add(item.source_url);continue;}if(itemRejection(e)){health.subrequestFailed(source.id,failureCode(e));continue;}throw e;}
              const payload:ClipPayload={title:item.title,seller_handle:item.seller_handle??undefined,target_model_id:legacy.suggestions.models.length===1?legacy.suggestions.models[0].model_id:null,assertions:[]};
              if(item.price)payload.assertions.push({field:'clue_price',value:item.price.value,quote:item.price.raw,locator:'locator' in item?String(item.locator):source.selector||'listing'});
              if(item.dates)payload.assertions.push({field:'group_buy_terms',value:item.dates.raw,quote:item.dates.raw,locator:'locator' in item?String(item.locator):source.selector||'listing'});
              this.store.submit('linux',r.id,payload);health.sent(source.id);submitted++;if(m.pangpang)this.log({...pangpangContext('discover',this.runRef,j.id),event:'progress',stage:'submitted',product_ref:digest(item.source_url)});
            }
            if(!m.pangpang){const root=parseHtml(response.body),region=source.selector?selectAll(root,source.selector)[0]:undefined;
              this.store.submit('linux',reservation.id,{assertions:region?extractFacts(textOf(region),source.selector):[]});}
          }
          } finally {if(m.pangpang){const summary=reportPangpang(m.pangpang,pangpangContext('discover',this.runRef,j.id),this.log,eligibilityReason,deferred,scheduled,submitted);Object.assign(m,{link_dispositions:summary.dispositions,unique_products:summary.unique_products,product_refs:m.pangpang.products.map(p=>digest(p.source_url)),scheduled,deferred:deferred.size});}}
          health.pageOk(source.id,m);
        }
        j.phase='done';delete j.failure_reason;
      }catch(e){j.phase='failed';j.failure_reason=failureCode(e);health.pageFailed(source.id,j.failure_reason);if(isPangpang(source))this.log({...pangpangContext('discover',this.runRef,j.id),...(phase==='transport'?{event:'transport' as const}:{event:'failure' as const,stage:phase}),reason:j.failure_reason});}
      if(diagnostic)this.endEligibility(health,source,diagnostic,j.phase==='failed'?phase:undefined,j.failure_reason);
      this.store.transaction(()=>{j.lease_until=0;j.finished_at=this.store.now();this.store.put('collection_jobs',j.id,j);});
    }
  }
  private async probe(health:RunHealth) {
    // Business data and cursors remain untouched; transport limits/stops still persist.
    for(const source of this.store.settings.sources.filter(s=>s.enabled)){
      const budget=Math.min(source.max_pages,this.store.settings.limits.max_pages);
      let attempted=0;
      const visited=new Set<string>();
      const measure=async(url:string,listing:boolean)=>{
        attempted++;let phase:'transport'|'extraction'='transport';
        const diagnostic=this.beginEligibility(health,source,'dry_run',url);
        let failure:string|undefined;
        try{
          visited.add(canonicalUrl(url));
          this.store.authorizeProbe(source.brand);
          if(source.browser){health.pageOk(source.id,measureBrowser(await browserExtract(url,source,this.scheduler,{url:canonicalUrl(url),url_identity_version:URL_IDENTITY_VERSION},code=>health.subrequestFailed(source.id,code))));return;}
          const response=await new SchedulerFetcher(this.scheduler,source).get(url);
          phase='extraction';
          requireThat(canonicalUrl(response.finalUrl??url)===canonicalUrl(url),'document_changed');
          const m=measurePage(response.body,response.finalUrl??url,source,this.store.settings,new Date(this.store.now()),{listing});
          if(diagnostic&&m.eligibility_diagnostics){
            diagnostic.captured_at=new Date(this.store.now()).toISOString();
            if(health.diagnosticMeasured(source.id,diagnostic.attempt_ref,m.eligibility_diagnostics))reportEligibilityPage(m.eligibility_diagnostics,diagnostic,this.eligibilityLog);
          }
          if(m.pangpang){
            const probes=this.store.settings.limits.max_depth>0?m.found.filter(f=>sourceFor(f.url,this.store.settings)?.id===source.id&&!visited.has(f.url)).slice(0,Math.min(DRY_RUN_ITEM_PROBES,budget-attempted)):[];
            const selected=new Set(probes.map(p=>p.url)),deferred=new Set(m.pangpang.detail?[]:m.pangpang.products.filter(p=>!selected.has(p.source_url)).map(p=>p.source_url));
            const summary=reportPangpang(m.pangpang,pangpangContext('discover',this.runRef,url),this.log,eligibilityReason,deferred,probes.length);Object.assign(m,{link_dispositions:summary.dispositions,unique_products:summary.unique_products,product_refs:m.pangpang.products.map(p=>digest(p.source_url)),scheduled:probes.length,deferred:deferred.size});}
          health.pageOk(source.id,m);return m;
        }catch(e){failure=failureCode(e);health.pageFailed(source.id,failure);if(isPangpang(source))this.log({...pangpangContext('discover',this.runRef,url),...(phase==='transport'?{event:'transport' as const}:{event:'failure' as const,stage:phase}),reason:failureCode(e)});}
        finally {if(diagnostic)this.endEligibility(health,source,diagnostic,failure?phase:undefined,failure);}
      };
      for(const url of source.entries.slice(0,budget)){
        if(attempted>=budget)break;
        const m=await measure(url,source.adapter==='links');
        if(!m||source.adapter==='cpsc'||this.store.settings.limits.max_depth===0)continue;
        const links=[...new Set(m.found.filter(f=>sourceFor(f.url,this.store.settings)?.id===source.id).map(f=>f.url))];
        for(const link of links.filter(url=>!visited.has(url)).slice(0,Math.min(DRY_RUN_ITEM_PROBES,budget-attempted)))await measure(link,true);
      }
    }
  }
  private beginEligibility(health:RunHealth,source:SourcePolicy,mode:'run'|'dry_run',page:string):DiagnosticContext|undefined {
    if(!isSnapup(source)||source.browser||source.adapter!=='links')return;
    const context=diagnosticContext(mode,this.runRef,page,randomUUID(),this.store.now(),source,this.store.settings.policy_version);
    if(health.diagnosticAttempt(source.id,context.attempt_ref))this.eligibilityLog({...context,event:'attempt'});
    return context;
  }
  private endEligibility(health:RunHealth,source:SourcePolicy,context:DiagnosticContext,stage?:DiagnosticStage,reason?:string) {
    const terminal=health.diagnosticTerminal(source.id,context.attempt_ref,stage,reason);
    if(terminal)this.eligibilityLog({...context,event:'page_terminal',measured:terminal.measured,outcome:reason?'failed':'ok',...(reason?{stage,reason}:{})});
  }
  private reservation(job:Job,source:SourcePolicy,url:string,suffix:string){
    url=canonicalUrl(url);const existing=this.store.recordByUrl(url);const operation=job.operation==='recheck'&&existing?.last_checked_at?'recheck':'new_body';
    const r=this.store.reserve('linux',{clip_id:job.id,attempt_id:digest([job.attempt??1,suffix]),url,brand:sourceFor(url,this.store.settings)?.brand??'unknown',collection_method:source.browser?'browser_extract':'auto_discovery',operation,policy_version:this.store.settings.policy_version,url_identity_version:URL_IDENTITY_VERSION});
    return this.store.start('linux',r.id);
  }
  private async collect(job:Job,source:SourcePolicy,health:RunHealth) {
    const r=this.reservation(job,source,job.url,'browser');
    // A lease recovered after an interrupted extraction cannot reuse its spent attempt.
    if((r.execution_until??0)<=this.store.now())throw new Error('execution_expired');
    const payload=await browserExtract(job.url,source,this.scheduler,r,code=>health.subrequestFailed(source.id,code));
    this.store.submit('linux',r.id,payload);health.sent(source.id);
    return measureBrowser(payload);
  }
}
