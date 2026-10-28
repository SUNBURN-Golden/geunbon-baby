import { expect, test } from 'vitest';
import { engineFixture } from './helpers/engine';
import { intake, expected, ready } from './helpers/collector';
import type { CollectionRecord } from '../shared/collection-schema';
import { MissingFieldRunner } from '../crawler/src/missing-field/runner';
import { enumerateSlots } from '../crawler/src/missing-field/targets';
import { evaluateSlot, inputDigest } from '../crawler/src/missing-field/evaluate';
import { compareClaims, EVIDENCE_POLICY_VERSION } from '../crawler/src/conflict-policy';
import { digest } from '../crawler/src/dedup';

async function collect(f:ReturnType<typeof engineFixture>,at:string){const id=f.pipeline.start({kind:'test',at});f.pipeline.seed(id);await f.pipeline.run(id);return id;}
const shipping='<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>';

test.each([false,true])('whole review scope expires at the boundary; report first=%s never changes explorer results',async reportFirst=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1></main>');try{
  const a=intake(f.store,f.source.origin+'/a',{assertions:[{field:'bundle_components',value:'seat',quote:'example_only seat',locator:'main'}]});
  const ar=f.store.get<CollectionRecord>('collection_records',a.record_id)!;
  f.advance(1000);await collect(f,'empty');
  const b=f.store.recordByUrl(f.source.origin+'/model')!,group=b.dedup_group_id;
  f.store.changeGroup(group,'merge',{other_group:ar.dedup_group_id,other_expected:expected(f.store,ar.dedup_group_id)},expected(f.store,group));
  const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  const baseline=runner.baseline(run);
  f.response(()=>({status:200,headers:{'content-type':'text/html'},body:shipping}));await collect(f,'shipping');ready(f.store,group);
  runner.resume(run);await runner.run(run);
  const slot=enumerateSlots(f.store).find(s=>s.field==='shipping_fee'&&s.record_ids.includes(b.id))!;
  const saved=runner.snapshots(run).find(s=>s.current)!;
  expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:true,reviewed:true});
  f.advance(Date.parse(ar.next_recheck_at!)-f.now()-1);
  expect(evaluateSlot(f.store,slot).reviewed).toBe(true);
  f.advance(1);
  if(reportFirst)f.store.report();
  const before=evaluateSlot(f.store,slot),beforeDigest=inputDigest(f.store,slot);
  expect(before).toMatchObject({fulfilled:true,reviewed:false});
  expect(runner.snapshots(run).find(s=>s.measured_at===saved.measured_at&&s.state_digest===saved.state_digest)?.current).toBe(false);
  runner.resume(run);await runner.run(run);
  const atBoundary=runner.snapshots(run).find(s=>s.current)!;
  expect(atBoundary).toMatchObject({reviewed:{numerator:0},reviewed_gap_resolution:{numerator:0,denominator:baseline.review_missing.length}});
  f.store.report();
  expect(inputDigest(f.store,slot)).toBe(beforeDigest);
  expect(evaluateSlot(f.store,slot)).toEqual(before);
  expect(runner.snapshots(run).find(s=>s.current)).toEqual(atBoundary);
  f.reopen();const restarted=new MissingFieldRunner(f.store);
  expect(inputDigest(f.store,slot)).toBe(beforeDigest);expect(evaluateSlot(f.store,slot).reviewed).toBe(false);
  restarted.resume(run);await restarted.run(run);
  expect(restarted.baseline(run)).toEqual(baseline);
  expect(restarted.snapshots(run).find(s=>s.current)).toEqual(atBoundary);
  f.advance(1);expect(evaluateSlot(f.store,slot).reviewed).toBe(false);
 }finally{f.close();}
});

