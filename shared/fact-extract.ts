import type { AssertionInput, FactField } from './collection-schema';
import { filterText } from './privacy-rules';
// Labelled facts and a single explicit KRW amount; private prose is filtered first.
export function extractFacts(text:string,locator:string):AssertionInput[]{
  const labels:[RegExp,FactField][]=[[/^(?:브랜드|brand)\s*[:：]\s*(.+)$/i,'brand'],[/^(?:모델|model)\s*[:：]\s*(.+)$/i,'model'],[/^(?:세대|generation)\s*[:：]\s*(.+)$/i,'generation'],[/^(?:구성품|bundle)\s*[:：]\s*(.+)$/i,'bundle_components'],[/^(?:권장소비자가|MSRP)\s*[:：]\s*(.+)$/i,'official_msrp'],[/^(?:가격|공식가|판매가|공구가|price)\s*[:：]\s*(.+)$/i,'clue_price'],[/^(?:공구 조건|공구조건|기간|마감)\s*[:：]\s*(.+)$/i,'group_buy_terms'],[/^(?:설명서|manual)\s*[:：]\s*(https:\/\/\S+)$/i,'manual_url'],[/^(?:인증|certification)\s*[:：]\s*(.+)$/i,'certifications'],[/^(?:리콜|recall)\s*[:：]\s*(.+)$/i,'recalls']];
  return text.split(/[\n\r]+/).flatMap<AssertionInput>(line=>{
    const clean=filterText(line,300);if(!clean)return [];
    for(const [pattern,field] of labels){const match=clean.match(pattern);if(match)return [{field,value:match[1],quote:clean,locator,msrp_explicit:field==='official_msrp'}];}
    // A manual selection commonly has prose rather than field labels. An explicit
    // amount is a clue only; ambiguous ranges/multiple amounts remain for review.
    const amounts=[...clean.matchAll(/(?<![\d,.])([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\s*원/g)];
    if(amounts.length===1)return [{field:'clue_price' as FactField,value:Number(amounts[0][1].replaceAll(',','')),quote:clean,locator,msrp_explicit:false}];
    return [];
  }).slice(0,30);
}
