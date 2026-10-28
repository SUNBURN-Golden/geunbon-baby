import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { engineFixture } from './helpers/engine';
import { expected, intake, source } from './helpers/collector';
import { backfillEngine } from '../crawler/src/agamajung/backfill';
import { digest } from '../crawler/src/dedup';
import { CollectorStore, type Evidence } from '../crawler/src/store';
import type { CollectionRecord } from '../shared/collection-schema';
import { MissingFieldRunner } from '../crawler/src/missing-field/runner';
const page='<main><h1>Example stroller example_only</h1><p>배송비: 무료</p></main>';
const count=(f:ReturnType<typeof engineFixture>,table:string)=>Number(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
async function collect(f:ReturnType<typeof engineFixture>,at='one'){const id=f.pipeline.start({kind:'test',at});f.pipeline.seed(id);await f.pipeline.run(id);return id;}
test('service commit recovery binds receipt and source links without duplicating assertions or resetting withdrawal',async()=>{
 let once=true;const f=engineFixture(page,{}, {fault:point=>{if(point==='after_external_commit'&&once){once=false;throw new Error('example_only crash');}}});try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);await expect(f.pipeline.run(id)).rejects.toThrow('engine_crash');
  expect(count(f,'intake_receipts')).toBe(1);expect(count(f,'extracted_assertion_links')).toBe(1);
  const original=f.store.list<Evidence>('evidence_assertions')[0],r=f.store.get<CollectionRecord>('collection_records',original.record_id)!;
  f.store.changeGroup(r.dedup_group_id,'withdraw',{assertion_id:original.id},expected(f.store,r.dedup_group_id));
  const before={assertions:count(f,'evidence_assertions'),links:count(f,'extracted_assertion_links'),receipts:count(f,'intake_receipts'),outbox:count(f,'sync_outbox')};
  f.advance(181000);f.reopen();await f.pipeline.run(id);
  expect({assertions:count(f,'evidence_assertions'),links:count(f,'extracted_assertion_links'),receipts:count(f,'intake_receipts'),outbox:count(f,'sync_outbox')}).toEqual(before);
  expect(f.store.get('evidence_assertions',original.id)).toMatchObject({withdrawn:true});
  const fact=f.store.db.prepare('SELECT id,capture_id,extractor,data FROM engine_extracted').get()!;
  const reserved=f.store.reserve('linux',{clip_id:digest('example_only new'),attempt_id:digest('example_only new attempt'),url:r.url,brand:f.source.brand,collection_method:'auto_discovery',operation:'recheck',policy_version:1});f.store.start('linux',reserved.id);
  expect(()=>f.store.submitExtracted(reserved.id,{title:r.title,assertions:[JSON.parse(String(fact.data)).assertion]},{capture_id:String(fact.capture_id),extractor:String(fact.extractor),ids:[String(fact.id)]})).toThrow('provenance_reused');
  expect(count(f,'evidence_assertions')).toBe(1);
 }finally{f.close();}
});
test('a fault before service commit rolls back assertion, link and receipt together; retry preserves one-to-one mapping',async()=>{
 const f=engineFixture(page);try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);
  while(!f.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='service'").get(id))await f.pipeline.engine.step(id);
  const cap=f.store.db.prepare('SELECT id FROM engine_captures').get()!,fact=f.store.db.prepare('SELECT id,extractor,data FROM engine_extracted').get()!;
  const reservation=f.store.reserve('linux',{clip_id:digest('example_only rollback'),attempt_id:digest('example_only attempt'),url:f.source.entries[0],brand:f.source.brand,collection_method:'auto_discovery',operation:'new_body',policy_version:1});f.store.start('linux',reservation.id);
  let fail=true;const other=new CollectorStore(f.file,f.settings,f.now,point=>{if(point==='intake'&&fail){fail=false;throw new Error('example_only fault');}});
  try{
   const input={capture_id:String(cap.id),extractor:String(fact.extractor),ids:[String(fact.id)]},payload={assertions:[JSON.parse(String(fact.data)).assertion]};
   expect(()=>other.submitExtracted(reservation.id,payload,input)).toThrow('example_only fault');
   expect(count(f,'extracted_assertion_links')).toBe(0);expect(count(f,'evidence_assertions')).toBe(0);expect(count(f,'intake_receipts')).toBe(0);
   const receipt=other.submitExtracted(reservation.id,payload,input);expect(other.submitExtracted(reservation.id,payload,input)).toEqual(receipt);
   expect(count(f,'extracted_assertion_links')).toBe(1);expect(count(f,'evidence_assertions')).toBe(1);expect(count(f,'intake_receipts')).toBe(1);
  }finally{other.close();}
 }finally{f.close();}
});
test('native backfill never duplicates extraction facts, explicit legacy IDs link, and missing legacy body never counts',async()=>{
 const f=engineFixture(page);try{
  await collect(f);const before={captures:count(f,'engine_captures'),extracted:count(f,'engine_extracted'),links:count(f,'extracted_assertion_links')};
  expect(backfillEngine(f.store)).toMatchObject({captures:0,extracted:0});expect({captures:count(f,'engine_captures'),extracted:count(f,'engine_extracted'),links:count(f,'extracted_assertion_links')}).toEqual(before);
  const receipt=intake(f.store,source.origin+'/legacy',{assertions:[{field:'shipping_fee',value:0,quote:'배송비: 무료',locator:'main:line:1'}]});
  expect(backfillEngine(f.store)).toMatchObject({captures:1,extracted:1});expect(backfillEngine(f.store)).toMatchObject({captures:0,extracted:0});
  const legacy=f.store.scope(f.store.get<CollectionRecord>('collection_records',receipt.record_id)!.dedup_group_id).evidence[0];
  expect(f.store.db.prepare('SELECT data FROM extracted_assertion_links WHERE assertion_id=?').get(legacy.id)).toBeDefined();
  const runner=new MissingFieldRunner(f.store),run=runner.start();await runner.run(run);
  expect(runner.storage.current().find(s=>s.slot.record_ids.includes(receipt.record_id)&&s.slot.field==='shipping_fee')?.assessment).toMatchObject({fulfilled:false,value:null});
 }finally{f.close();}
});
test('migration 0005 can be repeated, retains foreign keys, and guards immutable diagnoses',async()=>{
 const f=engineFixture(page);try{
  await collect(f);const runner=new MissingFieldRunner(f.store),id=runner.start();await runner.run(id);
  const before=count(f,'missing_field_assessments'),sql=readFileSync(new URL('../crawler/migrations/0005_missing_field_explorer.sql',import.meta.url),'utf8');
  f.store.transaction(()=>f.store.db.exec(sql));f.store.transaction(()=>f.store.db.exec(sql));expect(count(f,'missing_field_assessments')).toBe(before);
  expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const row=f.store.db.prepare('SELECT * FROM missing_field_assessments LIMIT 1').get()!;
  expect(()=>f.store.db.prepare('INSERT INTO missing_field_assessments VALUES(?,?,?,?,?)').run(row.id,row.slot_id,row.input_digest,row.assessed_at,row.data)).not.toThrow();
  expect(()=>f.store.db.prepare('INSERT INTO missing_field_assessments VALUES(?,?,?,?,?)').run(row.id,row.slot_id,row.input_digest,row.assessed_at,'{}')).toThrow('immutable_id_conflict');
  expect(()=>f.store.db.prepare("UPDATE missing_field_assessments SET data='{}'").run()).toThrow('immutable_id_conflict');
  expect(()=>f.store.db.prepare('DELETE FROM missing_field_assessments').run()).toThrow('immutable_id_conflict');
 }finally{f.close();}
});
