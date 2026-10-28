import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { AssertionInput, CollectionRecord } from '../shared/collection-schema';
import { fixture, intake, source, expected, ready } from './helpers/collector';
import { engineFixture } from './helpers/engine';
import { MissingFieldRunner } from '../crawler/src/missing-field/runner';
import { enumerateSlots } from '../crawler/src/missing-field/targets';
import { normalizedConditions } from '../crawler/src/agamajung/subject';
import { ruleDiagnostics } from '../crawler/src/agamajung/rules';
import { evaluateSlot } from '../crawler/src/missing-field/evaluate';

const claim=(field:AssertionInput['field'],value:unknown,conditions:Record<string,string>={}):AssertionInput=>({field,value,conditions,quote:'example_only',locator:'main'});
const groupFor=(store:ReturnType<typeof fixture>['store'],id:string)=>store.get<CollectionRecord>('collection_records',id)!.dedup_group_id;
async function collect(f:ReturnType<typeof engineFixture>,at:string){const run=f.pipeline.start({kind:'test',at});f.pipeline.seed(run);await f.pipeline.run(run);}

test.each([
 ['release_year','2025','2026'],['generation','G1','G2'],['bundle','body','set'],['market','KR','overseas']
])('linked evidence enforces %s against the entire scope at admission and review', (axis,left,right)=>{
 const f=fixture();try{
  const target=intake(f.store,source.origin+'/target',{assertions:[claim('bundle_components','seat')]}),group=groupFor(f.store,target.record_id);
  const a=intake(f.store,source.origin+'/a',{assertions:[claim('shipping_fee',0,{[axis]:left})]}),b=intake(f.store,source.origin+'/b',{assertions:[claim('shipping_fee',0,{[axis]:right})]});
  const ae=f.store.scope(groupFor(f.store,a.record_id)).evidence[0],be=f.store.scope(groupFor(f.store,b.record_id)).evidence[0];
  f.store.changeGroup(group,'link',{assertion_id:ae.id},expected(f.store,group));
  expect(f.store.groupMergeSafe(group)).toBe(true);ready(f.store,group);
  expect(()=>f.store.changeGroup(group,'link',{assertion_id:be.id},expected(f.store,group))).toThrow('merge_forbidden');
  expect(()=>f.store.changeGroup(group,'merge',{other_group:groupFor(f.store,b.record_id),other_expected:expected(f.store,groupFor(f.store,b.record_id))},expected(f.store,group))).toThrow('merge_forbidden');
  // Simulate a previously admitted incompatible link; neither review step can pass.
  f.store.db.prepare('INSERT INTO group_evidence_links VALUES(?,?,?,?)').run('historical-link',group,be.id,JSON.stringify({group_id:group,assertion_id:be.id}));
  expect(f.store.groupMergeSafe(group)).toBe(false);
  expect(f.store.dedupAudit()).toContainEqual(expect.objectContaining({group_id:group,axes:[axis]}));
  for(const decision of ['verify','ready'] as const)expect(()=>f.store.review(group,{...expected(f.store,group),decision,reviewer:'example_only'})).toThrow('review_requirements');
 }finally{f.close();}
});

test('linked owner axes remain part of scope even when the linked assertion has no axes',()=>{
 const f=fixture();try{
  const target=intake(f.store,source.origin+'/target',{assertions:[claim('bundle_components','seat')]}),group=groupFor(f.store,target.record_id);
  const a=intake(f.store,source.origin+'/a',{assertions:[claim('release_year','2025'),claim('shipping_fee',0)]});
  const b=intake(f.store,source.origin+'/b',{assertions:[claim('shipping_fee',0,{release_year:'2026'})]});
  const shipping=f.store.scope(groupFor(f.store,a.record_id)).evidence.find(e=>e.field==='shipping_fee')!;
  f.store.changeGroup(group,'link',{assertion_id:shipping.id},expected(f.store,group));
  expect(()=>f.store.changeGroup(group,'link',{assertion_id:f.store.scope(groupFor(f.store,b.record_id)).evidence[0].id},expected(f.store,group))).toThrow('merge_forbidden');
 }finally{f.close();}
});

