import { afterEach, expect, test, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CollectorError, CollectorStore, type Group } from '../crawler/src/store';
import { config, validateConfig, type CollectorConfig } from '../crawler/src/source-policy';
import { sqliteRuntimeSafe } from '../crawler/src/sqlite-runtime';
import { processStartTicks } from '../crawler/src/run-lock';
import type { CollectionRecord } from '../shared/collection-schema';
import { PRIVACY_VERSION } from '../shared/privacy-rules';
import { collectorFailure } from '../crawler/src/local-worker';
import { binding, fixture, intake, price, ready, source } from './helpers/collector';

const directories: string[]=[];
const children: ReturnType<typeof spawn>[]=[];
afterEach(()=>{
  for(const child of children.splice(0)) if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
  for(const dir of directories.splice(0)) rmSync(dir,{recursive:true,force:true});
});
function location() { const dir=mkdtempSync(join(tmpdir(),'collector-concurrency-'));directories.push(dir);return {dir,file:join(dir,'collector.sqlite')}; }
const settings=()=>structuredClone({...config,sources:[source]});
const readProc=(path:string)=>readFileSync(path,'utf8');
function owner(pid=process.pid) {return {pid,start_ticks:processStartTicks(readProc(`/proc/${pid}/stat`)),boot_id:readProc('/proc/sys/kernel/random/boot_id').trim(),started_at:new Date().toISOString(),kind:'crawl',token:randomUUID()};}
function deadOwner() { const dead=spawnSync(process.execPath,['-e',''],{timeout:10000});expect(dead.status).toBe(0);return {...owner(),pid:dead.pid,started_at:new Date(Date.now()-30_000).toISOString()}; }
function caught(task:()=>unknown) { try { task();throw new Error('expected_failure'); } catch(e) { expect(e).toBeInstanceOf(CollectorError);return e as CollectorError; } }

type Message={ready?:boolean;ok?:boolean;pid?:number;code?:string;detail?:Record<string,string|number>;token?:string;locked?:boolean;reason?:string;attempts?:number};
// Every competing child announces readiness before waiting for the parent's go.
function worker(file:string,body:string,c:CollectorConfig=settings(),beforeReady='') {
  const script=`
    import { CollectorStore } from './crawler/src/store.ts';
    import { readFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const file=process.env.COLLECTOR_TEST_DB, settings=JSON.parse(process.env.COLLECTOR_TEST_CONFIG);
    const input=createInterface({input:process.stdin})[Symbol.asyncIterator]();
    const wait=async()=>{if((await input.next()).done)throw new Error('stdin_closed');};
    const send=value=>console.log(JSON.stringify(value));
    let store;
    try { ${beforeReady} send({ready:true,pid:process.pid});await wait();${body} }
    catch(error){send({ok:false,code:error.code??error.message,detail:error.detail});}
    finally {store?.close();process.exit(0);}
  `;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...process.env,COLLECTOR_TEST_DB:file,COLLECTOR_TEST_CONFIG:JSON.stringify(c)},stdio:['pipe','pipe','pipe']});
  children.push(child);
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const lines=createInterface({input:child.stdout!})[Symbol.asyncIterator]();
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>{clearTimeout(timer);if(status===0||signal==='SIGKILL')resolve();else reject(new Error(`child_exit ${status}: ${stderr}`));});});
  return {child,exited,go:()=>child.stdin!.write('go\n'),next:async():Promise<Message>=>{const line=await lines.next();if(line.done)throw new Error(`child_missing_result: ${stderr}`);return JSON.parse(line.value);}};
}
async function pair(file:string,body:string,c=settings()) {
  const workers=[worker(file,body,c),worker(file,body,c)];
  expect(await Promise.all(workers.map(w=>w.next()))).toEqual(workers.map(w=>({ready:true,pid:w.child.pid})));
  workers.forEach(w=>w.go());return workers;
}
function integrity(store:CollectorStore) {
  expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:8});
  expect(store.db.prepare('PRAGMA quick_check').get()).toMatchObject({quick_check:'ok'});
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

