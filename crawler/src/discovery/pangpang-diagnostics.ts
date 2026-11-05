import type { LinkReason, PangpangPage, PangpangProduct } from '../../lib/external/pangpang';
import { digest } from '../dedup';
export type PangpangContext={command:'discover'|'collect';run_ref:string;page_ref:string};
export type PangpangEvent=PangpangContext & ({event:'run_summary';extractor_version:string;scheduled:number;submitted:number;transport_failures:Record<string,number>}|{event:'failure';stage:'extraction'|'submission';reason:string}|{event:'transport';reason:string}|{event:'link';link_index:number;reason:LinkReason}|{event:'summary';extractor_version:string;links_encountered:number;unique_products:number;parsed:number;eligible:number;excluded:Record<string,number>;dispositions:Record<string,number>;scheduled:number;deferred:number;submitted:number}|{event:'progress';stage:'scheduled'|'submitted'|'deferred_limit';product_ref:string});
export type PangpangLog=(event:PangpangEvent)=>void;
export const pangpangLog:PangpangLog=event=>console.error(`pangpang ${JSON.stringify(event)}`);
export const pangpangContext=(command:PangpangContext['command'],run:string,page:string):PangpangContext=>({command,run_ref:digest(run),page_ref:digest(page)});
export function reportPangpang(page:PangpangPage,context:PangpangContext,log:PangpangLog,eligibility:(p:PangpangProduct)=>LinkReason|null,deferred=new Set<string>(),scheduled=0,submitted=0){
  const reasons=page.products.map(eligibility),excluded:Record<string,number>={},dispositions:Record<string,number>={};
  for(const reason of reasons)if(reason)excluded[reason]=(excluded[reason]??0)+1;
  for(const o of page.outcomes){
    const reason=o.product_index!==undefined&&o.reason!=='duplicate_product'?(deferred.has(page.products[o.product_index].source_url)?'deferred_limit':reasons[o.product_index]??'accepted_product'):o.reason;
    dispositions[reason]=(dispositions[reason]??0)+1;
    log({...context,event:'link',link_index:o.index,reason});
  }
  const summary={...context,event:'summary' as const,extractor_version:page.version,links_encountered:page.links_encountered,unique_products:page.products.length,parsed:page.products.length,eligible:reasons.filter(r=>!r).length,excluded,dispositions,scheduled,deferred:deferred.size,submitted};
  log(summary);
  for(const p of page.products)if(deferred.has(p.source_url))log({...context,event:'progress',stage:'deferred_limit',product_ref:digest(p.source_url)});
  return summary;
}