test('genuine free shipping resolves the original empty slot after collection and resume',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1></main>');try{
  await collect(f,'empty');const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  const before=runner.storage.current().find(s=>s.slot.field==='shipping_fee')!.slot;
  expect(before.conditions.currency).toBe('KRW');
  expect(normalizedConditions('shipping_fee',{})).toEqual(normalizedConditions('shipping_fee',{currency:'KRW'}));
  f.advance(1000);f.response(()=>({status:200,headers:{'content-type':'text/html'},body:'<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>'}));
  await collect(f,'shipping');runner.resume(run);await runner.run(run);
  expect(runner.storage.current().find(s=>s.slot.field==='shipping_fee')).toMatchObject({slot:{id:before.id},stale:false,assessment:{fulfilled:true,value:['무료']}});
  expect(runner.snapshots(run).find(s=>s.current)).toMatchObject({evidence:{numerator:1,denominator:7},gap_resolution:{numerator:1,denominator:7},untracked:0});
 }finally{f.close();}
});

test('every known offer contributes both required fields, including its missing counterpart',async()=>{
 const f=fixture();try{
  intake(f.store,source.origin+'/offers',{assertions:[
   claim('shipping_fee',0,{seller:'shop-a',offer:'offer-a',option:'blue',effective_at:'2026-10-01',effective_until:'2026-10-31'}),
   claim('group_buy_terms','ends October 31',{seller:'shop-b',offer:'offer-b',option:'red',effective_at:'2026-10-01',effective_until:'2026-10-31'})
  ]});
  const slots=enumerateSlots(f.store),offers=slots.filter(s=>s.kind==='offer');
  expect(slots).toHaveLength(14);expect(offers).toHaveLength(4);
  for(const option of ['blue','red'])expect(slots.filter(s=>s.kind==='model'&&s.conditions.option===option)).toHaveLength(5);
  for(const [seller,offer,option] of [['shop-a','offer-a','blue'],['shop-b','offer-b','red']]){
   const pair=offers.filter(s=>s.conditions.seller===seller);
   expect(pair.map(s=>s.field).sort()).toEqual(['group_buy_terms','shipping_fee']);
   expect(pair.every(s=>s.conditions.offer===offer&&s.conditions.option===option&&s.conditions.effective_until==='2026-10-31')).toBe(true);
   expect(pair.find(s=>s.field==='shipping_fee')!.conditions.currency).toBe('KRW');
   expect(pair.find(s=>s.field==='group_buy_terms')!.conditions).not.toHaveProperty('currency');
  }
  const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  expect(runner.storage.current()).toHaveLength(14);
  expect(runner.snapshots(run).find(s=>s.current)).toMatchObject({evidence:{denominator:14},by_target_kind:{offer:{evidence:{denominator:4}}},by_field:{shipping_fee:{evidence:{denominator:2}},group_buy_terms:{evidence:{denominator:2}}}});
 }finally{f.close();}
});

test('unsupported field-bearing prose stays pending and cannot trigger absence or reverse search',async()=>{
 const body=readFileSync(new URL('./fixtures/missing-field/unsupported-shipping.html',import.meta.url),'utf8'),f=engineFixture(body);try{
  await collect(f,'prose');const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  const shipping=runner.storage.current().find(s=>s.slot.field==='shipping_fee')!;
  expect(shipping.assessment).toMatchObject({state:'assessment_pending',fulfilled:false,value:null,diagnoses:[expect.objectContaining({cause:null,reason:'field_candidate_rejected',refs:[expect.stringMatching(/:line:\d+$/)]})]});
  expect(runner.storage.actions().filter(a=>a.slot_id===shipping.slot.id)).toEqual([]);
  expect(ruleDiagnostics('배송비는 무료입니다.','sanitized_text')).toMatchObject({candidates:[],rejected:[{field:'shipping_fee',quote:'배송비는 무료입니다.',locator:'sanitized_text:line:1',rejected_reason:'unsupported_field_syntax'}]});
 }finally{f.close();}
});

