import { expect, test, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CollectorError, CollectorStore } from '../crawler/src/store';
import { type RunLockOptions } from '../crawler/src/run-lock';
import { fixture } from './helpers/collector';

const boot='11111111-1111-1111-1111-111111111111',otherPid=2147483000;
const stat=(pid:number,ticks:string)=>`${pid} (fixture with ) spaces) ${Array.from({length:20},(_,i)=>i===19?ticks:'0').join(' ')}`;
const errno=(code:string)=>Object.assign(new Error('private error text'),{code});
function clock(f:ReturnType<typeof fixture>) {
  let mono=0;
  const checkPid=vi.fn<(pid:number)=>void>(()=>{});
  const options:RunLockOptions={
    wallNow:f.now,monotonicNow:()=>mono,checkPid,
    proc:path=>path.endsWith('boot_id')?boot:stat(process.pid,path===`/proc/${process.pid}/stat`?'11':'22'),
    sleep:vi.fn(async(ms:number)=>{
      expect(f.store.db.isTransaction).toBe(false);
      mono+=ms;f.advance(ms);
    }),
  };
  return {options,checkPid,advance:(ms:number)=>{mono+=ms;}};
}
function existing(f:ReturnType<typeof fixture>,at=f.now()-30_000) {
  const path=f.file+'.crawl.lock';
  const owner={pid:otherPid,start_ticks:'22',boot_id:boot,started_at:new Date(at).toISOString(),kind:'crawl',token:randomUUID()};
  const bytes=JSON.stringify(owner);writeFileSync(path,bytes,{mode:0o600});
  return {path,owner,bytes};
}

test('uncontended acquisition records PID, time and identity in a 0600 lock, then releases it',async()=>{
  const f=fixture(),c=clock(f),path=f.file+'.crawl.lock';
  try {
    const result=await f.store.waitForRunLock('crawl',c.options);
    expect(result).toMatchObject({acquired:true,attempts:1,waitedMs:0});
    expect(JSON.parse(readFileSync(path,'utf8'))).toMatchObject({pid:process.pid,started_at:new Date(f.now()).toISOString(),start_ticks:'11',boot_id:boot,kind:'crawl'});
    expect(statSync(path).mode&0o777).toBe(0o600);
    expect(c.options.sleep).not.toHaveBeenCalled();expect(c.checkPid).not.toHaveBeenCalled();
    f.store.close();expect(existsSync(path)).toBe(false);
  }finally{f.close();}
});

test('an old live owner survives all 21 attempts and the 2 second wait unchanged',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f),inode=statSync(lock.path).ino,listeners=process.listenerCount('exit');
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toEqual({acquired:false,reason:'run_locked',attempts:21,waitedMs:2000});
    expect(c.options.sleep).toHaveBeenCalledTimes(20);
    expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);expect(statSync(lock.path).ino).toBe(inode);
    expect(process.listenerCount('exit')).toBe(listeners);
    expect(readdirSync(f.dir).filter(name=>name.endsWith('.tmp'))).toEqual([]);
    f.store.close();expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);
  }finally{f.close();}
});

test('ESRCH permits reclaiming a lock at least 30 seconds old',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f);c.checkPid.mockImplementation(()=>{throw errno('ESRCH');});
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:true,attempts:1,waitedMs:0});
    expect(c.checkPid).toHaveBeenCalledWith(otherPid);
    const current=JSON.parse(readFileSync(lock.path,'utf8'));expect(current.pid).toBe(process.pid);expect(current.token).not.toBe(lock.owner.token);
    expect(statSync(lock.path).mode&0o777).toBe(0o600);
    f.store.close();expect(existsSync(lock.path)).toBe(false);
  }finally{f.close();}
});

test.each([1000,-60_000])('dead owners with age %i ms are preserved through the wait',async age=>{
  const f=fixture(),c=clock(f),lock=existing(f,f.now()-age);c.checkPid.mockImplementation(()=>{throw errno('ESRCH');});
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,reason:'run_locked',attempts:21});
    expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);
  }finally{f.close();}
});

test('a dead owner becomes reclaimable at the age boundary during the wait',async()=>{
  const f=fixture(),c=clock(f);existing(f,f.now()-29_900);c.checkPid.mockImplementation(()=>{throw errno('ESRCH');});
  try {expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:true,attempts:2,waitedMs:100});}
  finally{f.close();}
});

test.each(['EPERM','EACCES','unknown'])('PID inspection error %s never permits reclaiming even a reused PID',async code=>{
  const f=fixture(),c=clock(f),lock=existing(f);c.checkPid.mockImplementation(()=>{throw errno(code);});
  c.options.proc=path=>path.endsWith('boot_id')?boot:stat(process.pid,'99');
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,reason:'run_locked',attempts:21});
    expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);
  }finally{f.close();}
});

test('unavailable owner proc metadata preserves a live lock',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f),proc=c.options.proc!;
  c.options.proc=path=>{if(path===`/proc/${otherPid}/stat`)throw errno('EACCES');return proc(path);};
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,reason:'run_locked'});
    expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);
  }finally{f.close();}
});