test('two stores read and write the same WAL DB, including reserve/start/submit and another process',async()=>{
  const f=fixture(),b=new CollectorStore(f.file,f.settings);
  try {
    f.store.runLock('serve');b.runLock('crawl');
    f.store.discover(`${source.origin}/one`);b.discover(`${source.origin}/two`);
    expect(f.store.report().total).toBe(2);expect(b.report().total).toBe(2);
    const reservation=f.store.reserve('fixture-client',binding());
    b.discover(`${source.origin}/three`);f.store.start('fixture-client',reservation.id);
    b.discover(`${source.origin}/four`);f.store.submit('fixture-client',reservation.id,price());
    const child=worker(f.file,`store=new CollectorStore(file,settings);store.discover('${source.origin}/child');send({ok:true});`);
    await child.next();child.go();expect(await child.next()).toEqual({ok:true});await child.exited;
    expect(b.report().total).toBe(6);integrity(b);
  } finally {b.close();f.close();}
});

test('two processes initialize a fresh DB together',async()=>{
  const {file}=location();
  const workers=await pair(file,'store=new CollectorStore(file,settings);send({ok:true});');
  expect(await Promise.all(workers.map(w=>w.next()))).toEqual([{ok:true},{ok:true}]);await Promise.all(workers.map(w=>w.exited));
  const store=new CollectorStore(file);try{integrity(store);}finally{store.close();}
});

test.each(['dead_pid','reused_pid','old_boot'])('reclaims only a proven stale owner: %s',reason=>{
  const {file}=location(),store=new CollectorStore(file);const path=file+'.crawl.lock';
  try {
    const stale=reason==='dead_pid'?deadOwner():owner();
    if(reason==='reused_pid')stale.start_ticks=String(BigInt(stale.start_ticks)+1n);
    if(reason==='old_boot')stale.boot_id=randomUUID();
    writeFileSync(path,JSON.stringify(stale),{mode:0o600});
    store.runLock('crawl',{wallNow:()=>Date.parse(stale.started_at)+30_000});const current=JSON.parse(readFileSync(path,'utf8'));
    expect(current.pid).toBe(process.pid);expect(current.token).not.toBe(stale.token);expect(statSync(path).mode&0o777).toBe(0o600);
  }finally{store.close();}
  expect(existsSync(path)).toBe(false);
});

test('two reclaimers never remove the winning lock (20 synchronized races)',async()=>{
  const {file}=location(),initial=new CollectorStore(file);initial.close();const stale=deadOwner();
  for(let iteration=0;iteration<20;iteration++) {
    writeFileSync(file+'.crawl.lock',JSON.stringify(stale),{mode:0o600});
    const workers=await pair(file,`store=new CollectorStore(file,settings);
      let mono=0;
      const result=await store.waitForRunLock('crawl',{monotonicNow:()=>mono,sleep:async ms=>{mono+=ms;await new Promise(resolve=>setImmediate(resolve));}});
      if(result.acquired){send({ok:true,pid:process.pid,token:JSON.parse(readFileSync(file+'.crawl.lock','utf8')).token});await wait();}
      else send({ok:false,reason:result.reason,attempts:result.attempts});`);
    const results=await Promise.all(workers.map(w=>w.next()));
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    const winner=results.findIndex(r=>r.ok),loser=1-winner;
    expect(results[loser]).toMatchObject({ok:false,attempts:21});
    // With an injected clock the loser may exhaust its wait before the winner
    // commits the reclaim transaction, especially under full-suite load.
    expect(['run_locked','run_lock_busy']).toContain(results[loser].reason);
    await workers[loser].exited;
    expect(JSON.parse(readFileSync(file+'.crawl.lock','utf8')).token).toBe(results[winner].token);
    workers[winner].go();await workers[winner].exited;expect(existsSync(file+'.crawl.lock')).toBe(false);
  }
},120000);

test('live PID, duplicate kind, and unverifiable live owner remain untouched',async()=>{
  const {file}=location(),store=new CollectorStore(file);
  const child=worker(file,'await wait();');await child.next();child.go();
  try {
    const live=owner(child.child.pid!),path=file+'.crawl.lock',bytes=JSON.stringify(live);
    writeFileSync(path,bytes,{mode:0o600});
    expect(caught(()=>store.runLock('crawl'))).toMatchObject({code:'run_locked',detail:{kind:'crawl',pid:live.pid,started_at:live.started_at}});
    const denied=(path:string)=>{if(path===`/proc/${live.pid}/stat`)throw Object.assign(new Error(),{code:'EACCES'});return readProc(path);};
    expect(caught(()=>store.runLock('crawl',denied))).toMatchObject({code:'run_locked',detail:{verify:'unavailable'}});
    expect(readFileSync(path,'utf8')).toBe(bytes);
    writeFileSync(path,JSON.stringify({...live,start_ticks:String(BigInt(live.start_ticks)+1n)}));
    store.runLock('crawl',{wallNow:()=>Date.parse(live.started_at)+30_000});expect(JSON.parse(readFileSync(path,'utf8')).pid).toBe(process.pid);store.runLock('serve');
    expect(caught(()=>store.runLock('crawl'))).toMatchObject({code:'run_locked',detail:{pid:process.pid}});
    expect(caught(()=>store.runLock('sync',()=>{throw new Error('no_proc');}))).toMatchObject({code:'run_lock_unverifiable'});
    expect(existsSync(file+'.sync.lock')).toBe(false);
  }finally{child.go();await child.exited;store.close();}
});

