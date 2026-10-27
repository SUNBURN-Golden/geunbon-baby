import { expect, test } from 'vitest';
import { axesOf, mergeConflict } from '../crawler/src/merge-rules';
import { dedupKey } from '../crawler/src/dedup';
import type { ClipPayload, CollectionRecord } from '../shared/collection-schema';
import type { Group } from '../crawler/src/store';
import { expected, fixture, intake, price, source } from './helpers/collector';
const group=(f:ReturnType<typeof fixture>,id:string)=>f.store.get<CollectionRecord>('collection_records',id)!.dedup_group_id;
const payload=(axis:string,value:string):ClipPayload=>axis==='release_year'||axis==='generation'?{...price(),assertions:[...price().assertions,{field:axis,value,quote:`example_only ${axis} ${value}`,locator:'main'}]}:{...price(),assertions:price().assertions.map(a=>({...a,conditions:{...a.conditions,[axis]:value}}))};
const variations=[['release_year','2025','2026'],['generation','one','two'],['bundle','body','set'],['market','KR','overseas']];
test.each(variations)('%s axes guard family keys, manual merge and linked evidence', (axis,left,right)=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',payload(axis,left)),b=intake(f.store,source.origin+'/b',payload(axis,right)),ga=group(f,a.record_id),gb=group(f,b.record_id);expect(ga).not.toBe(gb);
  expect(()=>f.store.changeGroup(ga,'merge',{other_group:gb,other_expected:expected(f.store,gb)},expected(f.store,ga))).toThrow(expect.objectContaining({code:'merge_forbidden',status:409}));
  const evidence=f.store.scope(gb).evidence.find(e=>e.field===(axis==='release_year'||axis==='generation'?axis:'official_msrp'))!;
  expect(()=>f.store.changeGroup(ga,'link',{assertion_id:evidence.id},expected(f.store,ga))).toThrow(expect.objectContaining({code:'merge_forbidden',status:409}));
 }finally{f.close();}
});
test.each(variations)('new %s evidence invalidates a former manual merge override and splits with audit event', (axis,left,right)=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',payload(axis,left));
  const b=intake(f.store,source.origin+'/b',{target_model_id:null,assertions:[{field:'model',value:'Example',quote:'example_only model',locator:'main'}]});
  const ga=group(f,a.record_id),gb=group(f,b.record_id);f.store.changeGroup(ga,'merge',{other_group:gb,other_expected:expected(f.store,gb)},expected(f.store,ga));
  intake(f.store,source.origin+'/b',payload(axis,right));expect(group(f,b.record_id)).not.toBe(group(f,a.record_id));expect(f.store.get('collector_meta',`dedup_override:${b.record_id}`)).toBeUndefined();
  expect(f.store.list<{decision:string}>('review_events').some(x=>x.decision==='merge_forbidden_split')).toBe(true);expect(f.store.report().total).toBe(2);
 }finally{f.close();}
});
test.each(variations)('%s rejects conflicting alias and document_origin candidates', (axis,left,right)=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',payload(axis,left)),ga=group(f,a.record_id),g=f.store.get<Group>('dedup_groups',ga)!;
  g.aliases=[dedupKey(source.origin+'/b',payload(axis,right))];f.store.transaction(()=>f.store.put('dedup_groups',ga,g));
  const b=intake(f.store,source.origin+'/b',payload(axis,right));expect(group(f,b.record_id)).not.toBe(ga);
  const c=intake(f.store,source.origin+'/c',{...payload(axis,right),target_model_id:null,document_origin:source.origin+'/a'});expect(group(f,c.record_id)).not.toBe(ga);
 }finally{f.close();}
});
test('unknown family key is unchanged, unknown axes allow explicit linking, and inactive evidence is ignored',()=>{
 expect(dedupKey(source.origin+'/a',{target_model_id:'model-1',assertions:[]})).toBe('family:stokke:tripp-trapp:current');
 expect(mergeConflict(axesOf([]),axesOf(payload('bundle','set').assertions))).toBe(false);
 expect(axesOf([{...payload('release_year','2025').assertions.at(-1)!,withdrawn:true}])).toEqual({});
});
test('dedup audit reports existing invalid groups, then apply splits without deleting records',()=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',payload('release_year','2025')),b=intake(f.store,source.origin+'/b',payload('release_year','2026')),ga=group(f,a.record_id),gb=group(f,b.record_id);
  // Simulate a historical grouping that predates these guards.
  f.store.transaction(()=>{
   const r=f.store.get<CollectionRecord>('collection_records',b.record_id)!;r.dedup_group_id=ga;f.store.db.prepare('UPDATE collection_records SET group_id=?,data=? WHERE id=?').run(ga,JSON.stringify(r),r.id);
   const g=f.store.get<Group>('dedup_groups',gb)!;g.retired=true;f.store.put('dedup_groups',gb,g);
  });
  expect(f.store.dedupAudit()).toHaveLength(1);expect(group(f,b.record_id)).toBe(ga);expect(f.store.dedupAudit({apply:true})).toHaveLength(1);expect(group(f,b.record_id)).not.toBe(group(f,a.record_id));expect(f.store.dedupAudit()).toEqual([]);expect(f.store.report().total).toBe(2);
 }finally{f.close();}
});
