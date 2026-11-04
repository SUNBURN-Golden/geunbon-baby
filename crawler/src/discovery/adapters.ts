import { parseHtml, selectAll, textOf } from '../../lib/external/parse';
import { boundedJson, type ParseBudget } from '../../lib/external/parse-budget';
import { extractRawDocument } from './document';
import { canonicalUrl } from '../../../shared/privacy-rules';
export type Found = {url:string;title?:string;recall?:{id:string;name:string;date:string}};
const decode=(s:string)=>s.replace(/&amp;/g,'&').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim();
function safe(raw:string,base:string):string|null {try{return canonicalUrl(new URL(decode(raw),base).href);}catch{return null;}}
export function discoverLinks(body:string,base:string,adapter:'rss'|'sitemap'|'links'|'cpsc',budget?:ParseBudget):Found[] {
  budget?.preflight(body, !body.trim().startsWith('<') && adapter==='cpsc');
  if(adapter==='cpsc'){
    if(body.trim().startsWith('<')){
      if(budget){
        const root=parseHtml(body,budget),recalls=selectAll(root,'recall');
        if(recalls.length>500)throw new Error('preparation_limit');
        return recalls.flatMap(el=>{
          const tag=(name:string)=>selectAll(el,name).map(textOf).join(' ').trim();
          const url=safe(tag('url'),base),id=tag('recallid');
          return url&&/^\d+$/.test(id)?[{url,title:tag('title'),recall:{id,name:tag('name')||tag('title'),date:tag('recalldate')}}]:[];
        });
      }
      return [...body.matchAll(/<Recall(?:\s[^>]*)?>([\s\S]*?)<\/Recall>/gi)].slice(0,500).flatMap(m=>{
        const tag=(name:string)=>decode(m[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]??'');
        const url=safe(tag('URL'),base),id=tag('RecallID');return url&&/^\d+$/.test(id)?[{url,title:tag('Title'),recall:{id,name:tag('Name')||tag('Title'),date:tag('RecallDate')}}]:[];
      });
    }
    const rows: {RecallID:number;URL:string;Title:string;RecallDate:string;Products?:{Name:string}[]}[]=(budget?boundedJson(body,budget):JSON.parse(body)) as typeof rows;
    if(!Array.isArray(rows))throw new Error('cpsc_schema');
    if(budget && (rows.length>500 || rows.some(r=>!r || typeof r.URL!=='string' || typeof r.Title!=='string' || typeof r.RecallDate!=='string' || (r.Products && (!Array.isArray(r.Products) || r.Products.length>100 || r.Products.some(p=>!p || typeof p.Name!=='string'))))))throw new Error('preparation_schema');
    return rows.slice(0,500).flatMap(r=>{const url=safe(r.URL,base);return url&&Number.isSafeInteger(r.RecallID)?[{url,title:r.Title,recall:{id:String(r.RecallID),name:r.Products?.map(p=>p.Name).join(', ')??r.Title,date:r.RecallDate}}]:[];});
  }
  return extractRawDocument(body,base,adapter,'',budget).links.flatMap(link=>{const url=safe(link.url,base);return url?[{url}]:[];});
}
