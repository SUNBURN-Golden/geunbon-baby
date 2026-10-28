import type { AssertionInput } from '../../shared/collection-schema';
import { digest, stable } from './dedup';
import { axesOf, mergeConflict, normalizeAxis } from './merge-rules';
export const EVIDENCE_POLICY_VERSION='conflict-policy@4';
export const OFFER_FIELDS=['shipping_fee','group_buy_terms','clue_price'];
export type PolicyClaim=AssertionInput&{id?:string;url?:string;seller?:string;record_id?:string;target_ref?:string;withdrawn?:boolean;superseded_by?:string;unavailable_reason?:string};
export type Comparison='same_claim'|'coexists'|'different_scope'|'conflict'|'assessment_pending';
export function hasValue(value:unknown):boolean {
  if(value===null||value===undefined)return false;
  if(typeof value==='string')return !!value.trim()&&!/^(?:정보\s*없음|미확인|unknown|null|n\/a|원문 확인 필요)$/i.test(value.trim());
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.length>0&&value.some(hasValue);
  if(typeof value==='object')return Object.values(value).some(hasValue);
  return typeof value==='boolean';
}
export function money(value:unknown,field:string):{amount:number;currency:string}|undefined {
  const object=value&&typeof value==='object'?value as Record<string,unknown>:undefined;
  const raw=object?.amount??value;
  let amount: number|undefined;
  if(typeof raw==='number')amount=raw;
  else if(typeof raw==='string'){
    if(field==='shipping_fee'&&/^(무료|무료 배송|무료배송|free)$/i.test(raw.trim()))amount=0;
    else if(/^(?:KRW|₩)?\s*\d[\d,]*\s*(?:원|KRW)?$/i.test(raw.trim()))amount=Number(raw.replace(/[^\d]/g,''));
  }
  const currency=String(object?.currency??'KRW').toUpperCase();
  if(amount===undefined||!Number.isSafeInteger(amount)||amount<0||(field!=='shipping_fee'&&amount===0)||!/^KRW$/.test(currency))return;
  return {amount,currency};
}
export function validClaim(a:AssertionInput){
  const from=a.conditions?.effective_at,until=a.conditions?.effective_until;
  if([from,until].some(v=>v&&!Number.isFinite(Date.parse(v)))||from&&until&&Date.parse(from)>=Date.parse(until))return false;
  if(OFFER_FIELDS.includes(a.field)&&sellerIdentity(a as PolicyClaim).ambiguous)return false;
  if(['official_msrp','clue_price','shipping_fee'].includes(a.field)&&a.conditions?.currency&&a.conditions.currency!=='KRW')return false;
  if(!hasValue(a.value))return false;
  if(['official_msrp','clue_price','shipping_fee'].includes(a.field)&&!money(a.value,a.field))return false;
  if(a.field==='compatibility'&&!part(a))return false;
  if(a.field==='release_year'&&!normalizeAxis('release_year',a.value))return false;
  if(a.field==='generation'&&!normalizeAxis('generation',a.value))return false;
  return Object.entries(a.conditions??{}).every(([k,v])=>!['release_year','generation','bundle','market'].includes(k)||!!normalizeAxis(k,v));
}
export function requiredClaimValid(a:AssertionInput){return validClaim(a)&&(a.field!=='certifications'||a.conditions?.scheme==='KC'&&a.conditions?.market==='KR')&&(a.field!=='official_msrp'||a.msrp_explicit===true);}
export function scopeConditions(a:PolicyClaim){
  const c={...a.conditions};
  delete c.effective_at;delete c.effective_until;
  delete c.list_complete;
  if(OFFER_FIELDS.includes(a.field))delete c.seller;
  if(['official_msrp','clue_price','shipping_fee'].includes(a.field))c.currency??='KRW';
  return Object.fromEntries(Object.entries(c).map(([k,v])=>[k,v.trim().normalize('NFKC')]).sort(([a],[b])=>a.localeCompare(b)));
}
export function offerScope(a:PolicyClaim){
  const c=a.conditions??{};
  // Origin is a fallback boundary, never proof of a shared offer across documents.
  const seller=sellerIdentity(a).value;
  return {seller,channel:c.channel??'',offer:c.offer??(!seller?(a.url??a.record_id??'unknown'):'')};
}
export function sellerIdentity(a:PolicyClaim){
  const normalize=(v:string|undefined)=>v?.trim().normalize('NFKC').replace(/^(?:instagram:|@)/i,'').toLowerCase()??'';
  const stated=normalize(a.conditions?.seller),handle=normalize(a.seller);
  return {value:stated||handle,ambiguous:!!stated&&!!handle&&stated!==handle};
}
const part=(a:PolicyClaim)=>{
  if(a.value&&typeof a.value==='object'&&!Array.isArray(a.value)){
    const v=a.value as {id?:unknown;value?:unknown};
    if(typeof v.id==='string'&&typeof v.value==='boolean')return {id:v.id,compatible:v.value};
  }
};
export function compareClaims(a:PolicyClaim,b:PolicyClaim):Comparison {
  if(a.target_ref&&b.target_ref&&a.target_ref!==b.target_ref)return a.target_ref.startsWith('model:')&&b.target_ref.startsWith('model:')?'different_scope':'assessment_pending';
  if(a.field!==b.field)return 'different_scope';
  if(OFFER_FIELDS.includes(a.field)&&(sellerIdentity(a).ambiguous||sellerIdentity(b).ambiguous))return 'assessment_pending';
  if(mergeConflict(axesOf([a]),axesOf([b])))return 'different_scope';
  const ac=scopeConditions(a),bc=scopeConditions(b);
  for(const k of ['option','market','bundle','release_year','generation','channel','offer','price_kind','shipping_region','purchase_condition','unit'])if(ac[k]&&bc[k]&&ac[k]!==bc[k])return 'different_scope';
  if(OFFER_FIELDS.includes(a.field)){
    const as=offerScope(a),bs=offerScope(b);
    if(as.seller&&bs.seller&&as.seller!==bs.seller)return 'different_scope';
    if(stable(as)!==stable(bs))return 'assessment_pending';
  }
  const at=a.conditions?.effective_at,bt=b.conditions?.effective_at,ae=a.conditions?.effective_until,be=b.conditions?.effective_until;
  if([at,bt,ae,be].some(v=>v&&!Number.isFinite(Date.parse(v))))return 'assessment_pending';
  if(at&&be&&Date.parse(at)>Date.parse(be)||bt&&ae&&Date.parse(bt)>Date.parse(ae))return 'different_scope';
  if(!!at!==!!bt||!!ae!==!!be)return 'assessment_pending';
  if(stable(ac)!==stable(bc))return 'assessment_pending';
  if(!validClaim(a)||!validClaim(b))return 'assessment_pending';
  if(a.field==='compatibility'){
    const ap=part(a),bp=part(b);if(!ap||!bp)return 'assessment_pending';
    return ap.id!==bp.id?'coexists':ap.compatible===bp.compatible?'same_claim':'conflict';
  }
  const av=money(a.value,a.field),bv=money(b.value,b.field);
  if(stable(av??a.value)===stable(bv??b.value))return 'same_claim';
  if(a.field==='bundle_components'||['certifications','recalls'].includes(a.field)&&(Array.isArray(a.value)||Array.isArray(b.value))){
    const list=(v:unknown)=>Array.isArray(v)?v:typeof v==='string'?[v]:v&&typeof v==='object'?[v]:undefined;
    const al=list(a.value),bl=list(b.value);
    if(!al||!bl)return 'assessment_pending';
    const aset=new Set(al.map(stable)),bset=new Set(bl.map(stable));
    if(aset.size===bset.size&&[...aset].every(v=>bset.has(v)))return 'same_claim';
    if(a.conditions?.list_complete==='true'&&[...bset].some(v=>!aset.has(v))||b.conditions?.list_complete==='true'&&[...aset].some(v=>!bset.has(v)))return 'conflict';
    return 'coexists';
  }
  if(['certifications','recalls'].includes(a.field)){
    const aid=typeof a.value==='object'?(a.value as {id?:string}).id:a.field==='certifications'&&typeof a.value==='string'&&/^[A-Z0-9-]+$/.test(a.value)?a.value:undefined;
    const bid=typeof b.value==='object'?(b.value as {id?:string}).id:b.field==='certifications'&&typeof b.value==='string'&&/^[A-Z0-9-]+$/.test(b.value)?b.value:undefined;
    return aid&&bid?(aid===bid?'conflict':'coexists'):'assessment_pending';
  }
  return 'conflict';
}
// Updating one relation must not silently supersede other compatible parts.
export function claimIdentity(a:PolicyClaim){
  const id=part(a)?.id;
  if(a.field==='compatibility')return id?stable([a.field,id]):stable([a.field,a.value]);
  if(['bundle_components','certifications','recalls'].includes(a.field)){
    const v=a.value as {id?:unknown}|null;
    return stable([a.field,v&&typeof v==='object'&&!Array.isArray(v)&&v.id!==undefined?v.id:a.value]);
  }
  return a.field;
}
export function supersedes(a:PolicyClaim,b:PolicyClaim){
  return a.field===b.field&&stable(scopeConditions(a))===stable(scopeConditions(b))&&
    (!OFFER_FIELDS.includes(a.field)||stable(offerScope(a))===stable(offerScope(b)))&&
    stable([a.conditions?.effective_at,a.conditions?.effective_until])===stable([b.conditions?.effective_at,b.conditions?.effective_until])&&
    (claimIdentity(a)===claimIdentity(b)||a.conditions?.list_complete==='true'&&['bundle_components','compatibility','certifications','recalls'].includes(a.field));
}

