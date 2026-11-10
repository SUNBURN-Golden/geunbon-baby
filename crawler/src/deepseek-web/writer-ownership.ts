import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ownerOf, processStartTicks, processState, type Owner, type RunLockOptions } from '../run-lock';
import { sqliteRuntimeSafe } from '../sqlite-runtime';
import { prepareStateDir, safePath } from './atomic-state';
export type WriterOwnership = { dir: string; token: string; release: () => void };
/** node:sqlite surfaces SQLITE_BUSY as errcode 5; also tolerate driver/message variants. */
const sqliteBusy = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { errcode?: number; code?: string | number; message?: string };
  return e.errcode === 5 || e.code === 'SQLITE_BUSY' || e.code === 5 || /SQLITE_BUSY|database is locked/i.test(e.message ?? '');
};
export function acquireWriter(dir: string, options: RunLockOptions = {}): WriterOwnership {
  const proc = options.proc ?? (path => readFileSync(path, 'utf8'));
  const now = options.wallNow ?? Date.now;
  const check = options.checkPid ?? (pid => { process.kill(pid, 0); });
  let db: DatabaseSync | undefined;
  try {
    if (!sqliteRuntimeSafe(process.versions.sqlite ?? 'unknown')) throw new Error();
    dir = prepareStateDir(dir);
    const path = safePath(join(dir, 'writer-ownership.sqlite'));
    for (const suffix of ['-journal', '-wal', '-shm']) safePath(path + suffix);
    const owner: Owner = { pid: process.pid, start_ticks: processStartTicks(proc(`/proc/${process.pid}/stat`)), boot_id: proc('/proc/sys/kernel/random/boot_id').trim(), started_at: new Date(now()).toISOString(), kind: 'crawl', token: randomUUID() };
    ownerOf(JSON.stringify(owner), 'crawl', path);
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT value FROM owner WHERE id=1').get() as { value: string } | undefined;
      if (row) {
        const old = ownerOf(row.value, 'crawl', path);
        const age = now() - Date.parse(old.started_at);
        if (!Number.isFinite(age) || age < 30000) throw new Error('writer_busy');
        let dead = false;
        try { check(old.pid); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('writer_busy');
          dead = true;
        }
        if (!dead && old.boot_id === owner.boot_id) {
          const stat = proc(`/proc/${old.pid}/stat`);
          if (processStartTicks(stat) === old.start_ticks) {
            if (processState(stat) !== 'Z') throw new Error('writer_busy');
            const again = proc(`/proc/${old.pid}/stat`);
            if (processStartTicks(again) !== old.start_ticks || processState(again) !== 'Z') throw new Error('writer_busy');
          }
        }
      }
      db.prepare('INSERT OR REPLACE INTO owner(id,value) VALUES(1,?)').run(JSON.stringify(owner));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const owned = db;
    return { dir, token: owner.token, release() {
      try {
        owned.exec('BEGIN IMMEDIATE');
        owned.prepare("DELETE FROM owner WHERE id=1 AND json_extract(value,'$.token')=?").run(owner.token);
        owned.exec('COMMIT');
      } finally { owned.close(); }
    } };
  } catch (e) {
    db?.close();
    if (e instanceof Error && e.message === 'writer_busy') throw e;
    // Another process holding the brief acquire/release transaction is contention,
    // not an unavailable writer.
    if (sqliteBusy(e)) throw new Error('writer_busy');
    throw new Error('writer_unavailable');
  }
}
