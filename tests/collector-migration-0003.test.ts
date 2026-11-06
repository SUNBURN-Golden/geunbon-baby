import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorStore } from '../crawler/src/store';
import { backfillEngine } from '../crawler/src/agamajung/backfill';
import { digest } from '../crawler/src/dedup';
import { PRIVACY_VERSION } from '../shared/privacy-rules';
import type { CollectionRecord } from '../shared/collection-schema';
import { fixture, intake, source } from './helpers/collector';
test('v2 synthetic 518 records and all legacy data survive 0003, with private backup and idempotent backfill',()=>{
 const dir=mkdtempSync(join(tmpdir(),'migration-0003-')),file=join(dir,'collector.sqlite');
 try{
  const db=new DatabaseSync(file);db.exec(readFileSync(new URL('../crawler/migrations/0001_collection.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../crawler/migrations/0002_lookup_indexes.sql',import.meta.url),'utf8'));
  db.exec('BEGIN');
  for(let i=0;i<518;i++){
   const id=digest(i),url=`https://example.org/legacy-${i}`,g=digest(['group',i]),time='2026-10-01T00:00:00.000Z';
   const r:CollectionRecord={id,url,title:'example_only',source:'legacy',published_at:null,collected_at:time,target_model_id:null,extracted_facts:{},evidence_locator:[],dedup_group_id:g,verification_status:'discovered',collection_method:'auto_discovery',schema_version:1,record_version:1,privacy_filter_version:PRIVACY_VERSION,conflict_detected:false,last_checked_at:null,next_recheck_at:null};
   db.prepare('INSERT INTO dedup_groups VALUES(?,?)').run(g,JSON.stringify({id:g,key:`url:${url}`,representative:id,group_version:0,evidence_version:0,lineage:[],verified_evidence_version:null,ready_evidence_version:null,review_scope_digest:''}));
   db.prepare('INSERT INTO collection_records VALUES(?,?,?,?,?)').run(id,url,g,'discovered',JSON.stringify(r));
  }
  db.exec('COMMIT');
  const before=db.prepare('SELECT * FROM collection_records ORDER BY id').all(),groups=db.prepare('SELECT * FROM dedup_groups ORDER BY id').all();db.close();
  const quarantined=before.map(row=>({...row,data:JSON.stringify({...JSON.parse(String(row.data)),record_version:2,identity_quarantined:true})}));
  const store=new CollectorStore(file);try{
   expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:7});expect(store.db.prepare('SELECT * FROM collection_records ORDER BY id').all()).toEqual(quarantined);
   const migratedGroups=store.db.prepare('SELECT * FROM dedup_groups ORDER BY id').all();
   expect(migratedGroups).toEqual(groups.map(row=>({...row,data:expect.any(String)})));
   for(const [index,row] of migratedGroups.entries())expect(JSON.parse(String(row.data))).toMatchObject({...JSON.parse(String(groups[index].data)),group_version:1,evidence_version:1,review_scope_digest:expect.any(String)});
   const backups=readdirSync(dir).filter(x=>x.includes('.pre-0003-'));expect(backups).toHaveLength(1);expect(statSync(join(dir,backups[0])).mode&0o777).toBe(0o600);
   expect(store.db.prepare('PRAGMA quick_check').get()).toMatchObject({quick_check:'ok'});expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
   expect(backfillEngine(store)).toEqual({captures:518,extracted:0,total:518});expect(backfillEngine(store)).toEqual({captures:0,extracted:0,total:518});expect(store.db.prepare('SELECT * FROM collection_records ORDER BY id').all()).toEqual(quarantined);
   const backup=new DatabaseSync(join(dir,backups[0]),{readOnly:true});try{expect(backup.prepare('SELECT * FROM collection_records ORDER BY id').all()).toEqual(before);}finally{backup.close();}
  }finally{store.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('backfill derives change windows only from actual supersession chains and never promotes legacy authority',()=>{
 const f=fixture();try{
  const observation=(value:string)=>({assertions:[{field:'shipping_fee' as const,value,quote:'example_only shipping',locator:'main'}]});
  intake(f.store,source.origin+'/a',observation('A'));f.advance(1000);intake(f.store,source.origin+'/a',observation('B'));f.advance(1000);intake(f.store,source.origin+'/a',observation('B'));
  expect(backfillEngine(f.store)).toMatchObject({captures:1,extracted:3});expect(backfillEngine(f.store)).toMatchObject({captures:0,extracted:0});
  const rows=f.store.db.prepare('SELECT * FROM engine_extracted ORDER BY collected_at').all() as {collected_at:string;change_window_start:string|null;fact_status:string}[];
  expect(rows[0].change_window_start).toBeNull();expect(rows[1].change_window_start).toBe(rows[0].collected_at);expect(rows[2].change_window_start).toBe(rows[0].collected_at);expect(rows.every(r=>r.fact_status==='source_claim')).toBe(true);expect(f.store.db.prepare('SELECT * FROM engine_labels').all()).toEqual([]);
 }finally{f.close();}
});
