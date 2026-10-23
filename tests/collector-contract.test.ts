import { expect, test } from 'vitest';
import { aggregateCollectionStatus, parseSnapshot } from '../shared/collection-status';
import type { CollectionRecord, Method } from '../shared/collection-schema';
import { config } from '../crawler/src/source-policy';
import { fixture, source, intake, price, expected, ready } from './helpers/collector';
test('empty status has five zeros; unknown statuses and missing/extra representatives fail',()=>{
 expect(aggregateCollectionStatus([])).toMatchObject({total:0,unique:0,groups:0,counts:{discovered:0,source_check_needed:0,dedup_excluded:0,verified_waiting:0,ready_to_publish:0}});
 const make=(status:string)=>({dedup_group_id:'fixture',verification_status:status} as CollectionRecord);
 expect(()=>aggregateCollectionStatus([make('unknown')])).toThrow('unknown_status');expect(()=>aggregateCollectionStatus([make('dedup_excluded')])).toThrow('representative_invariant');expect(()=>aggregateCollectionStatus([make('discovered'),make('verified_waiting')])).toThrow('representative_invariant');
});
test.each<Method>(['auto_discovery','browser_extract','manual_clip'])('%s preserves common metadata and source evidence without publishing',method=>{
 const f=fixture({...config,sources:[{...source,browser:true}]});try{const receipt=intake(f.store,source.origin+'/'+method,price(),method);const record=f.store.get<CollectionRecord>('collection_records',receipt.record_id)!;expect(record).toMatchObject({source:'fixture',collection_method:method,target_model_id:'model-1',verification_status:'source_check_needed',schema_version:1,conflict_detected:false});expect(record.evidence_locator).toContain('main .msrp');expect(record.extracted_facts.official_msrp).toHaveLength(1);expect(parseSnapshot(f.store.report())).not.toBeNull();}finally{f.close();}
});
test('linked nonrepresentative observations invalidate every dependent review scope',()=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',price()),b=intake(f.store,source.origin+'/b',{...price(),target_model_id:'other-generation'});
  const ga=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id,gb=f.store.get<CollectionRecord>('collection_records',b.record_id)!.dedup_group_id;
  const assertion=f.store.scope(ga).evidence[0];f.store.changeGroup(gb,'link',{assertion_id:assertion.id},expected(f.store,gb));ready(f.store,ga);ready(f.store,gb);
  f.store.changeGroup(ga,'withdraw',{assertion_id:assertion.id},expected(f.store,ga));expect(f.store.scope(gb).group.ready_evidence_version).toBeNull();expect(f.store.scope(gb).group.verified_evidence_version).toBeNull();
 }finally{f.close();}
});
