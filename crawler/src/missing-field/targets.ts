import type { CollectionRecord } from '../../../shared/collection-schema';
import type { CollectorStore } from '../store';
import { axesOf } from '../merge-rules';
import { digest, stable } from '../dedup';
import { normalizedConditions } from '../agamajung/subject';
import { loadProfile } from '../agamajung/profile';
import { REQUIRED_FIELDS } from '../agamajung/vocab';
import { scopeConditions, offerScope, OFFER_FIELDS } from '../evidence-policy';
import type { Slot } from './types';
export const SLOT_SCHEMA_VERSION='required-slot@1';
export function enumerateSlots(store:CollectorStore):Slot[]{
  const slots=new Map<string,Slot>(),profile=loadProfile();
  for(const r of store.list<CollectionRecord>('collection_records')){
    if(!store.recordIdentityCurrent(r))continue;
    const evidence=store.evidence(r.dedup_group_id).filter(e=>e.record_id===r.id&&!e.withdrawn&&!e.superseded_by),axes=axesOf(evidence);
    const base=Object.fromEntries(Object.entries(axes).filter(([,v])=>v.length===1).map(([k,v])=>[k,v[0]]));
    const target=r.target_model_id?`model:${r.target_model_id}:${digest(base)}`:`document:${r.id}`;
    // Discover offers across all offer fields before expanding their required fields.
    // Currency and price kind describe a claim, not an offer's identity.
    const offers=evidence.filter(e=>OFFER_FIELDS.includes(e.field)).map(e=>({
      ...base,...Object.fromEntries(Object.entries(scopeConditions(e)).filter(([k])=>!['currency','price_kind'].includes(k))),
      ...offerScope(e),...(e.conditions?.effective_at?{effective_at:e.conditions.effective_at}:{}),...(e.conditions?.effective_until?{effective_until:e.conditions.effective_until}:{})
    }));
    if(!offers.length)offers.push({...base,seller:'',channel:'',offer:r.url});
    const options=[...new Set(evidence.flatMap(e=>e.conditions?.option?[e.conditions.option]:[]))];
    const models=options.length?options.map(option=>({...base,option})):[base];
    for(const required of profile.required_fields){
      const field=required.field as typeof REQUIRED_FIELDS[number];
      const claims=evidence.filter(e=>e.field===field),offer=required.scope==='offer';
      const variants=offer?offers:models.flatMap(model=>{
        const applicable=claims.filter(e=>!e.conditions?.option||e.conditions.option===model.option);
        return applicable.length?applicable.map(e=>({...model,...scopeConditions(e),...(e.conditions?.effective_at?{effective_at:e.conditions.effective_at}:{}),...(e.conditions?.effective_until?{effective_until:e.conditions.effective_until}:{})})):[model];
      });
      for(const c of variants){
        const conditions=normalizedConditions(field,{...c,...(field==='certifications'?{scheme:'KC'}:{})});
        const id=digest([SLOT_SCHEMA_VERSION,target,field,conditions]);
        const slot=slots.get(id)??{id,target_ref:target,field,conditions,record_ids:[],kind:offer?'offer':'model'};
        slot.record_ids=[...new Set([...slot.record_ids,r.id])].sort();slots.set(id,slot);
      }
    }
  }
  return [...slots.values()].sort((a,b)=>stable(a).localeCompare(stable(b)));
}
