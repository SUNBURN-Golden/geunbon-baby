import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { acquireWriter } from '../crawler/src/deepseek-web/writer-ownership';
import type { RunLockOptions } from '../crawler/src/run-lock';
const dirs: string[] = [];
const boot = 'a8cbf183-9345-49c8-aeef-b099c1251f23', oldBoot = 'd617abb6-6219-437b-bf75-b71a8b8300d4';
const stat = (ticks: string, state = 'S') => `1 (with space ) here) ${state} ${Array(18).fill('0').join(' ')} ${ticks}`;
const now = Date.now();
function existing(change: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-owner-')); dirs.push(dir);
  acquireWriter(dir).release();
  const owner = { pid: 123456, start_ticks: '99', boot_id: boot, started_at: new Date(now - 31000).toISOString(), kind: 'crawl', token: randomUUID(), ...change };
  const db = new DatabaseSync(join(dir, 'writer-ownership.sqlite')); db.prepare('INSERT INTO owner(id,value) VALUES(1,?)').run(JSON.stringify(owner)); db.close();
  return dir;
}
const options = (extra: RunLockOptions = {}): RunLockOptions => ({ wallNow: () => now, proc: p => p.endsWith('boot_id') ? boot : stat('99'), checkPid: () => {}, ...extra });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test.each(['dead', 'pid_reused', 'previous_boot', 'zombie'])('reclaims demonstrably %s ownership after grace', kind => {
  const dir = existing(kind === 'previous_boot' ? { boot_id: oldBoot } : {});
  const lock = acquireWriter(dir, options({
    checkPid: () => { if (kind === 'dead') throw Object.assign(new Error(), { code: 'ESRCH' }); },
    proc: p => p.endsWith('boot_id') ? boot : stat(kind === 'pid_reused' ? '100' : '99', kind === 'zombie' ? 'Z' : 'S'),
  }));
  expect(lock.token).toBeTruthy(); lock.release();
});

test.each(['live', 'permission', 'unreadable', 'malformed', 'future', 'grace', 'unstable_zombie'])('fails closed for %s owner identity', kind => {
  const dir = existing(kind === 'malformed' ? { token: 'bad' } : kind === 'future' ? { started_at: new Date(now + 1000).toISOString() } : kind === 'grace' ? { started_at: new Date(now - 29999).toISOString() } : {});
  let reads = 0;
  expect(() => acquireWriter(dir, options({
    checkPid: () => { if (kind === 'permission') throw Object.assign(new Error(), { code: 'EPERM' }); if (['future', 'grace'].includes(kind)) throw Object.assign(new Error(), { code: 'ESRCH' }); },
    proc: p => {
      if (p.endsWith('boot_id')) return boot;
      if (p === `/proc/${process.pid}/stat`) return stat('99');
      if (kind === 'unreadable') throw Object.assign(new Error(), { code: 'EACCES' });
      return stat('99', kind === 'unstable_zombie' && reads++ === 0 ? 'Z' : 'S');
    },
  }))).toThrow(/writer_busy|writer_unavailable/);
});

test('a concurrent SQLite transaction maps to writer_busy, not writer_unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-owner-')); dirs.push(dir);
  acquireWriter(dir).release();
  const blocker = new DatabaseSync(join(dir, 'writer-ownership.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try {
    expect(() => acquireWriter(dir)).toThrow('writer_busy');
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  const lock = acquireWriter(dir); lock.release();
});

test('release removes only its own token, leaving replacements intact', () => {
  const dir = existing();
  const lock = acquireWriter(dir, options({ checkPid: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } }));
  const db = new DatabaseSync(join(dir, 'writer-ownership.sqlite'));
  const row = db.prepare('SELECT value FROM owner').get() as { value: string };
  const replacement = { ...JSON.parse(row.value), token: randomUUID() };
  db.prepare('UPDATE owner SET value=?').run(JSON.stringify(replacement));
  lock.release();
  expect((db.prepare('SELECT value FROM owner').get() as { value: string }).value).toBe(JSON.stringify(replacement));
  db.close();
  expect(readFileSync(join(dir, 'writer-ownership.sqlite')).length).toBeGreaterThan(0);
});