test('expiry of an unlinked member of a linked evidence owner group invalidates the full review scope',async()=>{
 const f=engineFixture(shipping);try{
  const stale=intake(f.store,f.source.origin+'/owner-member',{assertions:[]}),staleGroup=f.store.get<CollectionRecord>('collection_records',stale.record_id)!.dedup_group_id;
  f.advance(1000);
  const owner=intake(f.store,f.source.origin+'/owner',{assertions:[{field:'bundle_components',value:'seat',quote:'example_only seat',locator:'main'}]}),ownerGroup=f.store.get<CollectionRecord>('collection_records',owner.record_id)!.dedup_group_id;
  f.store.changeGroup(ownerGroup,'merge',{other_group:staleGroup,other_expected:expected(f.store,staleGroup)},expected(f.store,ownerGroup));
  await collect(f,'linked');const record=f.store.recordByUrl(f.source.origin+'/model')!,group=record.dedup_group_id;
  f.store.changeGroup(group,'link',{assertion_id:f.store.scope(ownerGroup).evidence[0].id},expected(f.store,group));
  ready(f.store,group);
  const slot=enumerateSlots(f.store).find(s=>s.field==='shipping_fee'&&s.record_ids.includes(record.id))!,before=inputDigest(f.store,slot);
  expect(evaluateSlot(f.store,slot).reviewed).toBe(true);
  f.advance(86400000-1000);
  expect(f.store.reviewValidity(group).documents).toHaveLength(3);
  expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:true,reviewed:false});
  expect(inputDigest(f.store,slot)).not.toBe(before);
  expect(f.store.report().counts.ready_to_publish).toBe(0);
  expect(()=>ready(f.store,group)).toThrow('review_requirements');
 }finally{f.close();}
});

test.each([false,true])('expiry of the selected MSRP reopens the gap without adopting its rejected rival; report first=%s',async reportFirst=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>권장소비자가: 100,000원</p></main>');try{
  await collect(f,'selected');
  intake(f.store,f.source.origin+'/model',{target_model_id:'example-model',assertions:[]});
  const a=f.store.recordByUrl(f.source.origin+'/model')!;
  f.advance(1000);f.source.entries=[f.source.origin+'/rival'];
  f.response(()=>({status:200,headers:{'content-type':'text/html'},body:'<main><h1>Example stroller example_only</h1><p>권장소비자가: 200,000원</p></main>'}));
  await collect(f,'rival');intake(f.store,f.source.origin+'/rival',{target_model_id:'example-model',assertions:[]});
  const b=f.store.recordByUrl(f.source.origin+'/rival')!,group=b.dedup_group_id;
  if(a.dedup_group_id!==group)f.store.changeGroup(group,'merge',{other_group:a.dedup_group_id,other_expected:expected(f.store,a.dedup_group_id)},expected(f.store,group));
  const scope=f.store.scope(group),selected=scope.evidence.find(e=>e.record_id===a.id&&e.field==='official_msrp')!,conflict=scope.conflicts[0];
  expect(scope.conflicts).toHaveLength(1);
  const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  f.store.resolveConflict(group,conflict.id,selected.id,'example_only source reviewed',expected(f.store,group));ready(f.store,group);
  runner.resume(run);await runner.run(run);
  const slot=enumerateSlots(f.store).find(s=>s.field==='official_msrp')!;
  expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:true,reviewed:true,assertion_ids:[selected.id]});
  const saved=runner.snapshots(run).find(s=>s.current)!;
  f.advance(Date.parse(a.next_recheck_at!)-f.now()-1);
  expect(evaluateSlot(f.store,slot).fulfilled).toBe(true);f.advance(1);
  if(reportFirst)f.store.report();
  const reopened=evaluateSlot(f.store,slot),digest=inputDigest(f.store,slot);
  expect(reopened).toMatchObject({fulfilled:false,reviewed:false,value:null,reopened:true,diagnoses:expect.arrayContaining([expect.objectContaining({cause:'conflict'})])});
  expect(f.store.conflicts(group)).toContainEqual(expect.objectContaining({id:conflict.id,resolved:false,reason:'selected_evidence_inactive'}));
  expect(f.store.report().unresolved_conflicts).toBe(1);
  expect(inputDigest(f.store,slot)).toBe(digest);expect(evaluateSlot(f.store,slot)).toEqual(reopened);
  expect(()=>ready(f.store,group)).toThrow('review_requirements');
  expect(runner.snapshots(run).find(s=>s.state_digest===saved.state_digest)?.current).toBe(false);
  runner.resume(run);await runner.run(run);
  const current=runner.snapshots(run).find(s=>s.current)!;
  expect(current).toMatchObject({evidence:{numerator:0},reviewed:{numerator:0},gap_resolution:{numerator:0},reviewed_gap_resolution:{numerator:0}});
  f.reopen();const restarted=new MissingFieldRunner(f.store);restarted.resume(run);await restarted.run(run);
  expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:false,reviewed:false,value:null});
  expect(restarted.snapshots(run).find(s=>s.current)).toEqual(current);
  expect(f.store.conflictHistory(group).find(c=>c.id===conflict.id)).toMatchObject({resolved:true,selected:selected.id});
 }finally{f.close();}
});