export type Resolution={id:string;assertions:string[];resolved:boolean;selected?:string;policy_version?:string;input_digest?:string};
export function normalizeClaim(a:PolicyClaim){return {...a,conditions:{...scopeConditions(a),...(OFFER_FIELDS.includes(a.field)?offerScope(a):{})},identity:claimIdentity(a)};}
export function evaluateConflictSet(evidence:PolicyClaim[],resolutions:Resolution[],asOf:number){
  const excluded=evidence.flatMap(a=>{
    const reason=a.withdrawn?'withdrawn':a.superseded_by?'superseded':a.unavailable_reason??(a.conditions?.effective_until&&Date.parse(a.conditions.effective_until)<=asOf?'effective_period_expired':a.conditions?.effective_at&&Date.parse(a.conditions.effective_at)>asOf?'effective_period_future':null);
    return reason?[{id:a.id,reason}]:[];
  });
  const excludedIds=new Set(excluded.map(e=>e.id));
  const active=evidence.filter(a=>!excludedIds.has(a.id));
  const pairs=comparisons(active).map(p=>({...p,assertions:[p.a.id!,p.b.id!].sort()}));
  const input=digest([EVIDENCE_POLICY_VERSION,active.map(normalizeClaim).sort((a,b)=>stable(a).localeCompare(stable(b)))]);
  const evaluated=pairs.map(p=>{
    const resolution=resolutions.find(r=>r.resolved&&r.policy_version===EVIDENCE_POLICY_VERSION&&r.input_digest===input&&stable([...r.assertions].sort())===stable(p.assertions)&&p.assertions.includes(r.selected??''));
    return {...p,resolution:p.result==='conflict'?resolution:undefined};
  });
  const activeIds=new Set(active.map(a=>a.id));
  const rejectedIds=new Set(evaluated.flatMap(p=>p.resolution?p.assertions.filter(id=>id!==p.resolution!.selected):[]));
  // Losing the selected source (including expiry) never endorses its rejected rival.
  const reopened=resolutions.filter(r=>r.resolved&&r.policy_version===EVIDENCE_POLICY_VERSION&&r.selected&&!activeIds.has(r.selected)&&r.assertions.some(id=>activeIds.has(id)&&!rejectedIds.has(id)));
  return {input_digest:input,pairs:evaluated,excluded,reopened,pending:active.some(a=>!validClaim(a))||evaluated.some(p=>p.result==='assessment_pending'),next_boundary:Math.min(Infinity,...evidence.filter(a=>!a.withdrawn&&!a.superseded_by).flatMap(a=>[a.conditions?.effective_at,a.conditions?.effective_until].flatMap(v=>v&&Date.parse(v)>asOf?[Date.parse(v)]:[])))};
}
export function comparisons(evidence:PolicyClaim[]){
  const active=evidence.filter(a=>!a.withdrawn&&!a.superseded_by),out:{a:PolicyClaim;b:PolicyClaim;result:Comparison}[]=[];
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)if(active[i].field===active[j].field)out.push({a:active[i],b:active[j],result:compareClaims(active[i],active[j])});
  return out;
}
