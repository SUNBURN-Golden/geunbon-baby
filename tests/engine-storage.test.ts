import { expect, test } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { engineFixture } from './helpers/engine';
test.each([false,true])('all capture/fact/label columns are immutable, including REPLACE and UPSERT (recursive=%s)',async recursive=>{
 const f=engineFixture();try{
  const r=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(r);await f.pipeline.run(r);f.store.db.exec(`PRAGMA recursive_triggers=${recursive?'ON':'OFF'}`);
  for(const table of ['engine_captures','engine_extracted','engine_labels']){
   const row=f.store.db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as Record<string,SQLInputValue>;
   const columns=(f.store.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name);
   for(const column of columns)expect(()=>f.store.db.prepare(`UPDATE ${table} SET ${column}=${column} WHERE id=?`).run(row.id),`${table}.${column}`).toThrow('immutable_id_conflict');
   expect(()=>f.store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id)).toThrow('immutable_id_conflict');
   const insert=`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,values=columns.map(k=>row[k]);
   expect(()=>f.store.db.prepare(insert).run(...values)).not.toThrow();
   for(const column of columns.filter(c=>c!=='id')){
    const changed=columns.map(k=>k===column?(typeof row[k]==='number'?Number(row[k])+1:'example_only_changed'):row[k]);
    expect(()=>f.store.db.prepare(insert).run(...changed),`${table}.${column}`).toThrow('immutable_id_conflict');
   }
   expect(()=>f.store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET data='{}'`).run(...columns.map(k=>k==='data'?'"example_only_changed"':row[k]))).toThrow('immutable_id_conflict');
   expect(f.store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id)).toEqual(row);
  }
 }finally{f.close();}
});
