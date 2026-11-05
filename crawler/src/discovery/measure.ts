import { extractPangpang, isPangpang, type PangpangPage } from '../../lib/external/pangpang';
import { discoverLinks, type Found } from './adapters';
import { hasNumericPrice, type PageMeasure } from './health';
import { visitAllowed, sourceFor, type CollectorConfig, type SourcePolicy } from '../source-policy';
import { CollectorError } from '../store';
import { parseItemsDetailed, type DetailedParse, type ParsedItem } from '../../lib/external/parse';
import { buildPayload, evaluatePayload, eligibilityReason, type ExternalPayload } from '../../lib/external/filter';
import { isSnapup, pageEligibilityDiagnostics, type PageEligibilityDiagnostics } from './eligibility-diagnostics';
import type { ClipPayload } from '../../../shared/collection-schema';

export type Measured = PageMeasure & {found:Found[];pangpang?:PangpangPage;eligibility_diagnostics?:PageEligibilityDiagnostics;listing?:{item:ParsedItem;legacy:ExternalPayload}[]};
export function measurePage(body:string,pageUrl:string,source:SourcePolicy,settings:CollectorConfig,now:Date,{listing}:{listing:boolean}):Measured {
  if(isPangpang(source)){
    const page=extractPangpang(body,pageUrl,now,url=>visitAllowed(url,source));
    for(const outcome of page.outcomes)if(outcome.reason==='accepted_product')outcome.reason=eligibilityReason(page.products[outcome.product_index!])??'accepted_product';
    const products=page.products;
    const accepted=products.flatMap(item=>{const legacy=buildPayload(source.id,item,now);return legacy?[{item,legacy}]:[];});
    return {kind:'listing',pangpang:page,found:page.detail?[]:products.map(p=>({url:p.source_url,title:p.title})),listing:accepted,
      links_found:page.links_encountered,parsed:products.length,eligible:accepted.length,price_checked:0,price_hints:0};
  }
  const adapter=(source.adapter==='rss'&&!/<(?:rss|feed)\b/i.test(body))||(source.adapter==='sitemap'&&!/<(?:urlset|sitemapindex)\b/i.test(body))?'links':source.adapter;
  const found=discoverLinks(body,pageUrl,adapter);
  const m:Measured={kind:'feed',found,links_found:found.length,parsed:found.length,eligible:0,price_checked:0,price_hints:0};
  if(adapter==='cpsc'){
    m.kind='recalls';m.eligible=found.filter(f=>f.recall?.id.trim()&&(f.recall.name?.trim()||f.title?.trim())).length;
  }else if(listing){
    let parsed:DetailedParse;
    try{parsed=parseItemsDetailed(body,pageUrl,source.origin,source.selector,now);}catch(e){
      if(e instanceof Error&&e.message.startsWith('지원하지 않는 셀렉터:'))throw new CollectorError('selector_invalid');
      throw e;
    }
    const items=parsed.items,evaluations=items.map(item=>evaluatePayload(source.id,item,now));
    m.kind='listing';m.parsed=items.length;
    m.listing=items.flatMap((item,index)=>{const result=evaluations[index];return result.accepted?[{item,legacy:result.payload}]:[];});
    if(isSnapup(source))m.eligibility_diagnostics=pageEligibilityDiagnostics(parsed,evaluations);
    m.eligible=m.listing.length;m.price_checked=m.eligible;
    m.price_hints=m.listing.filter(({item})=>hasNumericPrice(item.price?.value)).length;
  }else m.eligible=found.filter(f=>sourceFor(f.url,settings)?.id===source.id).length;
  return m;
}
export function measureBrowser(payload:ClipPayload):PageMeasure {
  const prices=payload.assertions.filter(a=>a.field==='clue_price'||a.field==='official_msrp');
  return {kind:'browser',links_found:0,parsed:1,eligible:payload.assertions.length?1:0,price_checked:prices.length,price_hints:prices.filter(a=>hasNumericPrice(a.value)).length};
}
