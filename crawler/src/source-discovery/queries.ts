import type { Profile } from '../agamajung/profile';
import { cleanText } from '../discovery/document';
import { digest } from '../../engine/util';
import { discoveryConditions } from './store';
import { normalizedConditions } from '../agamajung/subject';
import type { DiscoveryConfig } from './config';
import type { SearchQuery, Subject } from './types';
export const PLANNER_VERSION='source-planner@2';
export function query(provider:string,input:Omit<SearchQuery,'id'|'planner_version'>):SearchQuery {
  const q={...input,text:cleanText(input.text,300),conditions:discoveryConditions(input.conditions),planner_version:PLANNER_VERSION};
  return {...q,id:digest(['agamajung',provider,q.text,q.region,q.language,q.year,q.subject_ref,q.conditions,q.planner_version])};
}
export function resolvedYears(config:DiscoveryConfig,at:number){const year=new Date(at+9*3600000).getUTCFullYear();return config.years.map(y=>y==='current'?String(year):y);}
export function combinationCount(c:DiscoveryConfig,p:Profile){return p.categories.length*c.regions.length*c.languages.length*c.years.length*c.events.length;}
// Mixed-radix cursor: never constructs the Cartesian product in memory.
export function combinationAt(index:number,c:DiscoveryConfig,p:Profile,years:string[],provider:string):SearchQuery|undefined {
  if(index<0||index>=Math.min(c.max_queries,combinationCount(c,p)))return;
  const take=(n:number)=>{const v=index%n;index=Math.floor(index/n);return v;};
  const event=c.events[take(c.events.length)],year=years[take(years.length)],language=c.languages[take(c.languages.length)],region=c.regions[take(c.regions.length)],category=p.categories[take(p.categories.length)];
  const lang=language as 'ko'|'en';
  return query(provider,{text:[category[lang][0],region,language,year,event[lang]].join(' '),region,language,year,category:category.id,event:event[lang],subject_ref:'profile:agamajung',conditions:{},kind:'combination'});
}
export function feedbackQueries(provider:string,s:Subject,p:Profile,known:{field:string;subject_ref:string;conditions:Record<string,string>}[]=[]) {
  const base={region:'',language:'',year:s.release_year??'',category:'',event:'',subject_ref:s.subject_ref,conditions:s.conditions};
  const tokens=[s.brand,s.product_line,s.model_number,s.release_year,s.option,s.seller,s.compatible_part,s.event].filter((v):v is string=>!!v);
  const out:SearchQuery[]=[];
  // Prefixes enforce the brand → line → model → year/options → seller → parts order.
  for(let i=1;i<=tokens.length;i++)out.push(query(provider,{...base,text:tokens.slice(0,i).join(' '),kind:'entity'}));
  if(s.model_number){
    for(const required of p.required_fields){
      // Unknown market stays unknown; KC reverse search requires explicit KR applicability.
      if(required.field==='certifications'&&s.conditions.market!=='KR')continue;
      const conditions=discoveryConditions(normalizedConditions(required.field,{...s.conditions,...('conditions' in required?required.conditions:{})}));
      const present=known.some(f=>f.subject_ref===s.subject_ref&&f.field===required.field&&JSON.stringify(discoveryConditions(normalizedConditions(f.field,f.conditions)))===JSON.stringify(conditions));
      if(!present)out.push(query(provider,{...base,conditions,text:[s.brand,s.product_line,s.model_number,s.release_year??s.conditions.release_year,s.conditions.generation,s.conditions.bundle,s.conditions.market,s.option??s.conditions.option,s.seller??s.conditions.seller,s.conditions.channel,s.conditions.offer,required.field==='certifications'?'KC 인증번호':required.ko].filter(Boolean).join(' '),kind:'missing_field'}));
    }
  }
  return [...new Map(out.filter(q=>q.text).map(q=>[q.id,q])).values()];
}
