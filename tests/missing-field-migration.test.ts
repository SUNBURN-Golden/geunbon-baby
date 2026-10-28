import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { engineFixture, asset } from './helpers/engine';
import { expected, ready } from './helpers/collector';
import { CollectorStore } from '../crawler/src/store';
import { AgamajungPipeline } from '../crawler/src/agamajung/pipeline';
import { Scheduler, type NetworkResponse } from '../crawler/src/scheduler';
import { MissingFieldRunner } from '../crawler/src/missing-field/runner';
import { enumerateSlots } from '../crawler/src/missing-field/targets';
import { evaluateSlot, inputDigest } from '../crawler/src/missing-field/evaluate';
import { digest } from '../crawler/src/dedup';

// A real v4 database, including old decisions and raw/extracted facts, rather
// than merely lowering PRAGMA user_version on a v5 schema.
test.each([false,true])('0004 migration preserves %s conflict history; pure reads work before interrupted policy jobs finish',async realConflict=>{
 const body=`<main><h1>Example stroller example_only</h1><p>호환성: EX-A | 호환</p><p>호환성: ${realConflict?'EX-A | 비호환':'EX-B | 호환'}</p></main>`;
 const f=engineFixture(body);let store:CollectorStore|undefined;try{
  const run=f.pipeline.start({kind:'test',at:'legacy'});f.pipeline.seed(run);await f.pipeline.run(run);
  const record=f.store.recordByUrl(f.source.origin+'/model')!,group=record.dedup_group_id,ids=f.store.scope(group).evidence.map(e=>e.id).sort();
  if(realConflict){const c=f.store.conflicts(group)[0];f.store.resolveConflict(group,c.id,c.assertions[0],'example_only choice',expected(f.store,group));}
  ready(f.store,group);
  const file=join(f.dir,'v4.sqlite'),db=new DatabaseSync(file,{enableForeignKeyConstraints:false});chmodSync(file,0o600);
  for(const migration of ['0001_collection.sql','0002_lookup_indexes.sql','0003_engine.sql','0004_source_discovery.sql'])db.exec(readFileSync(new URL(`../crawler/migrations/${migration}`,import.meta.url),'utf8'));
  db.exec('BEGIN');
  // A real v4 database owns none of the 0005 tables; schema-order copying needs
  // FK checks off, and integrity is asserted right after they are re-enabled.
  const v4=new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(r=>r.name));
  const tables=(f.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(r=>r.name).filter(t=>v4.has(t));
  for(const table of tables){
   for(const original of f.store.db.prepare(`SELECT * FROM ${table}`).all()){
    const row={...original};
    if(table==='dedup_groups'){
     const g=JSON.parse(String(row.data));delete g.verified_scope_digest;delete g.ready_scope_digest;delete g.review_policy_version;row.data=JSON.stringify(g);
    }
    if(table==='evidence_conflicts'){const c=JSON.parse(String(row.data));delete c.policy_version;delete c.input_digest;row.data=JSON.stringify(c);}
    if(table==='collector_meta'&&['evidence_policy','review_epoch'].includes(String(row.id)))continue;
    const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
   }
  }
  if(!realConflict){const id=digest([group,...ids]);db.prepare('INSERT INTO evidence_conflicts VALUES(?,?,?)').run(id,group,JSON.stringify({id,group_id:group,assertions:ids,resolved:true,selected:ids[0],reason:'legacy_different_values',resolution:'example_only historical choice'}));}
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys=ON');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const retained=['collection_records','dedup_groups','evidence_assertions','evidence_conflicts','review_events','engine_captures','engine_extracted'].map(t=>({table:t,rows:db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()}));db.close();
  store=new CollectorStore(file,f.settings,f.now);
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
  for(const saved of retained)expect(store.db.prepare(`SELECT * FROM ${saved.table} ORDER BY id`).all()).toEqual(saved.rows);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const slot=enumerateSlots(store).find(s=>s.field==='compatibility'&&s.record_ids.includes(record.id))!,before=inputDigest(store,slot);
  // 0005 provenance links are new: a v4 database never had them, so evidence
  // coverage stays unmet after migration while current-conflict reads already
  // apply the new policy (false positives unblocked, real conflicts kept).
  expect(evaluateSlot(store,slot)).toMatchObject({fulfilled:false,reviewed:false});
  expect(evaluateSlot(store,slot).diagnoses.some(d=>d.reason==='provenance_unlinked')).toBe(true);
  expect(store.conflicts(group).filter(c=>!c.resolved)).toHaveLength(realConflict?1:0);
  expect(store.report().unresolved_conflicts).toBe(realConflict?1:0);
  expect(inputDigest(store,slot)).toBe(before);
  let fail=true;
  const explorer=new MissingFieldRunner(store,{fault:point=>{if(point==='after_handler'&&fail){fail=false;throw new Error('example_only crash');}}}),id=explorer.start();
  await expect(explorer.run(id)).rejects.toThrow('engine_crash');
  store.close();f.advance(180001);store=new CollectorStore(file,f.settings,f.now);
  const resumed=new MissingFieldRunner(store);await resumed.run(resumed.resume(id));
  expect(inputDigest(store,slot)).toBe(before);
  expect(evaluateSlot(store,slot)).toMatchObject({fulfilled:false,reviewed:false});
  const retainedConflicts=retained.find(t=>t.table==='evidence_conflicts')!.rows.map(r=>JSON.parse(String(r.data)));
  expect(store.conflictHistory(group)).toEqual(retainedConflicts);
  const historyCount=store.db.prepare('SELECT count(*) n FROM evidence_conflict_evaluations').get()?.n;
  resumed.resume(id);await resumed.run(id);
  expect(store.db.prepare('SELECT count(*) n FROM evidence_conflict_evaluations').get()?.n).toBe(historyCount);
  // Re-collection creates explicit provenance: the removed false-positive block
  // then restores evidence coverage including the historically unselected part,
  // while review completion still waits for a fresh approval, and a real
  // conflict survives the policy migration untouched.
  const scheduler=new Scheduler(store,async(url,_max,_trusted,opts):Promise<NetworkResponse>=>url.pathname==='/robots.txt'?{status:200,headers:{'content-type':'text/plain'},body:asset('robots.txt')}:opts?.headers?.['if-none-match']?{status:304,headers:{'content-type':'text/html',etag:'"example-v1"'},body:''}:{status:200,headers:{'content-type':'text/html',etag:'"example-v1"'},body},async ms=>f.advance(ms));
  const recrawl=new AgamajungPipeline(store,f.raw,f.profile,{scheduler}),recrawlRun=recrawl.start({kind:'test',at:'recrawl'});
  recrawl.seed(recrawlRun);await recrawl.run(recrawlRun);
  const after=evaluateSlot(store,enumerateSlots(store).find(s=>s.field==='compatibility'&&s.record_ids.includes(record.id))!);
  expect(after).toMatchObject({fulfilled:!realConflict,reviewed:false});
  if(!realConflict)expect(after.assertion_ids).toHaveLength(2);
  expect(store.conflicts(group).filter(c=>!c.resolved)).toHaveLength(realConflict?1:0);
  expect(store.conflictHistory(group).filter(c=>retainedConflicts.some(r=>r.id===c.id))).toEqual(retainedConflicts);
 }finally{store?.close();f.close();}
});
