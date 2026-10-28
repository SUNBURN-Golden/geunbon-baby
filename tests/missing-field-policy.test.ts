import { expect, test } from 'vitest';
import type { AssertionInput, CollectionRecord } from '../shared/collection-schema';
import { compareClaims, hasValue, validClaim } from '../crawler/src/evidence-policy';
import { axesOf, contradictoryAxes, mergeConflict } from '../crawler/src/merge-rules';
import { privacyFilter } from '../crawler/src/privacy-filter';
import { fixture, intake, expected, source, price, ready } from './helpers/collector';
import { engineFixture } from './helpers/engine';
import { enumerateSlots } from '../crawler/src/missing-field/targets';
import { evaluateSlot } from '../crawler/src/missing-field/evaluate';
const claim=(value:unknown,conditions:Record<string,string>={}):AssertionInput=>({field:'shipping_fee',value,conditions,quote:'example_only',locator:'main'});
test.each([null,'','  ','정보 없음',[],{},['정보 없음'],{value:'정보 없음'}])('empty %j stays empty',value=>expect(hasValue(value)).toBe(false));
test('only field-appropriate zero, explicit currency, and valid axes pass',()=>{
 expect(validClaim(claim(0))).toBe(true);expect(validClaim({...claim(0),field:'official_msrp'})).toBe(false);
 expect(validClaim(claim('조건부'))).toBe(false);expect(validClaim(claim(100,{currency:'USD'}))).toBe(false);
 expect(validClaim({...claim('2100-unknown'),field:'release_year'})).toBe(false);
 expect(privacyFilter({assertions:[claim(0,{release_year:'2026',generation:'G2'})]}).assertions[0].conditions).toMatchObject({release_year:'2026',generation:'G2'});
 expect(privacyFilter({assertions:[claim(0,{release_year:'unknown',generation:'x'.repeat(61)})]}).assertions[0].conditions).not.toHaveProperty('release_year');
});
test.each(['release_year','generation'] as const)('conditions-only %s forbids automatic, alias, manual merge and evidence link',axis=>{
 const f=fixture();try{
  const left=axis==='release_year'?'2025':'G1',right=axis==='release_year'?'2026':'G2';
  const a=intake(f.store,source.origin+'/a',{...price(),assertions:[claim(0,{[axis]:left})]}),b=intake(f.store,source.origin+'/b',{...price(),assertions:[claim(0,{[axis]:right})]});
  const ga=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id,gb=f.store.get<CollectionRecord>('collection_records',b.record_id)!.dedup_group_id;
  expect(ga).not.toBe(gb);
  expect(()=>f.store.changeGroup(ga,'merge',{other_group:gb,other_expected:expected(f.store,gb)},expected(f.store,ga))).toThrow('merge_forbidden');
  expect(()=>f.store.changeGroup(ga,'link',{assertion_id:f.store.scope(gb).evidence[0].id},expected(f.store,ga))).toThrow('merge_forbidden');
  expect(mergeConflict(axesOf([claim(0,{[axis]:left})]),axesOf([claim(0,{[axis]:right})]))).toBe(true);
 }finally{f.close();}
});
test('contradictory independent year and conditions are preserved, audited, and prevent review',()=>{
 const f=fixture();try{
  const result=intake(f.store,source.origin+'/a',{...price(),assertions:[claim(0,{release_year:'2025'}),{...claim('2026'),field:'release_year'}]}),group=f.store.get<CollectionRecord>('collection_records',result.record_id)!.dedup_group_id;
  expect(contradictoryAxes(axesOf(f.store.scope(group).evidence))).toEqual(['release_year']);expect(f.store.dedupAudit()).toHaveLength(1);
  expect(()=>ready(f.store,group)).toThrow('review_requirements');expect(f.store.scope(group).evidence).toHaveLength(2);
 }finally{f.close();}
});
test('seller offers, scope, currency and explicitly disjoint effective ranges share one comparison policy',()=>{
 expect(compareClaims(claim(0,{seller:'shop-a'}),claim(3000,{seller:'shop-b'}))).toBe('different_scope');
 expect(compareClaims(claim('무료',{seller:'shop-a'}),claim(0,{seller:'shop-a'}))).toBe('same_claim');
 expect(compareClaims(claim(0,{seller:'shop-a'}),claim(3000,{seller:'shop-a'}))).toBe('conflict');
 expect(compareClaims({...claim(0),url:source.origin+'/a'},{...claim(3000),url:source.origin+'/b'})).toBe('assessment_pending');
 expect(compareClaims(claim(0,{effective_at:'2026-01-01',effective_until:'2026-02-01'}),claim(3000,{effective_at:'2026-03-01',effective_until:'2026-04-01'}))).toBe('different_scope');
 expect(compareClaims(claim(0,{effective_at:'2026-01-01',effective_until:'2026-03-01'}),claim(3000,{effective_at:'2026-02-01',effective_until:'2026-04-01'}))).toBe('conflict');
 expect(compareClaims(claim(0,{effective_at:'2026-01-01'}),claim(3000))).toBe('assessment_pending');
});

