import type { Data, EngineDb, ServicePort, StoragePort } from './types';
import { stable } from './util';
export class SqliteStorage implements StoragePort {
  constructor(readonly store:EngineDb,readonly service?:ServicePort){}
  private insert(table:string,row:Data){const keys=Object.keys(row),allowed=new Set((this.store.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name));if(!keys.length||keys.some(k=>!allowed.has(k)))throw new Error('storage_column');this.store.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>{const v=row[k];return v===undefined||v===null?null:typeof v==='object'?stable(v):v as string|number;}));}
  capture(row:Data){this.insert('engine_captures',row);}
  extracted(row:Data){this.insert('engine_extracted',row);}
  label(row:Data){this.insert('engine_labels',row);}
  cached<T>(hash:string,stage:string,tool:string):T|undefined{const row=this.store.db.prepare('SELECT data FROM engine_cache WHERE content_hash=? AND stage=? AND tool=?').get(hash,stage,tool) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  cache(hash:string,stage:string,tool:string,data:unknown){this.store.db.prepare('INSERT OR IGNORE INTO engine_cache VALUES(?,?,?,?)').run(hash,stage,tool,stable(data));}
}