test('seller handles share normalization; contradictory identities cannot approve or agree',()=>{
 const a={field:'shipping_fee' as const,value:0,quote:'example_only',locator:'main',conditions:{seller:'@SHOP_A'},seller:'shop_a'};
 expect(compareClaims(a,{...a,conditions:{seller:'instagram:shop_a'}})).toBe('same_claim');
 expect(compareClaims({...a,seller:'shop_b'},a)).toBe('assessment_pending');
});

test('partial relation refresh retains other parts and policy reads find conflicts without stored rows',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>호환성: EX-A | 호환</p><p>호환성: EX-B | 호환</p></main>');try{
  await collect(f,'parts');const record=f.store.recordByUrl(f.source.origin+'/model')!,group=record.dedup_group_id;
  f.advance(1000);f.response(()=>({status:200,headers:{'content-type':'text/html'},body:'<main><h1>Example stroller example_only</h1><p>호환성: EX-A | 비호환</p></main>'}));await collect(f,'partial');
  const active=f.store.scope(group).evidence.filter(e=>!e.withdrawn&&!e.superseded_by);
  expect(active).toHaveLength(2);expect(active.map(e=>e.value)).toContainEqual({id:'EX-B',value:true});
  expect(f.store.conflicts(group)).toEqual([]);ready(f.store,group);
  const positive=active.find(e=>(e.value as {id:string}).id==='EX-A')!;
  const rival={...positive,id:'example_only-rival',value:{id:'EX-A',value:true}};
  f.store.db.prepare('INSERT INTO evidence_assertions VALUES(?,?,?)').run(rival.id,rival.record_id,JSON.stringify(rival));
  expect(f.store.conflicts(group)).toHaveLength(1);expect(f.store.scope(group).group.verified_evidence_version).toBeNull();
  expect(f.store.report().unresolved_conflicts).toBe(1);
  expect(()=>ready(f.store,group)).toThrow('review_requirements');
 }finally{f.close();}
});

test('past false compatibility selection preserves both relations and requires new policy approval',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>호환성: EX-A | 호환</p><p>호환성: EX-B | 호환</p></main>');try{
  await collect(f,'parts');const r=f.store.recordByUrl(f.source.origin+'/model')!,group=r.dedup_group_id,ids=f.store.scope(group).evidence.map(e=>e.id).sort();ready(f.store,group);
  const legacy={id:digest([group,...ids]),group_id:group,assertions:ids,reason:'old',resolved:true,selected:ids[0],resolution:'example_only historical choice'};
  f.store.db.prepare('INSERT INTO evidence_conflicts VALUES(?,?,?)').run(legacy.id,group,JSON.stringify(legacy));
  f.store.put('collector_meta','evidence_policy','old-policy');f.reopen();
  expect(f.store.get('evidence_conflicts',legacy.id)).toEqual(legacy);expect(f.store.conflicts(group)).toEqual([]);
  const slot=enumerateSlots(f.store).find(s=>s.field==='compatibility')!;
  expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:true,reviewed:false,assertion_ids:ids});
  const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  expect(f.store.db.prepare("SELECT state FROM evidence_policy_jobs WHERE group_id=? AND policy_version=?").get(group,EVIDENCE_POLICY_VERSION)).toMatchObject({state:'done'});
  expect(evaluateSlot(f.store,slot).reviewed).toBe(false);ready(f.store,group);expect(evaluateSlot(f.store,slot).reviewed).toBe(true);
 }finally{f.close();}
});