test('expiry of the selected effective period reopens review even while both source documents are fresh',()=>{
 const f=fixture();try{
  const until=new Date(f.now()+1000).toISOString(),later=new Date(f.now()+2000).toISOString();
  const payload=(amount:number,effective_until:string)=>({...price(amount),assertions:price(amount).assertions!.map(a=>({...a,conditions:{...a.conditions,effective_until}}))});
  const a=intake(f.store,source.origin+'/a',payload(100000,until));intake(f.store,source.origin+'/b',payload(200000,later));
  const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  const scope=f.store.scope(group),conflict=scope.conflicts[0],selected=scope.evidence.find(e=>e.record_id===a.record_id)!;
  f.store.resolveConflict(group,conflict.id,selected.id,'example_only choice',expected(f.store,group));ready(f.store,group);
  f.advance(999);expect(f.store.reviewValidity(group).reviewed).toBe(true);f.advance(1);
  const validity=f.store.reviewValidity(group);
  expect(validity.documents.every(d=>d.fresh)).toBe(true);
  expect(validity).toMatchObject({requirements:false,reviewed:false});
  expect(validity.evaluations[0].reopened).toContainEqual(expect.objectContaining({id:conflict.id}));
  expect(f.store.conflicts(group)).toContainEqual(expect.objectContaining({id:conflict.id,resolved:false,reason:'selected_evidence_inactive'}));
  expect(f.store.report().unresolved_conflicts).toBe(1);
  expect(()=>ready(f.store,group)).toThrow('review_requirements');
 }finally{f.close();}
});
test('different sellers do not produce store conflicts and produce independent explorer offer slots',()=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',{...price(),assertions:[claim(0,{seller:'shop-a'})]});intake(f.store,source.origin+'/b',{...price(),assertions:[claim(3000,{seller:'shop-b'})]});
  const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  expect(f.store.conflicts(group)).toEqual([]);ready(f.store,group);
  const slots=enumerateSlots(f.store).filter(s=>s.field==='shipping_fee');expect(slots).toHaveLength(2);expect(new Set(slots.map(s=>s.conditions.seller)).size).toBe(2);
 }finally{f.close();}
});
test('explicit compatibility parts coexist; opposite statements about the same part conflict even in one document',async()=>{
 const body='<main><h1>Example stroller example_only</h1><p>호환성: EX-A | 호환</p><p>호환성: EX-B | 호환</p></main>';
 const f=engineFixture(body);try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);await f.pipeline.run(id);
  const r=f.store.list<CollectionRecord>('collection_records')[0],group=r.dedup_group_id;
  expect(f.store.policyComparisons(group).some(p=>p.result==='coexists')).toBe(true);expect(f.store.conflicts(group)).toHaveLength(0);ready(f.store,group);
  const slot=enumerateSlots(f.store).find(s=>s.field==='compatibility')!;expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:true,reviewed:true});
  f.response(()=>({status:200,headers:{'content-type':'text/html'},body:body.replace('EX-B | 호환','EX-A | 비호환')}));f.advance(1000);
  const next=f.pipeline.start({kind:'test',at:'two'});f.pipeline.seed(next);await f.pipeline.run(next);
  expect(f.store.conflicts(group)).toHaveLength(1);expect(evaluateSlot(f.store,slot).fulfilled).toBe(false);expect(()=>ready(f.store,group)).toThrow('review_requirements');
 }finally{f.close();}
});
test('a historical false positive is re-evaluated without deleting its decision, and approval is invalidated',()=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',{...price(),assertions:[claim(0,{seller:'shop-a'})]});intake(f.store,source.origin+'/b',{...price(),assertions:[claim(3000,{seller:'shop-b'})]});
  const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id,ids=f.store.scope(group).evidence.map(e=>e.id);ready(f.store,group);
  f.store.transaction(()=>{f.store.db.prepare('INSERT INTO evidence_conflicts VALUES(?,?,?)').run('legacy-false-positive',group,JSON.stringify({id:'legacy-false-positive',group_id:group,assertions:ids,resolved:true,selected:ids[0],resolution:'example_only historical selection',reason:'old_rule'}));f.store.put('collector_meta','evidence_policy','legacy');});
  f.reopen();expect(f.store.conflicts(group)).toEqual([]);expect(f.store.get('evidence_conflicts','legacy-false-positive')).toMatchObject({selected:ids[0],resolved:true});
  expect(f.store.scope(group).group.verified_evidence_version).toBeNull();expect(Number(f.store.db.prepare('SELECT count(*) n FROM evidence_conflict_evaluations').get()!.n)).toBeGreaterThan(0);
 }finally{f.close();}
});
test('unknown document targets cannot borrow values through a manual dedup group',()=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',{assertions:[claim(0)]}),b=intake(f.store,source.origin+'/b',{assertions:[]});
  const ga=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id,gb=f.store.get<CollectionRecord>('collection_records',b.record_id)!.dedup_group_id;
  f.store.changeGroup(ga,'merge',{other_group:gb,other_expected:expected(f.store,gb)},expected(f.store,ga));
  const slots=enumerateSlots(f.store).filter(s=>s.field==='shipping_fee');expect(slots).toHaveLength(2);expect(slots.every(s=>s.record_ids.length===1)).toBe(true);
 }finally{f.close();}
});