test.each(['','{invalid private text','{}'])('unreadable owner metadata is preserved and skipped without raw diagnostics: %j',async bytes=>{
  const f=fixture(),c=clock(f),{path}=existing(f);writeFileSync(path,bytes);
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toEqual({acquired:false,reason:'run_lock_unreadable',attempts:1,waitedMs:0});
    expect(readFileSync(path,'utf8')).toBe(bytes);expect(c.options.sleep).not.toHaveBeenCalled();
  }finally{f.close();}
});

test('unverifiable new owner skips without publishing a lock',async()=>{
  const f=fixture(),c=clock(f);c.options.proc=()=>{throw errno('EACCES');};
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toEqual({acquired:false,reason:'run_lock_unverifiable',attempts:1,waitedMs:0});
    expect(existsSync(f.file+'.crawl.lock')).toBe(false);
  }finally{f.close();}
});

test('release during asynchronous sleep lets the next attempt acquire exactly once',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f),sleep=c.options.sleep!;
  c.options.sleep=async ms=>{await sleep(ms);unlinkSync(lock.path);};
  const task=vi.fn();
  try {
    const result=await f.store.waitForRunLock('crawl',c.options);if(result.acquired)task();
    expect(result).toMatchObject({acquired:true,attempts:2,waitedMs:100});expect(task).toHaveBeenCalledTimes(1);
    expect(c.checkPid).toHaveBeenCalledTimes(1);
  }finally{f.close();}
});

test('wall clock jumps do not extend the monotonic wait deadline',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f),sleep=c.options.sleep!;
  c.options.sleep=async ms=>{await sleep(ms);f.advance(-86400000);};
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,attempts:21,waitedMs:2000});
    expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);
  }finally{f.close();}
});

test('attempt limit still applies if the monotonic clock stalls',async()=>{
  const f=fixture(),c=clock(f);existing(f);c.options.monotonicNow=()=>0;
  try {expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,attempts:21,waitedMs:0});}
  finally{f.close();}
});

test('an overslept deadline does not start another attempt',async()=>{
  const f=fixture(),c=clock(f);existing(f);c.options.sleep=async()=>{c.advance(2050);};
  try {expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,attempts:1,waitedMs:2050});}
  finally{f.close();}
});

test('reclamation DB contention uses only the outer wait and restores the connection busy policy',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f),b=new CollectorStore(f.file,f.settings);
  c.checkPid.mockImplementation(()=>{throw errno('ESRCH');});
  b.db.exec('PRAGMA busy_timeout=1234');
  c.options.sleep=async ms=>{expect(b.db.isTransaction).toBe(false);expect(b.db.prepare('PRAGMA busy_timeout').get()).toMatchObject({timeout:1234});c.advance(ms);f.advance(ms);};
  try {
    f.store.db.exec('BEGIN IMMEDIATE');const begins=vi.spyOn(b.db,'exec');
    expect(await b.waitForRunLock('crawl',c.options)).toEqual({acquired:false,reason:'run_lock_busy',attempts:21,waitedMs:2000});
    expect(begins.mock.calls.filter(([sql])=>sql==='BEGIN IMMEDIATE')).toHaveLength(21);
    expect(readFileSync(lock.path,'utf8')).toBe(lock.bytes);
    expect(b.db.prepare('PRAGMA busy_timeout').get()).toMatchObject({timeout:1234});
    f.store.db.exec('ROLLBACK');
    b.transaction(()=>b.put('collector_meta','after_wait',true));expect(b.get('collector_meta','after_wait')).toBe(true);
    expect(await b.waitForRunLock('crawl',c.options)).toMatchObject({acquired:true,attempts:1});
  }finally{if(f.store.db.isTransaction)f.store.db.exec('ROLLBACK');b.close();f.close();}
});

test('reclamation re-reads a replacement owner before any deletion',async()=>{
  const f=fixture(),c=clock(f),lock=existing(f),replacement=JSON.stringify({...lock.owner,token:randomUUID()});
  c.checkPid.mockImplementationOnce(()=>{unlinkSync(lock.path);writeFileSync(lock.path,replacement,{mode:0o600});throw errno('ESRCH');});
  try {
    expect(await f.store.waitForRunLock('crawl',c.options)).toMatchObject({acquired:false,reason:'run_locked'});
    expect(readFileSync(lock.path,'utf8')).toBe(replacement);
    f.store.close();expect(readFileSync(lock.path,'utf8')).toBe(replacement);
  }finally{f.close();}
});

test('real DB faults remain failures and restore the busy timeout',async()=>{
  const f=fixture(),c=clock(f);existing(f);
  vi.spyOn(f.store,'transaction').mockImplementation(()=>{throw new CollectorError('database_corrupt',500);});
  try {
    await expect(f.store.waitForRunLock('crawl',c.options)).rejects.toThrow('database_corrupt');
    expect(f.store.db.prepare('PRAGMA busy_timeout').get()).toMatchObject({timeout:f.settings.busy_timeout_ms});
  }finally{f.close();}
});