test.each(['symlink','permissions'])('rejects unsafe execution lock: %s',kind=>{
  const {file}=location(),store=new CollectorStore(file),path=file+'.crawl.lock';
  try {
    if(kind==='symlink')symlinkSync(file,path);else {writeFileSync(path,JSON.stringify(owner()),{mode:0o600});chmodSync(path,0o644);}
    expect(()=>store.runLock('crawl')).toThrow('unsafe_file');expect(existsSync(path)).toBe(true);
  }finally{store.close();}
});

test('busy timeout and bounded retries leave no partial write or task invocation',()=>{
  const {file}=location(),c={...settings(),busy_timeout_ms:200,busy_retries:2};
  const a=new CollectorStore(file,c),b=new CollectorStore(file,c);let calls=0,commits=0;
  try {
    const counted=new CollectorStore(file,c,Date.now,point=>{if(point==='before_commit')commits++;});
    try {
      commits=0;a.db.exec('BEGIN IMMEDIATE');const begins=vi.spyOn(counted.db,'exec');const start=performance.now();
      expect(caught(()=>counted.transaction(()=>{calls++;counted.put('collector_meta','partial',true);}))).toMatchObject({code:'database_busy',status:503});
      const elapsed=performance.now()-start;expect(elapsed).toBeGreaterThanOrEqual(0.9*200*3);expect(elapsed).toBeLessThanOrEqual(200*3+2*250+1500);
      expect(calls).toBe(0);expect(commits).toBe(0);expect(begins.mock.calls.filter(([sql])=>sql==='BEGIN IMMEDIATE')).toHaveLength(3);expect(counted.get('collector_meta','partial')).toBeUndefined();
      expect(caught(()=>b.discover(`${source.origin}/blocked`))).toMatchObject({code:'database_busy'});expect(b.db.prepare('SELECT count(*) n FROM collection_records').get()).toMatchObject({n:0});
      a.db.exec('COMMIT');b.discover(`${source.origin}/success`);expect(a.report().total).toBe(1);
    }finally{counted.close();}
  }finally{if(a.db.isTransaction)a.db.exec('ROLLBACK');b.close();a.close();}
});

test('BEGIN retries succeed after another process releases; task and commit hook execute once',async()=>{
  const {file}=location(),c={...settings(),busy_timeout_ms:100,busy_retries:5};let calls=0,commits=0;
  const store=new CollectorStore(file,c,Date.now,point=>{if(point==='before_commit')commits++;});
  try {
    const child=worker(file,"store.db.exec('BEGIN IMMEDIATE');send({locked:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);store.db.exec('COMMIT');send({ok:true});",c,'store=new CollectorStore(file,settings);');
    await child.next();child.go();expect(await child.next()).toEqual({locked:true});commits=0;const begins=vi.spyOn(store.db,'exec');
    store.transaction(()=>{calls++;store.put('collector_meta','marker',true);});
    expect(calls).toBe(1);expect(commits).toBe(1);expect(begins.mock.calls.filter(([sql])=>sql==='BEGIN IMMEDIATE').length).toBeGreaterThan(1);expect(store.get('collector_meta','marker')).toBe(true);
    expect(await child.next()).toEqual({ok:true});await child.exited;
  }finally{store.close();}
});

