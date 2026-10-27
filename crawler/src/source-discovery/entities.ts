import { digest } from '../../engine/util';
import { cleanText } from '../discovery/document';
import { discoveryConditions } from './store';
import type { Subject } from './types';
export type ExistingFact={subject_ref:string;field:string;conditions_key:string;data:string;locator?:string};
const fields:Record<string,keyof Subject>={'브랜드':'brand','brand':'brand','제품 라인':'product_line','product line':'product_line','모델번호':'model_number','model number':'model_number','연식':'release_year','model year':'release_year','옵션':'option','option':'option','판매처':'seller','seller':'seller','호환 부품':'compatible_part','compatible part':'compatible_part','행사명':'event','event':'event'};
export function explicitSubjects(text:string,sourceScope:string):Subject[] {
  const subjects:Subject[]=[];let current:Subject={subject_ref:'',conditions:{}};
  const flush=()=>{if(Object.keys(current).length>2){current.subject_ref=`entity:${digest([sourceScope,current])}`;subjects.push(current);}current={subject_ref:'',conditions:{}};};
  for(const line of text.split('\n')){
    const match=/^\s*([^:：]{1,40})\s*[:：]\s*(.{1,100})$/.exec(line);if(!match)continue;
    const key=match[1].trim().toLowerCase(),value=cleanText(match[2],100);if(!value||value.includes('[redacted]'))continue;
    if(['market','시장','bundle','구성','generation','세대'].includes(key)){
      const axis=({시장:'market',구성:'bundle',세대:'generation'} as Record<string,string>)[key]??key;current.conditions[axis]=value;continue;
    }
    const field=fields[key];if(!field)continue;
    if(field==='model_number'&&current.model_number)flush();
    if(field==='release_year'&&!/^20\d{2}$/.test(value))continue;
    Object.assign(current,{[field]:value});if(field==='release_year')current.conditions.release_year=value;
  }
  flush();return subjects;
}
export function subjectsFromFacts(facts:ExistingFact[],sourceScope:string):Subject[] {
  const groups=new Map<string,Subject>();
  for(const f of facts){
    const conditions=discoveryConditions(JSON.parse(f.conditions_key||'{}')),key=digest([f.subject_ref,conditions]);
    const s=groups.get(key)??{subject_ref:f.subject_ref.startsWith('doc:')?`entity:${digest([sourceScope,f.subject_ref])}`:f.subject_ref,conditions};
    const a=JSON.parse(f.data).assertion as {value?:unknown}|undefined;
    if(typeof a?.value==='string'){
      if(f.field==='brand')s.brand=cleanText(a.value,100);
      if(f.field==='model')s.model_number=cleanText(a.value,100);
      if(f.field==='release_year')s.release_year=cleanText(a.value,100);
    }
    groups.set(key,s);
  }
  return [...groups.values()];
}
