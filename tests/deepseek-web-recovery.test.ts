import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { acquireWriter } from '../crawler/src/deepseek-web/writer-ownership';
import { emptyMemory, loadMemory, saveMemory } from '../crawler/src/deepseek-web/memory';
import { beginCycle, finalizeCycle, flushPendingAudit } from '../crawler/src/deepseek-web/budget-cycle';
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'ds-recovery-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const child = (mode: string, dir: string, point = '') => spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/deepseek-web-child.mjs', mode, dir, point], { cwd: process.cwd(), timeout: 10000, encoding: 'utf8' });
function ageOwner(dir: string) {
  const db = new DatabaseSync(join(dir, 'writer-ownership.sqlite'));
  const row = db.prepare('SELECT value FROM owner').get() as { value: string };
  const o = JSON.parse(row.value); o.started_at = new Date(Date.now() - 31000).toISOString();
  db.prepare('UPDATE owner SET value=?').run(JSON.stringify(o)); db.close();
}

test('the same daemon completes two ticks after a 410 and filters rediscovery before the listing limit', async () => {
  const dir = temp();
  const result = child('daemon-fetch-gone', dir);
  expect(result.status, result.stderr).toBe(0);
  const { pid, requests, ticks } = JSON.parse(result.stdout);
  expect(requests).toEqual([
    'https://09pangpang.com/robots.txt', 'https://09pangpang.com/post/900001',
    'https://shop.example/robots.txt', 'https://shop.example/deal',
    'https://09pangpang.com/robots.txt', 'https://09pangpang.com/',
  ]);
  expect(ticks).toHaveLength(2);
  expect(ticks[0]).toMatchObject({ pid, outcome: 'completed', deepseek_calls_attempted: 1, items_sent_to_review: 1, backoff: null });
  expect(ticks[1]).toMatchObject({ pid, outcome: 'completed', deepseek_calls_attempted: 0, listing_enqueued: 1, backoff: null });
  expect(ticks[0].cycle_id).not.toBe(ticks[1].cycle_id);
  const memory = await loadMemory(dir);
  expect(memory.gone_urls).toEqual({ 'https://09pangpang.com/post/900001': 410 });
  expect(memory.pending_urls).toEqual(['https://09pangpang.com/post/900002']);
  expect(Object.keys(memory.pending_catalog_meta)).toEqual(memory.pending_urls);
}, 15000);