test.each(['body','commit'])('BUSY in %s rolls back without repeating the body',stage=>{
  const {file}=location();let active=false,calls=0,hooks=0;
  const store=new CollectorStore(file,settings(),Date.now,point=>{if(active&&point==='before_commit')hooks++;});
  const exec=store.db.exec.bind(store.db);
  vi.spyOn(store.db,'exec').mockImplementation(sql=>{if(active&&stage==='commit'&&sql==='COMMIT')throw Object.assign(new Error('SQLITE_BUSY'),{errcode:5});return exec(sql);});
  try {active=true;expect(caught(()=>store.transaction(()=>{calls++;store.put('collector_meta','partial',true);if(stage==='body')throw Object.assign(new Error('database is locked'),{errcode:261});}))).toMatchObject({code:'database_busy'});expect(calls).toBe(1);expect(hooks).toBe(stage==='commit'?1:0);expect(store.get('collector_meta','partial')).toBeUndefined();}
  finally{store.close();}
});

test('legacy empty DB lock is ignored and warned once; unreadable run locks are preserved',()=>{
  const {file}=location(),legacy=file+'.lock';writeFileSync(legacy,'',{mode:0o600});
  const warning=vi.spyOn(console,'error').mockImplementation(()=>{}),store=new CollectorStore(file);
  try {
    expect(warning.mock.calls).toEqual([['collector_warning legacy_lock_present']]);
    for(const text of ['', '{invalid', '{}', JSON.stringify({...owner(),pid:0})]) {
      writeFileSync(file+'.crawl.lock',text,{mode:0o600});
      expect(caught(()=>store.runLock('crawl'))).toMatchObject({code:'run_lock_unreadable',detail:{kind:'crawl',path:file+'.crawl.lock'}});
      expect(readFileSync(file+'.crawl.lock','utf8')).toBe(text);
    }
  }finally{store.close();}
  expect(readFileSync(legacy,'utf8')).toBe('');
});

test('SIGKILL leaves committed data and a recoverable execution lock',async()=>{
  const {file}=location();
  const child=worker(file,"store=new CollectorStore(file,settings);store.runLock('crawl');store.discover('https://gear.example.org/committed');send({ok:true});await wait();");
  await child.next();child.go();expect(await child.next()).toEqual({ok:true});child.child.kill('SIGKILL');await child.exited;
  expect(existsSync(file+'.crawl.lock')).toBe(true);
  const killed=JSON.parse(readFileSync(file+'.crawl.lock','utf8'));
  const store=new CollectorStore(file);try{store.runLock('crawl',{wallNow:()=>Date.parse(killed.started_at)+30_000});expect(store.report().total).toBe(1);integrity(store);}finally{store.close();}
  expect(existsSync(file+'.crawl.lock')).toBe(false);
});

test('normal exit releases locks without close; close never deletes a replacement owner',async()=>{
  const {file}=location();
  const child=worker(file,"store=new CollectorStore(file,settings);store.runLock('crawl');send({ok:true});process.exit(0);");await child.next();child.go();expect(await child.next()).toEqual({ok:true});await child.exited;
  expect(existsSync(file+'.crawl.lock')).toBe(false);
  const store=new CollectorStore(file);store.runLock('crawl');const replacement={...owner(),token:randomUUID()};
  writeFileSync(file+'.crawl.lock',JSON.stringify(replacement));store.close();
  expect(JSON.parse(readFileSync(file+'.crawl.lock','utf8'))).toEqual(replacement);
});

