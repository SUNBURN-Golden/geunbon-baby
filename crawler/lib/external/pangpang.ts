// Linux collector pure extractor. No transport, persistence, or whole-page fallback.
import type { ParseBudget } from './parse-budget';
import { canonicalUrl, filterText } from '../../../shared/privacy-rules';
import { extractDates } from '../extract';
import { parseHtml, selectAll, textOf, type El, type ParsedItem } from './parse';

export const PANGPANG_VERSION = 'pangpang@1';
export const isPangpang = (s: {id:string;origin:string}) => s.id === 'pangpang' && s.origin === 'https://09pangpang.com';
export function pangpangPost(raw:string):string|null {
  try { const u=new URL(raw);return u.origin==='https://09pangpang.com'?/^\/post\/(\d+)\/?$/.exec(u.pathname)?.[1]??null:null; } catch { return null; }
}
// This one observed tracking variant is permitted BEFORE canonicalUrl removes it.
export function pangpangQueryAllowed(u:URL):boolean {
  const entries=[...u.searchParams];
  return entries.length===0 || !!pangpangPost(u.href)&&entries.length===1&&entries[0][0]==='source'&&entries[0][1]==='home';
}
export function pangpangIdentityAllowed(requested:string,destination:string):boolean {
  try {
    const a=new URL(requested),b=new URL(destination);
    if(!pangpangQueryAllowed(b))return false;
    const id=pangpangPost(a.href);
    return id?pangpangPost(b.href)===id:!pangpangPost(b.href)&&canonicalUrl(a.href)===canonicalUrl(b.href);
  } catch { return false; }
}
export type LinkReason = 'accepted_product'|'duplicate_product'|'non_product_link'|'invalid_url'|'policy_block'|'missing_title'|'ambiguous_container'|'excluded_category'|'not_baby_item'|'profile_category_mismatch'|'deferred_limit';
export type LinkOutcome = {index:number;reason:LinkReason;product_index?:number};
export type PangpangProduct = ParsedItem & {seller_name:string|null;locator:string;link_index:number|null};
export type PangpangPage = {version:string;detail:boolean;products:PangpangProduct[];outcomes:LinkOutcome[];links_encountered:number};
const clean=(s:string,max=1000)=>filterText(s.replace(/https?:\/\/[^\s<>"']+/gi,''),max).replace(/\s+/g,' ').trim();
const classes=(e:El)=> (e.attrs.class??'').split(/\s+/);
const allLinks=(e:El)=>[...(e.tag==='a'&&e.attrs.href?[e]:[]),...selectAll(e,'a[href]')];
function fields(scope:El,title:string,url:string,locator:string,linkIndex:number|null,now:Date):PangpangProduct {
  const category=selectAll(scope,'.text-category').map(textOf).map(s=>clean(s,100)).join(' ');
  const times=selectAll(scope,'time').filter(e=>/\d{1,2}\/\d{1,2}/.test(textOf(e)));
  // Cards use a span; details use sibling time elements within a schedule span.
  const scheduleEl=times[0]?.parent??selectAll(scope,'span').find(e=>!selectAll(e,'span').length&&/\d{1,2}\/\d{1,2}/.test(textOf(e)));
  const schedule=clean(scheduleEl?textOf(scheduleEl):'',120);
  const dates=extractDates(schedule.replace(/\s*\([월화수목금토일](?:요일)?\)/g,''),now);
  if(dates)dates.raw=schedule;
  const sellerLink=allLinks(scope).find(e=>{try{return /^\/account\/\d+$/.test(new URL(e.attrs.href,url).pathname);}catch{return false;}});
  const seller=clean(sellerLink?selectAll(sellerLink,'p').map(textOf)[0]??'':selectAll(scope,'p.truncate').map(textOf)[0]??'',100);
  const handle=/^[A-Za-z0-9._]{1,30}$/.test(seller)?seller.toLowerCase():null;
  return {source_url:url,title,text:[title,category,schedule,seller].filter(Boolean).join('\n'),category_text:category,
    price:null,dates,seller_handle:handle,seller_name:seller||null,seller_url:handle?`https://www.instagram.com/${handle}/`:null,locator,link_index:linkIndex};
}
// approve must validate the ORIGINAL resolved URL, then the canonical destination.
export function extractPangpang(html:string,pageUrl:string,now:Date,allowed:(url:string)=>boolean,budget?:ParseBudget):PangpangPage {
  const root=parseHtml(html,budget),anchors=selectAll(root,'a[href]');
  if (budget && anchors.length > 4096) throw new Error('preparation_limit');
  const result:PangpangPage={version:PANGPANG_VERSION,detail:!!pangpangPost(pageUrl),products:[],outcomes:[],links_encountered:anchors.length};
  const groups=new Map<string,{index:number;el:El}[]>();
  for(const [index,el] of anchors.entries()){
    let original:string;
    try{original=new URL(el.attrs.href,pageUrl).href;}catch{result.outcomes.push({index,reason:'invalid_url'});continue;}
    if(!pangpangPost(original)){result.outcomes.push({index,reason:'non_product_link'});continue;}
    let url:string;
    try{if(!pangpangQueryAllowed(new URL(original))||!allowed(original))throw new Error();url=canonicalUrl(original);if(!allowed(url))throw new Error();}
    catch{result.outcomes.push({index,reason:'policy_block'});continue;}
    const group=groups.get(url)??[];group.push({index,el});groups.set(url,group);
  }
  if(result.detail){
    const articles=selectAll(root,'article');
    if(allowed(pageUrl)&&articles.length===1){
      const scope=articles[0],headings=selectAll(scope,'h1,h2').filter(e=>!classes(e).includes('sr-only'));
      if(headings.length===1){const title=clean(textOf(headings[0]),200);if(title)result.products.push(fields(scope,title,canonicalUrl(pageUrl),'article',null,now));}
    }
    for(const links of groups.values())for(const {index} of links)result.outcomes.push({index,reason:'non_product_link'});
  }else for(const [url,links] of groups){
    const candidates=links.filter(({el})=>'data-feed-index' in el.attrs).map(({index,el})=>{
      let scope=el;
      // Include sibling fields only while the enclosing scope identifies one product.
      while(scope.parent&&!['#root','html','body','main','ul','ol'].includes(scope.parent.tag)){
        const ids=new Set(allLinks(scope.parent).map(a=>{try{return pangpangPost(new URL(a.attrs.href,pageUrl).href);}catch{return null;}}).filter(Boolean));
        if(ids.size!==1||allLinks(scope.parent).filter(a=>'data-feed-index' in a.attrs).length>1)break;
        scope=scope.parent;
      }
      const headings=selectAll(scope,'p.line-clamp-2,h1,h2').filter(e=>!classes(e).includes('sr-only'));
      if(headings.length>1)return {index,reason:'ambiguous_container' as const};
      const title=clean(headings[0]?textOf(headings[0]):'',200);
      return title?{index,product:fields(scope,title,url,`link[${index}]`,index,now)}:{index,reason:'missing_title' as const};
    });
    const complete=candidates.filter((c):c is {index:number;product:PangpangProduct}=>'product' in c&&!!c.product);
    const score=(p:PangpangProduct)=>Number(!!p.category_text)+Number(!!p.seller_name)+Number(!!p.dates);
    const best=complete.sort((a,b)=>score(b.product)-score(a.product))[0];
    if(best){
      const product_index=result.products.length;result.products.push(best.product);
      for(const {index} of links){
        const ambiguous=candidates.find(c=>c.index===index)?.reason==='ambiguous_container';
        result.outcomes.push(ambiguous?{index,reason:'ambiguous_container'}:{index,reason:index===best.index?'accepted_product':'duplicate_product',product_index});
      }
    }else for(const {index} of links)result.outcomes.push({index,reason:candidates.find(c=>c.index===index)?.reason??'missing_title'});
  }
  result.outcomes.sort((a,b)=>a.index-b.index);
  return result;
}