test.each(['call_intent', 'model_responded', 'call_settled', 'terminal_checkpoint', 'lifetime_folded', 'audit_appended', 'audit_cleared'])('SIGKILL after %s preserves durable accounting exactly once', async point => {
  const dir = temp(), result = child('crash', dir, point);
  expect(result.signal, result.stderr).toBe('SIGKILL');
  const before = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  const originalId = before.active_cycle?.snapshot.cycle_id ?? before.finalized_cycle_id;
  expect(() => acquireWriter(dir)).toThrow('writer_busy');
  ageOwner(dir); // Clock injection for the production 30s grace; PM2 harness waits in real time.
  const first = child('recover', dir);
  expect(first.status, first.stderr).toBe(0);
  const expected = ['call_intent', 'model_responded'].includes(point) ? 0 : 15;
  const m = await loadMemory(dir);
  expect(m.lifetime.token_spent).toBe(expected);
  expect(m.pending_audit).toBeNull();
  const rows = readFileSync(join(dir, 'cycle-audit.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const original = rows.filter(r => r.cycle_id === originalId);
  expect(original).toHaveLength(1);
  if (point === 'call_intent' || point === 'model_responded') {
    expect(original[0].deepseek_tokens_used).toBeNull(); expect(original[0].usage_complete).toBe(false);
  } else expect(original[0].deepseek_tokens_reported).toBe(15);
  if (['call_intent', 'model_responded', 'call_settled'].includes(point)) {
    expect(original[0].outcome).toBe('interrupted'); expect(original[0].cycle_ended_at_kst).toBeNull(); expect(original[0].interruption_observed_at_kst).toMatch(/\+09:00$/); expect(original[0].counts_complete).toBe(false);
  }
  expect(child('recover', dir).status).toBe(0);
  expect((await loadMemory(dir)).lifetime.token_spent).toBe(expected);
  expect(readFileSync(join(dir, 'cycle-audit.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)).filter(r => r.cycle_id === originalId)).toHaveLength(1);
}, 15000);

test('audit replay repairs only a matching incomplete trailing append; conflicts fail closed', async () => {
  const dir = temp(), m = beginCycle(emptyMemory(), 'audit-test');
  await finalizeCycle(dir, m, { reason: null });
  const line = readFileSync(join(dir, 'cycle-audit.jsonl'), 'utf8');
  m.pending_audit = JSON.parse(line);
  writeFileSync(join(dir, 'cycle-audit.jsonl'), line.slice(0, -10));
  await flushPendingAudit(dir, m);
  expect(readFileSync(join(dir, 'cycle-audit.jsonl'), 'utf8')).toBe(line);
  m.pending_audit = { ...JSON.parse(line), cycle_token_spent: 99 };
  await expect(flushPendingAudit(dir, m)).rejects.toThrow('audit_conflict');
  writeFileSync(join(dir, 'cycle-audit.jsonl'), 'unrelated-incomplete');
  await expect(flushPendingAudit(dir, m)).rejects.toThrow('audit_conflict');
});

test('legacy v2 nonzero cycle requires an unambiguous matching lifetime audit', async () => {
  const dir = temp(), m = emptyMemory();
  const raw = { ...m, version: 2, cycle: { ...m.cycle, token_spent: 10, requests_spent: 1 } };
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(raw));
  await expect(loadMemory(dir)).rejects.toThrow('memory_unavailable');
  const row = { cycle_id: raw.cycle.cycle_id, cycle_token_spent: 10, cycle_requests: 1, lifetime_token_spent: 10, lifetime_cycles: 1 };
  writeFileSync(join(dir, 'cycle-audit.jsonl'), JSON.stringify(row) + '\n');
  await expect(loadMemory(dir)).rejects.toThrow('memory_unavailable');
  raw.lifetime = { token_spent: 10, requests: 1, cycles: 1, model_calls: 1 };
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(raw));
  const migrated = await loadMemory(dir); expect(migrated.version).toBe(5); expect(migrated.lifetime.token_spent).toBe(10); expect(migrated.cycle.token_spent).toBe(0);
  await saveMemory(dir, migrated);
});


test('status executable loads no SQLite/runtime store and writes nothing without credentials or DB', async () => {
  const dir = temp();
  const { initialReport } = await import('../crawler/src/deepseek-web/lifecycle');
  const { writeHeartbeat } = await import('../crawler/src/deepseek-web/heartbeat');
  const r = initialReport('once', Date.now()); r.cycle_interval_ms = 600000;
  await writeHeartbeat(dir, r);
  const before = readFileSync(join(dir, 'heartbeat.json'), 'utf8');
  chmodSync(dir, 0o500); chmodSync(join(dir, 'heartbeat.json'), 0o400);
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'crawler/deepseek-web/run.mjs', 'status', '--json'], { env: { NODE_ENV: 'test', PATH: process.env.PATH, DEEPSEEK_WEB_STATE_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).not.toContain('SQLite');
    expect(JSON.parse(result.stdout).freshness).toBe('fresh');
    expect(readdirSync(dir)).toEqual(['heartbeat.json']); expect(readFileSync(join(dir, 'heartbeat.json'), 'utf8')).toBe(before);
  } finally { chmodSync(dir, 0o700); }
});


test('CLI prints unsafe_state_path rather than the generic diagnostic', () => {
  const dir = temp(), target = join(dir, 'target');
  writeFileSync(target, 'preserve');
  symlinkSync(target, join(dir, 'heartbeat.json'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'crawler/deepseek-web/run.mjs', 'once', 'https://fixture.example/one'], { env: { NODE_ENV: 'test', PATH: process.env.PATH, DEEPSEEK_WEB_STATE_DIR: dir }, encoding: 'utf8', timeout: 15000 });
  expect(result.stderr.trim().split('\n').pop(), result.stderr).toBe('unsafe_state_path');
  expect(readFileSync(target, 'utf8')).toBe('preserve');
});

test('SIGKILL between backoff persistence and memory checkpoint preserves the retry deadline in heartbeat', async () => {
  const dir = temp();
  expect(child('crash-backoff', dir, 'backoff_persisted').signal).toBe('SIGKILL');
  const before = readFileSync(join(dir, 'backoff.json'), 'utf8'); ageOwner(dir);
  const recovered = child('recover', dir); expect(recovered.status, recovered.stderr).toBe(0);
  expect(readFileSync(join(dir, 'backoff.json'), 'utf8')).toBe(before);
  const h = JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
  expect(h.outcome).toBe('interrupted'); expect(h.backoff.reason).toBe('deepseek_insufficient_balance'); expect(h.backoff.state).toBe('scheduled');
  expect(h.deepseek_tokens_used).toBeNull();
});

test('a durable completion checkpoint clears unresolved backoff on recovery', async () => {
  const dir = temp();
  const { failBackoff } = await import('../crawler/src/deepseek-web/backoff');
  // A prior sequence is eligible; the child completes successfully and dies before the control clear.
  failBackoff(dir, null, 429, Date.now() - 3600001);
  expect(child('crash', dir, 'call_settled').signal).toBe('SIGKILL'); ageOwner(dir);
  const recovered = child('recover', dir); expect(recovered.status, recovered.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'backoff.json'), 'utf8'))).toBeNull();
  expect((await loadMemory(dir)).lifetime.token_spent).toBe(15);
});


test.each(['call_settled', 'cache_entry_written', 'cache_entry_temp_written', 'cache_index_published', 'review_delivered', 'proposal_delivered', 'receipt_cleared'])('result receipt survives SIGKILL at %s without a repeated provider call or delivery', async point => {
  const dir = temp(); expect(child('crash-result', dir, point).signal).toBe('SIGKILL'); ageOwner(dir);
  const first = child('recover-result', dir); expect(first.status, first.stderr).toBe(0);
  const second = child('recover-result', dir); expect(second.status, second.stderr).toBe(0);
  expect(readFileSync(join(dir, 'provider-calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(join(dir, 'review-queue.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readdirSync(join(dir, 'proposals'))).toHaveLength(1);
  const m = await loadMemory(dir); expect(m.pending_result).toBeNull(); expect(m.lifetime.token_spent).toBe(15);
  expect(m.observed_urls).toEqual(['https://fixture.example/crash']);
}, 15000);

test('a temp file stranded before rename is cleaned rather than bricking the cache', async () => {
  const dir = temp(); expect(child('crash-result', dir, 'cache_entry_temp_written').signal).toBe('SIGKILL'); ageOwner(dir);
  const entries = join(dir, 'extraction-cache', 'entries');
  expect(readdirSync(entries).filter(n => n.endsWith('.tmp'))).toHaveLength(1);
  const recovered = child('recover-result', dir); expect(recovered.status, recovered.stderr).toBe(0);
  expect(readdirSync(entries).filter(n => n.endsWith('.tmp'))).toHaveLength(0);
  expect(readFileSync(join(dir, 'provider-calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(join(dir, 'review-queue.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
}, 15000);
