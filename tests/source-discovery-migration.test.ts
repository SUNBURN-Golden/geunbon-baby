import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { discoveryFixture, discover, rows } from './helpers/source-discovery';
const migration=(name:string)=>readFileSync(new URL(`../crawler/migrations/${name}`,import.meta.url),'utf8');
test('0003 still works independently; 0004 and reopening preserve prior records and candidates',async()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const name of ['0001_collection.sql','0002_lookup_indexes.sql','0003_engine.sql'])db.exec(migration(name));
  expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:3});db.exec(migration('0004_source_discovery.sql'));db.exec(migration('0004_source_discovery.sql'));expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:4});expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{db.close();}
 const f=discoveryFixture();try{
  await discover(f);const before=rows(f,'source_candidates'),evidence=rows(f,'source_candidate_evidence');f.reopen();f.store.db.exec(migration('0004_source_discovery.sql'));
  expect(rows(f,'source_candidates')).toEqual(before);expect(rows(f,'source_candidate_evidence')).toEqual(evidence);expect(f.store.db.prepare('PRAGMA quick_check').get()).toMatchObject({quick_check:'ok'});
 }finally{f.close();}
});