test.each([301,800])('field cues after %i characters stay pending without reverse search',async length=>{
 const prose='x'.repeat(length)+' 배송비는 무료입니다.',f=engineFixture(`<main><h1>Example stroller example_only</h1><p>${prose}</p></main>`);try{
  await collect(f,'long-prose');const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  const shipping=runner.storage.current().find(s=>s.slot.field==='shipping_fee')!;
  expect(shipping.assessment).toMatchObject({state:'assessment_pending',fulfilled:false,value:null,diagnoses:[expect.objectContaining({cause:null,reason:'field_candidate_rejected',scope:expect.objectContaining({complete:true,truncated:false})})]});
  expect(runner.storage.actions().filter(a=>a.slot_id===shipping.slot.id)).toEqual([]);
  expect(ruleDiagnostics(prose,'sanitized_text').rejected).toContainEqual(expect.objectContaining({field:'shipping_fee',locator:'sanitized_text:line:1'}));
  expect(ruleDiagnostics(prose,'sanitized_text').rejected.every(r=>r.quote.length<=300)).toBe(true);
 }finally{f.close();}
});

test.each(['fetch','render'])('a recovered %s login failure does not hold a later successful capture',async stage=>{
 let restricted=true;
 const body='<main><h1>Example stroller example_only</h1></main>',login='<main><form action="/login"><input type="password"></form>로그인이 필요합니다.</main>';
 const f=engineFixture(body,{browser:stage==='render'},stage==='render'?{renderer:{render:async()=>({finalUrl:source.origin+'/model',html:restricted?login:body,text:restricted?'로그인이 필요합니다.':'Example stroller example_only',regionText:'Example stroller example_only'})}}:{});try{
  if(stage==='fetch')f.response(()=>({status:200,headers:{'content-type':'text/html'},body:restricted?login:body}));
  await collect(f,'blocked');const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  const blocked=runner.storage.current().find(s=>s.slot.field==='shipping_fee')!;
  expect(blocked.assessment?.diagnoses).toContainEqual(expect.objectContaining({cause:'inaccessible',reason:'login_required'}));
  expect(runner.storage.actions().filter(a=>a.slot_id===blocked.slot.id).map(a=>a.kind)).toContain('hold_access');
  // An operator releases the stopped domain; the fixture then completes a new collection.
  restricted=false;f.store.put('domain_state',new URL(source.origin).hostname,{next_at:0,stopped:false});f.advance(1000);
  await collect(f,'recovered');runner.resume(run);await runner.run(run);
  const recovered=runner.storage.current().find(s=>s.slot.field==='shipping_fee')!;
  expect(recovered.assessment).toMatchObject({fulfilled:false,value:null,diagnoses:[expect.objectContaining({cause:'not_in_source',reason:'inspected_region_absent'})]});
  const current=runner.storage.actions().filter(a=>a.assessment_id===recovered.assessment!.id&&a.slot_id===recovered.slot.id);
  expect(current.map(a=>a.kind)).toEqual(['reverse_search']);
  expect(f.store.db.prepare("SELECT id FROM engine_checkpoints WHERE error_code='login_required'").all()).toHaveLength(1);
 }finally{f.close();}
});

