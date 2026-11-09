import { expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../crawler/src/source-policy';
import { main } from '../crawler/src/local-worker';
import { CollectorStore } from '../crawler/src/store';
import { JobEngine } from '../crawler/engine';
import { noop } from './helpers/engine';
test('offline CLI smoke finishes with disabled sources and status/failures/backfill stay local',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-cli-')),file=join(dir,'collector.sqlite'),cfg=join(dir,'config.json');
 const argv=process.argv;try{
  writeFileSync(cfg,JSON.stringify(config),{mode:0o600});vi.stubEnv('COLLECTOR_DB',file);vi.stubEnv('COLLECTOR_RAW_DIR',join(dir,'raw'));vi.stubEnv('COLLECTOR_CONFIG',cfg);
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  process.argv=['node','local-worker.ts','collect','--dry-run'];await main();expect(JSON.parse(log.mock.calls.at(-1)![0]).result).toMatchObject({dry_run:true,state:'finished',sources:[]});
  for(const command of ['engine-status','failures','backfill-engine','dedup-audit']){process.argv=['node','local-worker.ts',command];await main();}
  process.argv=['node','local-worker.ts','collect'];await main();expect(JSON.parse(log.mock.calls.at(-1)![0]).result.state).toBe('finished');
  const store=new CollectorStore(file);try{expect(store.db.prepare('SELECT * FROM engine_captures').all()).toEqual([]);expect(store.db.prepare('SELECT spent FROM engine_costs WHERE kind=?').all('requests').every(row=>row.spent===0)).toBe(true);}finally{store.close();}
 }finally{process.argv=argv;rmSync(dir,{recursive:true,force:true});}
});
test('persisted restriction returns exit 75 on the next collect without trying transport',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-cli-')),file=join(dir,'collector.sqlite');const argv=process.argv,exit=process.exitCode;
 try{
  vi.stubEnv('COLLECTOR_DB',file);vi.stubEnv('COLLECTOR_RAW_DIR',join(dir,'raw'));vi.stubEnv('COLLECTOR_CONFIG','');
  const store=new CollectorStore(file);try{
   const engine=new JobEngine(store,'agamajung',['fetch'],{fetch:noop()}),id=engine.startRun({kind:'test',at:'one'});engine.enqueue(id,'fetch','example-only');
   store.transaction(()=>{store.db.prepare("UPDATE engine_runs SET state='halted' WHERE id=?").run(id);store.put('domain_state','example.org',{stopped:true,next_at:0,reason:'access_restricted'});});
  }finally{store.close();}
  vi.spyOn(console,'log').mockImplementation(()=>{});process.argv=['node','local-worker.ts','collect'];await main();expect(process.exitCode).toBe(75);
 }finally{process.argv=argv;process.exitCode=exit;rmSync(dir,{recursive:true,force:true});}
});
test('engine commands reject repository-local storage before opening SQLite',async()=>{
 const argv=process.argv;try{
  vi.stubEnv('COLLECTOR_DB',join(process.cwd(),'crawler','engine-forbidden.sqlite'));vi.stubEnv('COLLECTOR_RAW_DIR',join(process.cwd(),'crawler','raw-forbidden'));vi.stubEnv('COLLECTOR_CONFIG','');
  process.argv=['node','local-worker.ts','collect','--dry-run'];await expect(main()).rejects.toThrow('unsafe_directory');
 }finally{process.argv=argv;}
});
