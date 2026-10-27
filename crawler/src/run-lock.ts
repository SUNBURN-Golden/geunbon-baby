import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { CollectorError, type CollectorStore } from './store';

export type RunKind = 'serve'|'crawl'|'sync';
export type ProcReader = (path: string) => string;
export type RunLock = { release: () => void };
type Owner = { pid: number; start_ticks: string; boot_id: string; started_at: string; kind: RunKind; token: string };
const readProc: ProcReader = path => readFileSync(path,'utf8');
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const uuid = (s: unknown): s is string => typeof s==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
export function processStartTicks(stat: string): string {
  // comm can contain whitespace and ')'; field 22 is index 19 after the last ')'.
  const value=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[19];
  if (!value || !/^\d+$/.test(value) || !stat.includes(')')) throw new Error('invalid_proc_stat');
  return value;
}
const sameFile = (a: {ino:number;dev:number}, b: {ino:number;dev:number}) => a.ino===b.ino && a.dev===b.dev;

function readLock(path: string) {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode&0o077)!==0) throw new CollectorError('unsafe_file',409);
  let fd: number;
  try { fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW); }
  catch(e) { if(code(e)==='ENOENT')return; if(code(e)==='ELOOP')throw new CollectorError('unsafe_file',409); throw e; }
  try {
    const opened=fstatSync(fd);
    if (!sameFile(stat,opened) || !opened.isFile() || (opened.mode&0o077)!==0) throw new CollectorError('unsafe_file',409);
    return {stat:opened, text:readFileSync(fd,'utf8')};
  } finally { closeSync(fd); }
}
function ownerOf(text: string, kind: RunKind, path: string): Owner {
  try {
    const o=JSON.parse(text) as Owner;
    if (!o || !Number.isSafeInteger(o.pid) || o.pid<1 || typeof o.start_ticks!=='string' || !/^\d+$/.test(o.start_ticks) || !uuid(o.boot_id) || !uuid(o.token) || o.kind!==kind || typeof o.started_at!=='string' || !Number.isFinite(Date.parse(o.started_at))) throw new Error('invalid');
    return o;
  } catch { throw new CollectorError('run_lock_unreadable',409,{kind,path}); }
}
// Only positive evidence of death permits reclamation. EPERM still means alive.
function dead(pid: number): boolean {
  try { process.kill(pid,0); return false; } catch(e) { return code(e)==='ESRCH'; }
}
function assertStale(owner: Owner, boot: string, proc: ProcReader) {
  if (owner.boot_id!==boot || dead(owner.pid)) return;
  let ticks: string;
  try { ticks=processStartTicks(proc(`/proc/${owner.pid}/stat`)); }
  catch {
    if (dead(owner.pid)) return;
    throw new CollectorError('run_locked',409,{kind:owner.kind,pid:owner.pid,started_at:owner.started_at,verify:'unavailable'});
  }
  if (ticks!==owner.start_ticks) return;
  throw new CollectorError('run_locked',409,{kind:owner.kind,pid:owner.pid,started_at:owner.started_at});
}

export function acquireRunLock(store: CollectorStore, kind: RunKind, proc: ProcReader = readProc): RunLock {
  const path=`${store.file}.${kind}.lock`;
  let owner: Owner;
  try {
    const boot_id=proc('/proc/sys/kernel/random/boot_id').trim();
    if (!uuid(boot_id)) throw new Error('invalid_boot_id');
    owner={pid:process.pid,start_ticks:processStartTicks(proc(`/proc/${process.pid}/stat`)),boot_id,started_at:new Date().toISOString(),kind,token:randomUUID()};
  } catch { throw new CollectorError('run_lock_unverifiable',500,{kind,path}); }
  const temporary=`${path}.${owner.token}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(owner)); fsyncSync(fd); }
  catch(e) { closeSync(fd); unlinkSync(temporary); throw e; }
  closeSync(fd);
  const link=() => { try { linkSync(temporary,path); return true; } catch(e) { if(code(e)==='EEXIST')return false; throw e; } };
  let acquired=false;
  const release=() => {
    // Never remove an unreadable, unsafe, or replaced lock during cleanup.
    try {
      const current=readLock(path);
      if (!current) return;
      const recorded=ownerOf(current.text,kind,path);
      if (recorded.token!==owner.token || recorded.pid!==owner.pid) return;
      const again=readLock(path);
      if (again && sameFile(current.stat,again.stat) && current.text===again.text) unlinkSync(path);
    } catch { /* Cleanup must not obscure the original failure. */ }
  };
  try {
    acquired=link();
    if (!acquired) store.transaction(()=>{
      for(let attempt=0;attempt<8;attempt++) {
        const current=readLock(path);
        if (!current) { if(link()) { acquired=true; return; } continue; }
        assertStale(ownerOf(current.text,kind,path),owner.boot_id,proc);
        const again=readLock(path);
        if (!again || !sameFile(current.stat,again.stat) || current.text!==again.text) continue;
        unlinkSync(path);
        // Another contender can link while holding no DB transaction. Re-read
        // its owner on EEXIST; never unlink it based on the previous snapshot.
        if (link()) { acquired=true; return; }
      }
      throw new CollectorError('run_locked',409,{kind,verify:'unavailable'});
    });
    return {release};
  } catch(e) { if(acquired)release(); throw e; }
  finally { unlinkSync(temporary); }
}
