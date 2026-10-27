import { AGAMAJUNG_LABELS } from './vocab';
export type LabelId=keyof typeof AGAMAJUNG_LABELS;
const rules:Record<LabelId,RegExp>={spec:/사양|브랜드|모델|유모차|카시트|바운서|하이체어|아기띠|specification|stroller|car seat|bouncer/i,manual:/설명서|manual|사용설명/i,compatibility:/호환|compatib/i,offer:/공구|판매가|배송비|판매제안|group.buy|shipping fee/i,recall:/리콜|recall/i,launch:/출시|연식|release year|launch/i};
export function labelRules(text:string){const labels=(Object.keys(rules) as LabelId[]).filter(k=>rules[k].test(text));return {labels,status:labels.length?'labeled' as const:'ambiguous' as const};}