test('render failure and successful resume invalidate assessments for the same capture',async()=>{
 let restricted=true;
 const f=engineFixture('<main><h1>Example stroller example_only</h1></main>',{browser:true},{renderer:{render:async()=>({finalUrl:source.origin+'/model',html:restricted?'<form action="/login"><input type="password"></form>':'',text:restricted?'로그인이 필요합니다.':'Example stroller example_only',regionText:'Example stroller example_only'})}});try{
  const run=f.pipeline.start({kind:'test',at:'same-capture'});f.pipeline.seed(run);
  // Assess the fetched capture before its renderer runs, then persist the render failure.
  for(let n=0;n<2;n++)await f.pipeline.engine.step(run);
  const slot=enumerateSlots(f.store).find(s=>s.field==='shipping_fee')!,before=evaluateSlot(f.store,slot);
  await f.pipeline.run(run);const failed=evaluateSlot(f.store,slot);
  expect(failed.input_digest).not.toBe(before.input_digest);
  expect(failed.diagnoses).toContainEqual(expect.objectContaining({cause:'inaccessible',reason:'login_required'}));
  const runner=new MissingFieldRunner(f.store),exploration=runner.start();await runner.run(exploration);
  restricted=false;f.store.put('domain_state',new URL(source.origin).hostname,{next_at:0,stopped:false});
  f.pipeline.resume(run);await f.pipeline.run(run);
  expect(runner.storage.current().find(s=>s.slot.id===slot.id)?.stale).toBe(true);
  runner.resume(exploration);await runner.run(exploration);
  expect(runner.storage.current().find(s=>s.slot.id===slot.id)?.assessment?.diagnoses).toContainEqual(expect.objectContaining({cause:'not_in_source'}));
  expect(f.store.db.prepare('SELECT id FROM engine_captures').all()).toHaveLength(1);
 }finally{f.close();}
});

test('target reassignment retires old slots while preserving assessments, baseline and relink history',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>');try{
  await collect(f,'document');const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  const old=runner.storage.current(),history=f.store.db.prepare('SELECT * FROM missing_field_assessments ORDER BY id').all();
  intake(f.store,f.source.origin+'/model',{target_model_id:'example-model',assertions:[]});
  // Newly identified targets remain visible before their first persisted evaluation.
  expect(runner.storage.current()).toHaveLength(7);
  expect(runner.storage.current().every(s=>s.stale&&!s.retired)).toBe(true);
  expect(runner.storage.current(old[0].slot.id)[0]).toMatchObject({retired:true,stale:true,assessment:{fulfilled:false,value:null}});
  runner.resume(run);await runner.run(run);
  const current=runner.storage.current();expect(current).toHaveLength(7);
  expect(current.every(s=>s.slot.target_ref.startsWith('model:example-model:')&&!s.retired&&!s.stale)).toBe(true);
  expect(current.find(s=>s.slot.field==='shipping_fee')?.assessment?.fulfilled).toBe(true);
  expect(Number(f.store.db.prepare('SELECT count(*) n FROM missing_field_slots').get()!.n)).toBe(14);
  for(const row of history)expect(f.store.db.prepare('SELECT * FROM missing_field_assessments WHERE id=?').get(row.id)).toEqual(row);
  for(const row of old){
   expect(f.store.db.prepare('SELECT stale,assessment_id FROM missing_field_slots WHERE id=?').get(row.slot.id)).toMatchObject({stale:1,assessment_id:row.assessment!.id});
   expect(runner.storage.current(row.slot.id)[0].retired).toBe(true);
  }
  const relinks=f.store.list<{decision:string;retired?:boolean}>('review_events').filter(e=>e.decision==='missing_target_relinked'&&e.retired);
  expect(relinks).toHaveLength(7);
  expect(runner.snapshots(run).find(s=>s.current)).toMatchObject({evidence:{numerator:1,denominator:7},gap_resolution:{numerator:0,denominator:6},untracked:7});
  runner.resume(run);await runner.run(run);
  expect(f.store.list<{decision:string;retired?:boolean}>('review_events').filter(e=>e.decision==='missing_target_relinked'&&e.retired)).toHaveLength(7);
 }finally{f.close();}
});

test('a target change after handler execution cannot install the frozen obsolete slot',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>');try{
  await collect(f,'document');let changed=false;
  const runner=new MissingFieldRunner(f.store,{fault:point=>{
   if(point!=='after_handler'||changed)return;changed=true;
   intake(f.store,f.source.origin+'/model',{target_model_id:'example-model',assertions:[]});
  }}),run=runner.start();await runner.run(run);
  expect(runner.storage.current()).toHaveLength(7);
  expect(f.store.db.prepare("SELECT id FROM missing_field_slots WHERE target_ref LIKE 'document:%'").all()).toEqual([]);
  expect(runner.snapshots(run).find(s=>s.current)).toMatchObject({evidence:{denominator:7},untracked:7});
 }finally{f.close();}
});
