import { Scheduler } from '../scheduler';
import { CollectorStore, requireThat } from '../store';
import { discoverLinks } from './adapters';
import { sourceFor, type SourcePolicy } from '../source-policy';
import { browserExtract } from './browser';
import { extractFacts } from '../../../shared/fact-extract';
import { parseItems, parseHtml, selectAll, textOf } from '../../lib/external/parse';
import { buildPayload } from '../../lib/external/filter';
import type { ClipPayload, CollectionRecord } from '../../../shared/collection-schema';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { digest } from '../dedup';
export type Job={id:string;url:string;source_id:string;depth:number;operation:'discovery'|'recheck';phase:'pending'|'leased'|'done'|'failed';lease_until:number;cursor:number;finished_at?:number;attempt?:number};
export class DiscoveryRunner {
  constructor(readonly store:CollectorStore,readonly scheduler=new Scheduler(store)) {}
  enqueue(raw:string,source:SourcePolicy,depth=0,operation:Job['operation']='discovery') {
    requireThat(depth<=this.store.settings.limits.max_depth,'depth_limit');const url=canonicalUrl(raw),id=digest([url,operation]),old=this.store.get<Job>('collection_jobs',id);
    if(old&&(old.phase==='pending'||old.phase==='leased'||(old.finished_at??0)+source.recheck_ms>this.store.now()))return;
    this.store.transaction(()=>this.store.put('collection_jobs',id,{id,url,source_id:source.id,depth,operation,phase:'pending',lease_until:0,cursor:0,attempt:(old?.attempt??0)+1} satisfies Job));
  }
  seed(){for(const source of this.store.settings.sources.filter(s=>s.enabled))for(const url of source.entries)this.enqueue(url,source);}
  async run(dryRun=false) {
    if(dryRun){
      // Business data and cursors remain untouched; transport limits/stops still persist.
      for(const source of this.store.settings.sources.filter(s=>s.enabled))for(const url of source.entries.slice(0,Math.min(source.max_pages,this.store.settings.limits.max_pages))){this.store.authorizeProbe(source.brand);if(source.browser)await browserExtract(url,source,this.scheduler);else discoverLinks((await this.scheduler.get(url,source)).body,url,source.adapter);}
      return;
    }
    for(const r of this.store.list<CollectionRecord>('collection_records').filter(r=>r.next_recheck_at&&Date.parse(r.next_recheck_at)<=this.store.now())){const s=sourceFor(r.url,this.store.settings);if(s?.enabled)this.enqueue(r.url,s,0,'recheck');}
    const pages=new Map<string,number>();
    for(;;){
      const jobs=this.store.list<Job>('collection_jobs').filter(j=>(j.phase==='pending'||j.phase==='leased'&&j.lease_until<=this.store.now())&&(pages.get(j.source_id)??0)<Math.min(this.store.settings.sources.find(s=>s.id===j.source_id)?.max_pages??0,this.store.settings.limits.max_pages)).sort((a,b)=>Number(b.operation==='recheck')-Number(a.operation==='recheck')||a.depth-b.depth);
      const j=jobs[0];if(!j)break;
      const source=this.store.settings.sources.find(s=>s.id===j.source_id&&s.enabled);if(!source){pages.set(j.source_id,Infinity);continue;}
      pages.set(source.id,(pages.get(source.id)??0)+1);
      this.store.transaction(()=>{j.phase='leased';j.lease_until=this.store.now()+180000;this.store.put('collection_jobs',j.id,j);});
      try {
        if(source.browser){await this.collect(j,source);}
        else {
          // Reserve every HTML/body attempt before reading, not just successful records.
          const reservation=(source.adapter==='links'||j.depth>0||j.operation==='recheck')?this.reservation(j,source,j.url,'body'):null;
          const response=await this.scheduler.get(j.url,source);
          const adapter=(source.adapter==='rss'&&!/<(?:rss|feed)\b/i.test(response.body))||(source.adapter==='sitemap'&&!/<(?:urlset|sitemapindex)\b/i.test(response.body))?'links':source.adapter;
          const found=discoverLinks(response.body,j.url,adapter);
          for(let index=j.cursor;index<found.length;index++){
            const f=found[index];
            try{
              this.store.discover(f.url,'auto_discovery',f.title??null);
              if(f.recall){const r=this.reservation(j,source,f.url,`recall:${index}`);this.store.submit('linux',r.id,{title:f.title,assertions:[{field:'recalls',value:f.recall,quote:f.title??f.recall.name,locator:`$.Recall[RecallID=${f.recall.id}]`}]},source.id);}
              const next=sourceFor(f.url,this.store.settings);
              if(j.depth<this.store.settings.limits.max_depth&&next?.id===source.id)this.enqueue(f.url,source,j.depth+1);
            }catch(e){if(!(e instanceof Error)||!['unsafe_url','private_url'].includes(e.message))throw e;}
            j.cursor=index+1;this.store.transaction(()=>this.store.put('collection_jobs',j.id,j));
          }
          if(reservation){
            const items=parseItems(response.body,j.url,source.origin,source.selector,new Date(this.store.now()));
            // Existing baby-only classifier and model matches are retained; never follow sellers.
            for(const [index,item] of items.entries()){
              const legacy=buildPayload(source.id,item,new Date(this.store.now()));if(!legacy)continue;
              const r=this.reservation(j,source,item.source_url,`listing:${index}`);
              const payload:ClipPayload={title:item.title,seller_handle:item.seller_handle??undefined,target_model_id:legacy.suggestions.models.length===1?legacy.suggestions.models[0].model_id:null,assertions:[]};
              if(item.price)payload.assertions.push({field:'clue_price',value:item.price.value,quote:item.price.raw,locator:source.selector||'listing'});
              if(item.dates)payload.assertions.push({field:'group_buy_terms',value:item.dates.raw,quote:item.dates.raw,locator:source.selector||'listing'});
              this.store.submit('linux',r.id,payload);
            }
            const root=parseHtml(response.body),region=source.selector?selectAll(root,source.selector)[0]:undefined;
            this.store.submit('linux',reservation.id,{assertions:region?extractFacts(textOf(region),source.selector):[]});
          }
        }
        j.phase='done';
      }catch{j.phase='failed';}
      this.store.transaction(()=>{j.lease_until=0;j.finished_at=this.store.now();this.store.put('collection_jobs',j.id,j);});
    }
  }
  private reservation(job:Job,source:SourcePolicy,url:string,suffix:string){
    url=canonicalUrl(url);const existing=this.store.recordByUrl(url);const operation=job.operation==='recheck'&&existing?.last_checked_at?'recheck':'new_body';
    const r=this.store.reserve('linux',{clip_id:job.id,attempt_id:digest([job.attempt??1,suffix]),url,brand:sourceFor(url,this.store.settings)?.brand??'unknown',collection_method:source.browser?'browser_extract':'auto_discovery',operation,policy_version:this.store.settings.policy_version});
    return this.store.start('linux',r.id);
  }
  private async collect(job:Job,source:SourcePolicy) {
    const r=this.reservation(job,source,job.url,'browser');
    // A lease recovered after an interrupted extraction cannot reuse its spent attempt.
    if((r.execution_until??0)<=this.store.now())throw new Error('execution_expired');
    this.store.submit('linux',r.id,await browserExtract(job.url,source,this.scheduler));
  }
}