test.each([false,true])('failed stale acquisition releases only its own lock (replaced=%s)',replaced=>{
  const {file,dir}=location(),path=file+'.crawl.lock';let fail=false;
  const replacement={...owner(),token:randomUUID()};
  const store=new CollectorStore(file,settings(),Date.now,point=>{
    if(fail&&point==='before_commit') {if(replaced)writeFileSync(path,JSON.stringify(replacement));throw new Error('commit_fault');}
  });
  try {
    writeFileSync(path,JSON.stringify(deadOwner()),{mode:0o600});fail=true;
    expect(()=>store.runLock('crawl')).toThrow('commit_fault');
    expect(existsSync(path)).toBe(replaced);
    if(replaced)expect(JSON.parse(readFileSync(path,'utf8'))).toEqual(replacement);
    else {fail=false;store.runLock('crawl');}
    expect(readdirSync(dir).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  }finally{store.close();}
});

test('discover CLI coexists with serve and reports a duplicate crawl owner',()=>{
  const {file,dir}=location(),store=new CollectorStore(file,settings()),cfg=join(dir,'config.json');
  writeFileSync(cfg,JSON.stringify({...settings(),sources:[]}),{mode:0o600});
  const run=()=>spawnSync(process.execPath,['--import','tsx','crawler/local-worker.mjs','discover','--dry-run'],{env:{...process.env,COLLECTOR_DB:file,COLLECTOR_CONFIG:cfg,COLLECTOR_TRUSTED_EGRESS_CIDRS:''},encoding:'utf8',timeout:10000});
  try {
    store.runLock('serve');const allowed=run();expect(allowed.status).toBe(0);expect(JSON.parse(allowed.stdout.trim().split('\n').at(-1)!)).toMatchObject({outcome:'dry_run',result:{dry_run:true}});
    store.runLock('crawl');const blocked=run();expect(blocked.status).toBe(0);expect(JSON.parse(blocked.stdout.trim().split('\n').at(-1)!)).toMatchObject({outcome:'skipped',reason:'run_locked'});
    expect(blocked.stderr.match(/^collector_(?:start|end) .+$/gm)).toHaveLength(2);
    expect(blocked.stderr).toMatch(/collector_end .+ job=discover .+ outcome=skipped reason=run_locked/);
    expect(JSON.parse(readFileSync(file+'.crawl.lock','utf8')).pid).toBe(process.pid);
  }finally{store.close();}
},25000);

test.each([
  ['serve','serve'],['discover','crawl'],['collect','crawl'],['discover-sources','crawl'],
  ['explore-missing','crawl'],['explore-missing-fields','crawl'],['failures','crawl'],['sync','sync'],
] as const)('duplicate %s CLI skips once with exit 0 and no runner output or transport', (command,kind)=>{
  const {file,dir}=location(),store=new CollectorStore(file,settings()),cfg=join(dir,'config.json');
  writeFileSync(cfg,JSON.stringify({...settings(),sources:[]}),{mode:0o600});
  // Child processes do not inherit Vitest's transport mocks. Fail if they try
  // to create an intake server, collect a page, or send a status snapshot.
  const guard='data:text/javascript,'+encodeURIComponent(`
    import http from 'node:http';import https from 'node:https';import net from 'node:net';
    import {syncBuiltinESMExports} from 'node:module';
    const denied=()=>{throw new Error('transport_forbidden');};
    http.createServer=denied;http.request=denied;https.request=denied;net.Socket.prototype.connect=denied;
    globalThis.fetch=denied;syncBuiltinESMExports();
  `);
  try {
    store.runLock(kind);const path=`${file}.${kind}.lock`,bytes=readFileSync(path,'utf8');
    const args=command==='failures'?['failures','retry','unused']: [command,'--dry-run'];
    const result=spawnSync(process.execPath,['--import',guard,'--import','tsx','crawler/local-worker.mjs',...args],{
      env:{...process.env,COLLECTOR_DB:file,COLLECTOR_CONFIG:cfg,COLLECTOR_RAW_DIR:join(dir,'raw'),COLLECTOR_TRUSTED_EGRESS_CIDRS:'',
        COLLECTOR_INTAKE_TOKEN:'fixture-intake-token-123456789',COLLECTOR_REVIEW_TOKEN:'fixture-review-token-123456789',
        COLLECTOR_EXTENSION_ORIGIN:`chrome-extension://${'a'.repeat(32)}`,COLLECTOR_SITE_URL:'',COLLECTOR_STATUS_TOKEN:''},
      encoding:'utf8',timeout:10000,
    });
    expect(result.status,result.stderr).toBe(0);
    if(['serve','discover','collect','discover-sources'].includes(command))expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({outcome:'skipped',reason:'run_locked'});else expect(result.stdout).toBe('');
    const lines=result.stderr.split('\n').filter(line=>line.startsWith('collector_'));
    if(['discover','collect','discover-sources'].includes(command)){
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(new RegExp(`^collector_start at=.+\\+09:00 job=${command} `));
      expect(lines[1]).toMatch(/outcome=skipped reason=run_locked$/);
    }else{
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^collector_skipped command=${command==='explore-missing-fields'?'explore-missing':command} reason=run_locked kind=${kind} attempts=\\d+ waited_ms=\\d+$`));
    }
    expect(readFileSync(path,'utf8')).toBe(bytes);
    expect(store.db.prepare('SELECT count(*) n FROM engine_runs').get()).toMatchObject({n:0});
  }finally{store.close();}
});

test.each(['unreadable','unsafe'])('CLI preserves %s lock metadata and logs only a fixed reason',kind=>{
  const {file,dir}=location(),store=new CollectorStore(file,settings()),cfg=join(dir,'config.json'),path=file+'.crawl.lock';
  writeFileSync(cfg,JSON.stringify({...settings(),sources:[]}),{mode:0o600});
  const bytes=kind==='unreadable'?'{private-metadata-never-print':JSON.stringify(owner());
  writeFileSync(path,bytes,{mode:0o600});if(kind==='unsafe')chmodSync(path,0o644);
  try {
    const result=spawnSync(process.execPath,['--import','tsx','crawler/local-worker.mjs','discover','--dry-run'],{
      env:{...process.env,COLLECTOR_DB:file,COLLECTOR_CONFIG:cfg,COLLECTOR_TRUSTED_EGRESS_CIDRS:''},encoding:'utf8',timeout:10000,
    });
    expect(result.status).toBe(kind==='unreadable'?0:1);expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({outcome:kind==='unreadable'?'skipped':'failed',reason:kind==='unreadable'?'run_lock_unreadable':'lock_error'});
    expect(result.stderr).toContain(kind==='unreadable'?'outcome=skipped reason=run_lock_unreadable':'outcome=failed reason=lock_error');
    expect(result.stderr).not.toContain(bytes);expect(result.stderr).not.toContain(file);expect(readFileSync(path,'utf8')).toBe(bytes);
  }finally{store.close();}
});

test.each(['3.50.4','3.51.2','3.44.5','3.45.9','3.49.9','unknown','3.51.3-extra'])('unsafe SQLite %s is refused before creating a DB',version=>{
  const {file}=location();expect(sqliteRuntimeSafe(version)).toBe(false);
  expect(caught(()=>new CollectorStore(file,settings(),Date.now,()=>{},version))).toMatchObject({code:'sqlite_runtime_unsafe',detail:{sqlite:version,node:process.versions.node}});
  expect(existsSync(file)).toBe(false);
});
test.each(['3.44.6','3.44.7','3.50.7','3.50.8','3.51.3','3.52.0','4.0.0'])('fixed SQLite %s is safe',version=>expect(sqliteRuntimeSafe(version)).toBe(true));
test('the pinned test runtime includes the WAL-reset fix',()=>expect(sqliteRuntimeSafe(process.versions.sqlite!)).toBe(true));

test.each(['disappears','symlink'])('auxiliary file %s between enumeration and lstat',kind=>{
  const {file}=location();writeFileSync(file+'-wal','',{mode:0o600});
  const open=()=>new CollectorStore(file,settings(),Date.now,point=>{if(point==='aux_check:-wal'){unlinkSync(file+'-wal');if(kind==='symlink')symlinkSync(file,file+'-wal');}});
  if(kind==='symlink')expect(open).toThrow('unsafe_file');else {const store=open();store.close();}
});

test('last-connection auxiliary cleanup races tolerate 200 opens per process',async()=>{
  const {file}=location();const initial=new CollectorStore(file);initial.close();
  const child=worker(file,'for(let i=0;i<200;i++){store=new CollectorStore(file,settings);store.close();}send({ok:true});');
  await child.next();child.go();
  for(let i=0;i<200;i++){const store=new CollectorStore(file);store.close();}
  expect(await child.next()).toEqual({ok:true});await child.exited;
},20000);

test('two processes migrate v2 together, preserving data and all schema objects',async()=>{
  const {file,dir}=location(),db=new DatabaseSync(file);
  for(const name of ['0001_collection.sql','0002_lookup_indexes.sql'])db.exec(readFileSync(new URL(`../crawler/migrations/${name}`,import.meta.url),'utf8'));
  db.exec(`INSERT INTO collector_meta VALUES ('legacy_marker','{"records":518}');`);
  for(let i=0;i<3;i++) {
    const id=randomUUID(),groupId=randomUUID(),url=`${source.origin}/legacy-${i}`;
    const group:Group={id:groupId,key:`url:${url}`,representative:id,group_version:0,evidence_version:0,review_scope_digest:'',verified_evidence_version:null,ready_evidence_version:null,lineage:[]};
    const record:CollectionRecord={id,url,title:null,source:'fixture',published_at:null,collected_at:'2026-10-01T00:00:00Z',target_model_id:null,extracted_facts:{},evidence_locator:[],dedup_group_id:groupId,verification_status:'discovered',collection_method:'auto_discovery',schema_version:1,record_version:1,privacy_filter_version:PRIVACY_VERSION,conflict_detected:false,last_checked_at:null,next_recheck_at:null};
    db.prepare('INSERT INTO dedup_groups VALUES (?,?)').run(groupId,JSON.stringify(group));
    db.prepare('INSERT INTO collection_records VALUES (?,?,?,?,?)').run(id,url,groupId,'discovered',JSON.stringify(record));
  }
  const baseline=db.prepare('SELECT * FROM collection_records ORDER BY id').all();db.close();
  const migration=readFileSync(new URL('../crawler/migrations/0003_engine.sql',import.meta.url),'utf8');
  const objects=[...migration.matchAll(/CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS (engine_\w+)/g)].map(m=>({type:m[1].toLowerCase(),name:m[2]}));
  const workers=await pair(file,'store=new CollectorStore(file,settings);send({ok:true});');expect(await Promise.all(workers.map(w=>w.next()))).toEqual([{ok:true},{ok:true}]);await Promise.all(workers.map(w=>w.exited));
  const store=new CollectorStore(file);try {
    integrity(store);expect(store.db.prepare('SELECT * FROM collection_records ORDER BY id').all()).toEqual(baseline.map(row=>({...row,data:JSON.stringify({...JSON.parse(String(row.data)),record_version:2,identity_quarantined:true})})));expect(store.get('collector_meta','legacy_marker')).toEqual({records:518});
    for(const object of objects)expect(store.db.prepare('SELECT count(*) n FROM sqlite_master WHERE type=? AND name=?').get(object.type,object.name)).toMatchObject({n:1});
    expect(readdirSync(dir).filter(n=>n.includes('.pre-0003-')).length).toBeGreaterThanOrEqual(1);expect(readdirSync(dir).filter(n=>n.includes('.pre-0003-')).length).toBeLessThanOrEqual(2);
  }finally{store.close();}
});

test('concurrent policy changes invalidate each approved group exactly once',async()=>{
  const {file}=location(),c=settings(),store=new CollectorStore(file,c);
  const baseline:Group[]=[];
  try {
    for(let i=0;i<3;i++) {const receipt=intake(store,`${source.origin}/policy-${i}`,{...price(),target_model_id:`policy-model-${i}`});const group=store.recordByUrl(`${source.origin}/policy-${i}`)!.dedup_group_id;expect(receipt.record_id).toBeTruthy();ready(store,group);baseline.push(store.scope(group).group);}
    expect(new Set(baseline.map(g=>g.id)).size).toBe(3);
  }finally{store.close();}
  const workers=await pair(file,'store=new CollectorStore(file,settings);send({ok:true});',{...c,policy_version:2});
  expect(await Promise.all(workers.map(w=>w.next()))).toEqual([{ok:true},{ok:true}]);await Promise.all(workers.map(w=>w.exited));
  const check=new CollectorStore(file,{...c,policy_version:2});try{
    for(const group of baseline) {
      expect(check.scope(group.id).group.group_version).toBe(group.group_version+1);
      expect(check.db.prepare("SELECT count(*) n FROM review_events WHERE json_extract(data,'$.reason')='policy_changed' AND json_extract(data,'$.group_id')=?").get(group.id)).toMatchObject({n:1});
    }
    expect(check.get('collector_meta','policy')).toBe(2);
  }finally{check.close();}
});

test('busy settings default for old config and validate integer bounds',()=>{
  const old=settings();delete (old as Partial<CollectorConfig>).busy_timeout_ms;delete (old as Partial<CollectorConfig>).busy_retries;
  expect(validateConfig(old)).toMatchObject({busy_timeout_ms:5000,busy_retries:3});
  for(const [key,values] of Object.entries({busy_timeout_ms:[99,600001,100.5],busy_retries:[-1,11,1.5]}))for(const value of values)expect(()=>validateConfig({...settings(),[key]:value})).toThrow('invalid_config');
});

test('failure diagnostics include only approved fields and a basename',()=>{
  expect(collectorFailure(new CollectorError('run_locked',409,{kind:'crawl',pid:123,started_at:'2026-10-27T00:00:00Z',path:'/private/collector.sqlite.crawl.lock',token:'never_print',payload:'never_print'}))).toBe('collector_failed code=run_locked kind=crawl pid=123 started_at=2026-10-27T00:00:00Z path=collector.sqlite.crawl.lock');
  expect(collectorFailure(new Error('never_print'))).toBe('collector_failed code=internal_error');
});
