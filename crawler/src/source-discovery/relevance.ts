import type { Profile } from '../agamajung/profile';
import type { SearchQuery, Subject } from './types';
export function relevance(text:string,p:Profile,context:{query?:SearchQuery;subject?:Subject;approved?:boolean;identity?:string}={}) {
  const t=text.normalize('NFKC').toLowerCase(),has=(v:string|undefined)=>!!v&&t.includes(v.toLowerCase());
  const q=context.query,s=context.subject;
  const signals={brand_model:has(s?.brand)||has(s?.model_number)?30:0,category:p.categories.some(c=>[...c.ko,...c.en].some(has))?25:0,locale:has(q?.region)||has(q?.language)||/[가-힣]/.test(t)?15:0,event_year:has(q?.year)||has(q?.event)||/공구|신제품|리콜|recall|new release|20\d{2}/i.test(t)?15:0,approved:context.approved?15:0};
  const excluded=p.excluded_keywords.some(has)?'excluded_category':context.identity&&context.identity!=='preserved'?'identity_loss':undefined;
  // A different explicit model marker is an expansion veto, never a merge hint.
  const marker=/(?:모델번호|model number)\s*[:：]\s*([^\s<]+)/i.exec(text)?.[1];
  const reason=excluded??(s?.model_number&&marker&&marker!==s.model_number?'model_mismatch':undefined);
  return {score:Object.values(signals).reduce((a,b)=>a+b,0),signals,reason,version:'relevance@1'};
}
