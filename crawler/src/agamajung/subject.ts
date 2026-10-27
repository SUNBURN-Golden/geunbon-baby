import type { AssertionInput, ClipPayload } from '../../../shared/collection-schema';
import { stable } from '../dedup';
export function normalizedConditions(field:string,conditions:Record<string,string>={},seller=''){
  const out={...conditions};if(['official_msrp','clue_price'].includes(field))out.currency??='KRW';
  if(['clue_price','group_buy_terms'].includes(field)&&seller)out.seller=seller;
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v.trim().normalize('NFKC')]));
}
export const conditionsKey=(a:AssertionInput,seller='')=>stable(normalizedConditions(a.field,a.conditions,seller));
export const subjectRef=(p:ClipPayload,url:string)=>p.target_model_id??`doc:${url}`;
// The ID has no locator column: rank all claims in a normalized field/condition bucket, including different locators.
export function claimSlots(assertions:AssertionInput[]){const counts=new Map<string,number>();return assertions.map(a=>{const k=stable([a.field,conditionsKey(a)]),n=counts.get(k)??0;counts.set(k,n+1);return n;});}
