import { extractFacts } from '../../../shared/fact-extract';
import type { AssertionInput } from '../../../shared/collection-schema';
import { filterText } from '../../../shared/privacy-rules';
export function extractRules(text:string,locator:string):AssertionInput[]{
  return text.split(/[\r\n]+/).flatMap((line,index)=>{
    let clean=filterText(line,300);if(!clean)return [];
    const conditions:Record<string,string>={};
    const prefix=clean.match(/^(본체|세트|body|set)\s*\|\s*/i);
    if(prefix){conditions.bundle=/본체|body/i.test(prefix[1])?'body':'set';clean=clean.slice(prefix[0].length);}
    const market=clean.match(/^(한국판|해외판|KR|overseas)\s*\|\s*/i);
    if(market){conditions.market=/한국판|^KR$/i.test(market[1])?'KR':'overseas';clean=clean.slice(market[0].length);}
    const where=`${locator}:line:${index+1}`;
    const rules:[RegExp,AssertionInput['field']][]=[[/^(?:배송비|shipping fee)\s*[:：]\s*(.+)$/i,'shipping_fee'],[/^(?:호환성|호환|compatibility)\s*[:：]\s*(.+)$/i,'compatibility'],[/^(?:출시 연식|출시연도|release year)\s*[:：]\s*((?:19|20)\d{2})년?$/i,'release_year'],[/^(?:KC 인증|KC 인증번호)\s*[:：]\s*([A-Z0-9-]+)$/i,'certifications']];
    for(const [re,field] of rules){const m=clean.match(re);if(m)return [{field,value:m[1],quote:clean,locator:where,conditions:{...conditions,...(field==='certifications'?{scheme:'KC'}:{})}}];}
    return extractFacts(clean,where).map(a=>({...a,conditions:{...a.conditions,...conditions}}));
  }).slice(0,30);
}
