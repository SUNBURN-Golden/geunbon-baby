import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { engineFixture } from './helpers/engine';
import { expected } from './helpers/collector';
import type { CollectionRecord } from '../shared/collection-schema';
import { MissingFieldRunner } from '../crawler/src/missing-field/runner';
import { enumerateSlots } from '../crawler/src/missing-field/targets';
import { evaluateSlot } from '../crawler/src/missing-field/evaluate';
import { metrics } from '../crawler/src/missing-field/metrics';
import { loadDiscoveryConfig } from '../crawler/src/source-discovery/config';
import type { Assessment } from '../crawler/src/missing-field/types';
const asset=(name:string)=>readFileSync(new URL(`./fixtures/missing-field/${name}.html`,import.meta.url),'utf8');
async function collect(f:ReturnType<typeof engineFixture>,at='first'){
 const id=f.pipeline.start({kind:'test',at});f.pipeline.seed(id);await f.pipeline.run(id);return id;
}
async function explore(f:ReturnType<typeof engineFixture>){const runner=new MissingFieldRunner(f.store),id=runner.start();await runner.run(id);return {runner,id,rows:runner.storage.current()};}
const count=(f:ReturnType<typeof engineFixture>,table:string)=>Number(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
test.each([
 ['unextracted','unextracted','improve_extractor'],['not-in-source','not_in_source','reverse_search'],['inaccessible','inaccessible','hold_access'],['conflict','conflict','review']
])('four offline fixtures route %s to the existing follow-up path',async(name,cause,action)=>{
 const f=engineFixture(asset(name));try{
  await collect(f);const calls=f.calls.length,before=f.store.list('evidence_assertions');
  const {runner,rows}=await explore(f),shipping=rows.find(r=>r.slot.field==='shipping_fee')!;
  expect(shipping.assessment).toMatchObject({fulfilled:false,value:null});
  expect(shipping.assessment?.diagnoses).toContainEqual(expect.objectContaining({cause}));
  expect(runner.storage.actions().some(a=>a.kind===action&&a.slot_id===shipping.slot.id)).toBe(true);
  expect(f.calls).toHaveLength(calls);expect(f.store.list('evidence_assertions')).toEqual(before);
 }finally{f.close();}
});
test('real quoted evidence alone fulfils a slot; source_claim is not human review and dry-run writes nothing',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>');try{
  await collect(f);expect(count(f,'extracted_assertion_links')).toBe(1);
  const before={runs:count(f,'engine_runs'),slots:count(f,'missing_field_slots'),actions:count(f,'missing_field_actions'),costs:count(f,'engine_costs')};
  const runner=new MissingFieldRunner(f.store);runner.preview();
  expect(evaluateSlot(f.store,enumerateSlots(f.store).find(s=>s.field==='shipping_fee')!)).toMatchObject({fulfilled:true,reviewed:false,value:['무료']});
  expect({runs:count(f,'engine_runs'),slots:count(f,'missing_field_slots'),actions:count(f,'missing_field_actions'),costs:count(f,'engine_costs')}).toEqual(before);
  const id=runner.start();await runner.run(id);expect(runner.snapshots(id).at(-1)).toMatchObject({current:true,evidence:{numerator:1,denominator:7},reviewed:{numerator:0}});
  const old=count(f,'missing_field_assessments');runner.resume(id);await runner.run(id);expect(count(f,'missing_field_assessments')).toBe(old);
  const r=f.store.list<CollectionRecord>('collection_records')[0];f.store.review(r.dedup_group_id,{...expected(f.store,r.dedup_group_id),decision:'verify',reviewer:'example_only'});
  expect(runner.storage.current().every(r=>r.stale)).toBe(true);expect(runner.snapshots(id).every(s=>!s.current)).toBe(true);
  runner.resume(id);await runner.run(id);expect(runner.snapshots(id).find(s=>s.current)).toMatchObject({reviewed:{numerator:1}});
  f.advance(86400001);expect(runner.storage.current().find(r=>r.slot.field==='shipping_fee')?.assessment?.reviewed).toBe(false);
 }finally{f.close();}
});
test('collect → conflict selection → verify → withdrawal reopens gap, never adopts the unselected claim',async()=>{
 const f=engineFixture(asset('conflict'));try{
  await collect(f);const {runner,id}=await explore(f),r=f.store.list<CollectionRecord>('collection_records')[0],group=r.dedup_group_id,scope=f.store.scope(group),conflict=scope.conflicts[0];
  expect(count(f,'extracted_assertion_links')).toBe(2);expect(scope.evidence.filter(e=>!e.superseded_by)).toHaveLength(2);
  expect(()=>f.store.review(group,{...expected(f.store,group),decision:'verify',reviewer:'example_only'})).toThrow('review_requirements');
  f.store.resolveConflict(group,conflict.id,conflict.assertions[0],'example_only source reviewed',expected(f.store,group));
  runner.resume(id);await runner.run(id);expect(runner.storage.current().find(r=>r.slot.field==='shipping_fee')?.assessment).toMatchObject({fulfilled:true,reviewed:false,assertion_ids:[conflict.assertions[0]]});
  f.store.review(group,{...expected(f.store,group),decision:'verify',reviewer:'example_only'});runner.resume(id);await runner.run(id);
  expect(runner.snapshots(id).find(s=>s.current)).toMatchObject({reviewed:{numerator:1},gap_resolution:{numerator:1,denominator:7}});
  f.store.changeGroup(group,'withdraw',{assertion_id:conflict.assertions[0]},expected(f.store,group));
  expect(runner.storage.current().find(r=>r.slot.field==='shipping_fee')).toMatchObject({stale:true,assessment:{fulfilled:false,value:null}});
  runner.resume(id);await runner.run(id);
  expect(runner.storage.current().find(r=>r.slot.field==='shipping_fee')?.assessment).toMatchObject({fulfilled:false,value:null,reopened:true});
  expect(runner.snapshots(id).find(s=>s.current)).toMatchObject({gap_resolution:{numerator:0,denominator:7}});
  expect(f.store.scope(group).group.verified_evidence_version).toBeNull();expect(f.store.scope(group).evidence).toHaveLength(2);
 }finally{f.close();}
});
test('unlinked, hash-only legacy, fabricated locators and inference cannot count as evidence',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>');try{
  await collect(f);const fact=f.store.db.prepare('SELECT * FROM engine_extracted').get()!,assertion=f.store.list<{id:string}>('evidence_assertions')[0];
  const slot=enumerateSlots(f.store).find(s=>s.field==='shipping_fee')!;
  expect(evaluateSlot(f.store,slot).fulfilled).toBe(true);
  // Simulate untrusted/legacy claims with no native immutable provenance link.
  f.store.transaction(()=>{const e=f.store.get<Record<string,unknown>>('evidence_assertions',assertion.id)!;e.locator='main:line:999';f.store.db.prepare('UPDATE evidence_assertions SET data=? WHERE id=?').run(JSON.stringify(e),assertion.id);});
  expect(evaluateSlot(f.store,slot)).toMatchObject({fulfilled:false,value:null});
  expect(()=>f.store.db.prepare('UPDATE extracted_assertion_links SET digest=?').run('forged')).toThrow('immutable_id_conflict');
  expect(()=>f.store.db.prepare('DELETE FROM extracted_assertion_links').run()).toThrow('immutable_id_conflict');
  expect(()=>f.store.submitExtracted('missing',{assertions:[]},{capture_id:String(fact.capture_id),extractor:String(fact.extractor),ids:[]})).toThrow();
 }finally{f.close();}
});
test('truncated/old cache and a missing cache remain pending, never source absence',async()=>{
 for(const body of ['<main><h1>Example stroller example_only</h1><p>'+('x'.repeat(1100))+'</p></main>','<main><h1>Example stroller example_only</h1></main>']){
  const f=engineFixture(body);try{
   await collect(f);if(body.length<1100)f.store.db.prepare("DELETE FROM engine_cache WHERE stage='parse'").run();
   const shipping=evaluateSlot(f.store,enumerateSlots(f.store).find(s=>s.field==='shipping_fee')!);
   expect(shipping).toMatchObject({fulfilled:false,state:'assessment_pending'});expect(shipping.diagnoses.every(d=>d.cause===null)).toBe(true);
  }finally{f.close();}
 }
});
test('same fixed baseline survives resume, new arrivals, and zero denominators return null',async()=>{
 const f=engineFixture(asset('not-in-source'));try{
  await collect(f);const {runner,id}=await explore(f),initial=runner.snapshots(id)[0];
  f.store.discover(f.source.origin+'/new-target');runner.resume(id);await runner.run(id);
  const latest=runner.snapshots(id).find(s=>s.current)!;expect(latest.gap_resolution.denominator).toBe(initial.gap_resolution.denominator);expect(latest.evidence.denominator).toBe(14);
  expect(metrics([],[],{slots:[],missing:[]}).gap_resolution).toEqual({numerator:0,denominator:0,rate:null,status:'not_applicable'});
 }finally{f.close();}
});
test('concurrent withdrawal between evaluation and commit rejects the stale result and reevaluates',async()=>{
 const f=engineFixture('<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>');try{
  await collect(f);let changed=false;
  const runner=new MissingFieldRunner(f.store,{fault:point=>{
   if(point!=='after_handler'||changed)return;changed=true;
   const r=f.store.list<CollectionRecord>('collection_records')[0],e=f.store.scope(r.dedup_group_id).evidence[0];f.store.changeGroup(r.dedup_group_id,'withdraw',{assertion_id:e.id},expected(f.store,r.dedup_group_id));
  }}),id=runner.start();await runner.run(id);
  expect(runner.storage.current().find(s=>s.slot.field==='shipping_fee')?.assessment).toMatchObject({fulfilled:false,value:null});
 }finally{f.close();}
});
test('reverse search registers approved provider queries with explicit conditions and stable slot links',async()=>{
 const f=engineFixture(asset('not-in-source'));try{
  await collect(f);const config=loadDiscoveryConfig();config.enabled=true;
  config.providers=[{id:'example-search',enabled:true,endpoint:'https://search.example.org/api/search',query_param:'q',cursor_param:'cursor',title_path:'title',summary_path:'summary',results_path:'results',url_path:'url',terms:{status:'approved',basis:'example_only fixture permission',checked_at:'2026-10-01T00:00:00Z',storage:'urls',cursor_storage:false}}];
  const runner=new MissingFieldRunner(f.store,{discovery:config}),id=runner.start();await runner.run(id);
  const actions=runner.storage.actions().filter(a=>a.kind==='reverse_search'),links=actions.flatMap(a=>a.links);
  expect(links.some(l=>l.kind==='source_query'),JSON.stringify(links)).toBe(true);
  expect(f.store.db.prepare('SELECT query_text FROM source_discovery_queries').all().some(q=>String(q.query_text).includes('EX-100'))).toBe(true);
  expect(actions.every(a=>a.slot_id)).toBe(true);expect(count(f,'source_candidates')).toBe(0);
 }finally{f.close();}
});
test('metrics do not equate work creation or candidate discovery with gap resolution',()=>{
 const a={slot_id:'one',fulfilled:false,reviewed:false,reopened:false,state:'missing',diagnoses:[{cause:'not_in_source'},{cause:'inaccessible'}]} as Assessment;
 const s={id:'one',field:'shipping_fee',kind:'offer'} as ReturnType<typeof enumerateSlots>[number];
 expect(metrics([s],[a],{slots:['one'],missing:['one']})).toMatchObject({evidence:{numerator:0,denominator:1},gap_resolution:{numerator:0},causes:{not_in_source:1,inaccessible:1}});
});
