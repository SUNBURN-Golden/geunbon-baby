import { extractFacts } from '../../../shared/fact-extract';
import type { AssertionInput } from '../../../shared/collection-schema';
import { normalizeAxis } from '../merge-rules';
import { filterText } from '../../../shared/privacy-rules';
export function extractRules(text:string,locator:string,limit=30):AssertionInput[]{
  return text.split(/[\r\n]+/).flatMap<AssertionInput>((line,index)=>{
    let clean=filterText(line,300);if(!clean)return [];
    const conditions:Record<string,string>={};
    for(let n=0;n<4;n++){
      const prefix=clean.match(/^(본체|세트|body|set|한국판|해외판|KR|overseas|(?:연식|release year)\s+(?:19|20)\d{2}|(?:세대|generation)\s+[\p{L}\p{N} ._-]{1,60})\s*\|\s*/iu);
      if(!prefix)break;
      const token=prefix[1].trim();
      if(/^(?:본체|세트|body|set)$/i.test(token))conditions.bundle=/본체|body/i.test(token)?'body':'set';
      else if(/^(?:한국판|해외판|KR|overseas)$/i.test(token))conditions.market=/한국판|^KR$/i.test(token)?'KR':'overseas';
      else {const axis=/^(연식|release year)/i.test(token)?'release_year':'generation',value=token.replace(/^(?:연식|release year|세대|generation)\s+/i,'');if(normalizeAxis(axis,value))conditions[axis]=value;}
      clean=clean.slice(prefix[0].length);
    }
    const where=`${locator}:line:${index+1}`;
    const compatibility=clean.match(/^(?:호환성|호환|compatibility)\s*[:：]\s*([^|]{1,80})\s*\|\s*(호환|비호환|compatible|incompatible)$/i);
    if(compatibility)return [{field:'compatibility',value:{id:compatibility[1].trim(),value:/^(호환|compatible)$/i.test(compatibility[2])},quote:clean,locator:where,conditions}];
    const rules:[RegExp,AssertionInput['field']][]=[[/^(?:배송비|shipping fee)\s*[:：]\s*(.+)$/i,'shipping_fee'],[/^(?:호환성|호환|compatibility)\s*[:：]\s*(.+)$/i,'compatibility'],[/^(?:출시 연식|출시연도|release year)\s*[:：]\s*((?:19|20)\d{2})년?$/i,'release_year'],[/^(?:KC 인증|KC 인증번호)\s*[:：]\s*([A-Z0-9-]+)$/i,'certifications']];
    for(const [re,field] of rules){const m=clean.match(re);if(m)return [{field,value:m[1],quote:clean,locator:where,conditions:{...conditions,...(field==='certifications'?{scheme:'KC'}:{})}}];}
    return extractFacts(clean,where).map(a=>({...a,conditions:{...a.conditions,...conditions}}));
  }).slice(0,limit);
}

// Field-bearing prose is a diagnostic signal only; it never supplies a value.
const fieldCues:[RegExp,AssertionInput['field']][]=[
  [/배송(?:비|료)|\bshipping\s*(?:fee|cost)\b/i,'shipping_fee'],
  [/공구\s*(?:조건|기간|마감)|공동\s*구매\s*조건|\bgroup[ -]?buy\s*terms\b/i,'group_buy_terms'],
  [/권장\s*소비자가|공식가|정가|\bMSRP\b/i,'official_msrp'],
  [/구성품|\bbundle\b/i,'bundle_components'],
  [/호환|\bcompatib(?:ility|le)\b/i,'compatibility'],
  [/KC\s*인증|인증번호|\bcertification\b/i,'certifications'],
  [/출시\s*(?:연식|연도)|\brelease\s*year\b/i,'release_year']
];
// Diagnostics share the exact extraction rules. A heading alone is never a value candidate.
export function ruleDiagnostics(text:string,locator:string){
  const candidates=extractRules(text,locator,Number.MAX_SAFE_INTEGER);
  const rejected=text.split(/[\r\n]+/).flatMap((line,index)=>{
    // Inspect the whole sanitized line; only the stored diagnostic quote is bounded.
    const inspected=filterText(line,Number.MAX_SAFE_INTEGER),quote=inspected.slice(0,300),where=`${locator}:line:${index+1}`;
    return fieldCues.filter(([cue,field])=>cue.test(inspected)&&!candidates.some(a=>a.field===field&&a.locator===where)).map(([,field])=>({field,quote,locator:where,rejected_reason:'unsupported_field_syntax'}));
  });
  return {version:'rule-diagnostics@3',candidates:candidates.map((assertion,index)=>({assertion,rejected_reason:index>=30?'assertion_limit':null})),rejected};
}
