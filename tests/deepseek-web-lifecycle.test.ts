import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, readdir, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './helpers/collector';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { deepSeekWebCli } from '../crawler/src/deepseek-web/cli';
import { DeepSeekHttpError, createDeepSeekClient, usageFrom } from '../crawler/src/deepseek-web/client';
import { backoffDelay, failBackoff, readBackoff } from '../crawler/src/deepseek-web/backoff';
import { heartbeatStatus, readHeartbeat, writeHeartbeat } from '../crawler/src/deepseek-web/heartbeat';
import { initialReport } from '../crawler/src/deepseek-web/lifecycle';
import { acquireWriter } from '../crawler/src/deepseek-web/writer-ownership';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { EMERGENCY_STOP_META_ID } from '../crawler/src/deepseek-web/domain-policy';
const dirs: string[] = [];
const fixtures: ReturnType<typeof fixture>[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'ds-lifecycle-')); dirs.push(dir); return dir; };
const db = () => { const f = fixture(); fixtures.push(f); return f.store; };
afterEach(async () => { for (const f of fixtures.splice(0)) f.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const urls = ['https://fixture.example/one', 'https://fixture.example/two'];
const completion = (tokens: number | null = 15) => ({ content: '{"brand":"A","model":"B","category":"정보 없음","gonggu_price":"정보 없음","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":false}', usage: { prompt_tokens: null, completion_tokens: null, total_tokens: tokens }, model: 'deepseek-chat' });

test('402 → 402 → 429 → success persists capped backoff and once returns without DB or network', async () => {
  const dir = await temp(), store = db();
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  const complete = vi.fn();
  for (const [index, status] of [402, 402, 429, 429, 402].entries()) {
    complete.mockRejectedValueOnce(new DeepSeekHttpError(status));
    const report = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls, now: () => now, client: { complete } });
    expect(report.outcome).toBe('backoff');
    expect(report.deepseek_calls_attempted).toBe(1);
    expect(report.deepseek_tokens_used).toBeNull();
    const control = readBackoff(dir)!;
    expect(control.failures).toBe(index + 1);
    expect(Date.parse(control.next_attempt_at) - now).toBe([1, 2, 4, 6, 6][index] * 3600000);
    const before = await readFile(join(dir, 'heartbeat.json'), 'utf8');
    vi.stubEnv('COLLECTOR_DB', '');
    const calls = complete.mock.calls.length;
    const skipped = await deepSeekWebCli(['once', ...urls], { stateDir: dir, client: { complete }, now: () => now + 1 });
    expect(skipped.outcome).toBe('backoff');
    expect(complete).toHaveBeenCalledTimes(calls);
    expect(await readFile(join(dir, 'heartbeat.json'), 'utf8')).toBe(before);
    now = Date.parse(control.next_attempt_at);
  }
  complete.mockResolvedValueOnce(completion());
  const success = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(0, 1), now: () => now, client: { complete } });
  expect(success.outcome).toBe('completed');
  expect(success.backoff).toBeNull();
  expect(readBackoff(dir)).toBeNull();
  expect(backoffDelay(1000000)).toBe(6 * 3600000);
});

test('daemon remains alive across model backoff; expired no-call cycles wait a normal interval', async () => {
  const dir = await temp(), store = db(), controller = new AbortController();
  let now = Date.parse('2026-11-10T00:00:00Z');
  failBackoff(dir, null, 402, now);
  // Existing terminal snapshot models a restarted daemon parked on a persisted deadline.
  const r = initialReport('daemon_tick', now); r.outcome = 'backoff'; r.cycle_interval_ms = 600000; r.backoff = { ...readBackoff(dir)!, state: 'scheduled' };
  await writeHeartbeat(dir, r, 0, now);
  const waits: number[] = [], complete = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await deepSeekWebCli(['daemon'], { stateDir: dir, store, client: { complete }, now: () => now, signal: controller.signal, wait: async ms => {
    waits.push(ms); now += ms;
    if (waits.length === 2) controller.abort();
  } });
  expect(waits).toEqual([3600000, 600000]);
  expect(complete).not.toHaveBeenCalled();
  expect(readBackoff(dir)?.failures).toBe(1);
});

test.each(['db', 'policy', 'emergency', 'budget', 'empty', 'network'] as const)('no-call/unrelated %s failures preserve the expired DeepSeek sequence', async kind => {
  const dir = await temp(), store = db();
  const start = Date.parse('2026-11-10T00:00:00Z');
  const b = failBackoff(dir, null, 429, start), now = Date.parse(b.next_attempt_at);
  const complete = vi.fn(async () => { throw new Error('secret-bearing-network-error'); });
  if (kind === 'emergency') store.put('collector_meta', EMERGENCY_STOP_META_ID, { stopped: true });
  if (kind === 'policy') vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('secret'); });
  const config = loadDeepSeekWebConfig();
  if (kind === 'budget') config.budget.max_tokens_per_run = 0;
  const run = runDeepSeekWeb({ mode: 'daemon_tick', stateDir: dir, store: kind === 'db' ? undefined : store, urls: kind === 'empty' ? ['https://www.instagram.com/blocked'] : urls.slice(0, 1), client: { complete }, now: () => now, loadConfig: () => config });
  vi.stubEnv('COLLECTOR_DB', '');
  await run;
  expect(readBackoff(dir)).toEqual(b);
  expect(complete).toHaveBeenCalledTimes(kind === 'network' ? 1 : 0);
  const report = await readHeartbeat(dir);
  expect(report?.backoff?.state).toBe('eligible');
  expect(JSON.stringify(report)).not.toContain('secret');
});

test('unknown usage retains reservation, stops further calls, and is distinct from known subtotal', async () => {
  const dir = await temp(), store = db(), complete = vi.fn(async () => completion(null));
  const report = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls, client: { complete } });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(report.reason).toBe('usage_unknown');
  expect(report.deepseek_tokens_used).toBeNull(); expect(report.deepseek_tokens_reported).toBe(0); expect(report.usage_complete).toBe(false);
  const audit = JSON.parse((await readFile(join(dir, 'cycle-audit.jsonl'), 'utf8')).trim());
  expect(audit.deepseek_tokens_used).toBeNull();
  expect(usageFrom({})).toMatchObject({ total_tokens: null });
  expect(usageFrom({ usage: { prompt_tokens: 2, completion_tokens: 3 } })).toMatchObject({ total_tokens: 5, total_source: 'derived' });
  expect(usageFrom({ usage: { total_tokens: -1, prompt_tokens: 2.5 } })).toMatchObject({ total_tokens: null, prompt_tokens: null });
  expect(usageFrom({ usage: { total_tokens: 0 } }).total_tokens).toBe(0);
});

test('successful completion clears backoff even if extraction parsing fails', async () => {
  const dir = await temp(), store = db(), t = Date.now() - 3600000;
  failBackoff(dir, null, 402, t);
  await expect(runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls, client: { complete: async () => ({ ...completion(), content: 'malformed' }) } })).rejects.toThrow('extraction_result_invalid');
  expect(readBackoff(dir)).toBeNull();
  const h = await readHeartbeat(dir);
  expect(h?.deepseek_tokens_used).toBe(15); expect(h?.deepseek_calls_succeeded).toBe(1);
});

test.each(['missing_db', 'unavailable_db', 'policy', 'emergency', 'interval', 'config', 'memory', 'backoff'] as const)('initialization failure %s has a terminal heartbeat with no model calls', async kind => {
  const dir = await temp(), store = db(), complete = vi.fn();
  const reasons = { missing_db: 'collector_db_required', unavailable_db: 'collector_db_unavailable', policy: 'domain_state_unavailable', emergency: 'emergency_stop', interval: 'invalid_cycle_interval', config: 'invalid_deepseek_web_config', memory: 'memory_unavailable', backoff: 'backoff_state_unavailable' };
  if (kind === 'memory') await writeFile(join(dir, 'memory.json'), '{broken');
  if (kind === 'backoff') await writeFile(join(dir, 'backoff.json'), '{broken');
  if (kind === 'interval') vi.stubEnv('DEEPSEEK_WEB_DAEMON_MS', 'invalid');
  if (kind === 'emergency') store.put('collector_meta', EMERGENCY_STOP_META_ID, { stopped: true });
  if (kind === 'policy') vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('private-policy-error'); });
  if (kind === 'unavailable_db') await writeFile(join(dir, 'invalid.sqlite'), 'invalid database');
  vi.stubEnv('COLLECTOR_DB', kind === 'unavailable_db' ? join(dir, 'invalid.sqlite') : '');
  const opts = { stateDir: dir, store: ['missing_db', 'unavailable_db'].includes(kind) ? undefined : store, client: { complete } };
  if (kind === 'config') await expect(runDeepSeekWeb({ ...opts, mode: 'once', loadConfig: () => { throw new Error('private'); } })).rejects.toThrow(reasons[kind]);
  else await expect(deepSeekWebCli(['once', ...urls], opts)).rejects.toThrow(reasons[kind]);
  expect(complete).not.toHaveBeenCalled();
  const h = await readHeartbeat(dir);
  expect(h?.outcome).toBe('failed'); expect(h?.reason).toBe(reasons[kind]);
  expect(h?.cycle_started_at_kst).toMatch(/\+09:00$/); expect(h?.cycle_ended_at_kst).toMatch(/\+09:00$/);
  expect(h?.review_pending).toBeNull();
  if (['memory', 'config', 'interval', 'backoff'].includes(kind)) expect(h?.lifetime_token_spent).toBeNull();
  const artifact = JSON.parse(await readFile(join(dir, 'validation-artifact.json'), 'utf8'));
  expect(artifact.cycle_id).toBe(h?.cycle_id); expect(artifact.profile).toBe('deepseek-web');
});

test('status threshold, intervals, legacy, corruption, future time, and read-only operation', async () => {
  const dir = await temp(), t = Date.parse('2026-11-10T00:00:00.000Z');
  const r = initialReport('once', t); r.cycle_interval_ms = 600000;
  await writeHeartbeat(dir, r, 0, t);
  expect((await heartbeatStatus(dir, t + 1200000)).exit_code).toBe(0);
  expect((await heartbeatStatus(dir, t + 1200001)).exit_code).toBe(1);
  expect((await heartbeatStatus(dir, t - 1)).freshness).toBe('unknown');
  expect(await heartbeatStatus(dir, t, '300000')).toMatchObject({ interval_mismatch: true, cycle_interval_ms: 600000, expected_interval_ms: 300000, exit_code: 2 });
  r.cycle_interval_ms = 300000; await writeHeartbeat(dir, r, 0, t);
  expect((await heartbeatStatus(dir, t + 600001, '300000')).exit_code).toBe(1);
  const before = await readdir(dir);
  await chmod(dir, 0o500); await chmod(join(dir, 'heartbeat.json'), 0o400);
  vi.stubEnv('COLLECTOR_DB', ''); vi.stubEnv('DEEPSEEK_API_KEY', '');
  expect((await deepSeekWebCli(['status', '--json'], { stateDir: dir, now: () => t })).exit_code).toBe(2); // mismatch, still no runtime initialization
  expect(await readdir(dir)).toEqual(before);
  await chmod(dir, 0o700); await chmod(join(dir, 'heartbeat.json'), 0o600);
  await writeFile(join(dir, 'heartbeat.json'), '{"heartbeat_at":"2026-11-10T00:00:00.000Z"}');
  expect((await heartbeatStatus(dir, t)).exit_code).toBe(2);
  await writeFile(join(dir, 'heartbeat.json'), 'corrupt'); expect((await heartbeatStatus(dir, t)).freshness).toBe('unknown');
  expect((await heartbeatStatus(join(dir, 'missing'), t)).exit_code).toBe(2);
  expect(await readdir(dir)).toEqual(before);
});

test('concurrent once is writer_busy or immediate backoff and never overwrites the daemon heartbeat', async () => {
  const dir = await temp(), lock = acquireWriter(dir), t = Date.now();
  const r = initialReport('daemon_tick', t); r.cycle_interval_ms = 600000;
  await writeHeartbeat(dir, r, 0, t);
  const before = await readFile(join(dir, 'heartbeat.json'), 'utf8');
  try {
    await expect(runDeepSeekWeb({ mode: 'once', stateDir: dir })).rejects.toThrow('writer_busy');
    failBackoff(dir, null, 402, t);
    expect((await runDeepSeekWeb({ mode: 'once', stateDir: dir })).outcome).toBe('backoff');
    expect(await readFile(join(dir, 'heartbeat.json'), 'utf8')).toBe(before);
  } finally { lock.release(); }
});

test('model HTTP errors are typed and contain no response body; public HTTP failure is not model backoff', async () => {
  const client = createDeepSeekClient({ apiKey: 'test-only-placeholder', model: 'deepseek-chat', maxCompletionTokens: 1, fetchImpl: vi.fn(async () => new Response('private response body', { status: 402 })) });
  const err = await client.complete({ system: '', user: '' }).catch(e => e);
  expect(err).toBeInstanceOf(DeepSeekHttpError); expect(err.message).toBe('deepseek_insufficient_balance'); expect(JSON.stringify(err)).not.toContain('private');
  const dir = await temp(), store = db();
  const report = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: ['https://allowed.example/a'], client, fetchPage: async () => ({ ok: false, reason: 'robots_or_policy' }) });
  expect(report.backoff).toBeNull(); expect(report.deepseek_calls_attempted).toBe(0);
});

test('unsafe heartbeat path fails before calls and preserves the target; dry-run cannot touch operational state', async () => {
  const dir = await temp(), target = join(dir, 'target'), complete = vi.fn();
  await writeFile(target, 'preserve'); await symlink(target, join(dir, 'heartbeat.json'));
  await expect(runDeepSeekWeb({ mode: 'once', stateDir: dir, client: { complete } })).rejects.toThrow('unsafe_state_path');
  expect(complete).not.toHaveBeenCalled(); expect(await readFile(target, 'utf8')).toBe('preserve');
  vi.stubEnv('DEEPSEEK_WEB_STATE_DIR', dir);
  await expect(runDeepSeekWeb({ mode: 'dry_run', stateDir: dir })).rejects.toThrow('dry_run_state_conflict');
});

test('scheduled backoff without an existing heartbeat creates no synthetic cycle or DB access', async () => {
  const dir = await temp(), t = Date.now(), complete = vi.fn();
  failBackoff(dir, null, 402, t);
  vi.stubEnv('COLLECTOR_DB', '');
  const report = await deepSeekWebCli(['once'], { stateDir: dir, client: { complete }, now: () => t });
  expect(report.outcome).toBe('backoff'); expect(report.cycle_id).toBeUndefined();
  expect(await readHeartbeat(dir)).toBeNull(); expect(complete).not.toHaveBeenCalled();
});

test('graceful interruption cancels an active request and retains unknown usage', async () => {
  const dir = await temp(), store = db(), controller = new AbortController();
  const started = Date.now();
  const report = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls, signal: controller.signal,
    client: { complete: async ({ signal }) => {
      const result = new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(new Error('private-abort-error')), { once: true }));
      controller.abort(); return result;
    } },
  });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(report.outcome).toBe('interrupted'); expect(report.reason).toBe('shutdown');
  expect(report.deepseek_calls_attempted).toBe(1); expect(report.deepseek_tokens_used).toBeNull();
  expect((await readHeartbeat(dir))?.cycle_ended_at_kst).toMatch(/\+09:00$/);
});

test('unwritable state preserves the old heartbeat and prevents model calls', async () => {
  const dir = await temp(), complete = vi.fn();
  const r = initialReport('once', Date.now()); r.cycle_interval_ms = 600000;
  await writeHeartbeat(dir, r);
  // Provision and release ownership before denying directory writes.
  acquireWriter(dir).release();
  const before = await readFile(join(dir, 'heartbeat.json'), 'utf8');
  await chmod(dir, 0o500);
  try {
    await expect(runDeepSeekWeb({ mode: 'once', stateDir: dir, client: { complete } })).rejects.toThrow('writer_unavailable');
    expect(await readFile(join(dir, 'heartbeat.json'), 'utf8')).toBe(before);
    expect(complete).not.toHaveBeenCalled();
  } finally { await chmod(dir, 0o700); }
});

test('items_extracted is counted before offer dedup; legacy extractions still counts only new appends', async () => {
  const dir = await temp(), store = db();
  const client = { complete: async () => ({ ...completion(), content: '{"brand":"Stokke","model":"Tripp Trapp","category":"high_chair","gonggu_price":"정보 없음","regular_price":"정보 없음","period":"same","gifts":"정보 없음","conditions":"정보 없음","seller":"same","url":"정보 없음","checked_date":"정보 없음","in_scope":true}' }) };
  const first = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(0, 1), client });
  const { loadMemory, saveMemory } = await import('../crawler/src/deepseek-web/memory');
  const m = await loadMemory(dir); m.observed_urls = []; m.modeled_post_urls = []; await saveMemory(dir, m);
  const queue = JSON.parse((await readFile(join(dir, 'review-queue.jsonl'), 'utf8')).trim());
  queue.extraction.catalog_product_id = 'stokke-tripp-trapp';
  await writeFile(join(dir, 'review-queue.jsonl'), JSON.stringify(queue) + '\n');
  m.pending_catalog_meta[urls[1]] = { catalog_product_id: 'stokke-tripp-trapp', category: 'high_chair' }; await saveMemory(dir, m);
  const second = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(1), client });
  expect(first.items_extracted).toBe(1); expect(first.extractions).toBe(1);
  expect(second.items_extracted).toBe(1); expect(second.items_sent_to_review).toBe(0); expect(second.extractions).toBe(0);
});

test('partial successful usage and counts survive a later 402 in the same cycle', async () => {
  const dir = await temp(), store = db();
  const complete = vi.fn().mockResolvedValueOnce({ ...completion(), content: '{"brand":"Stokke","model":"Tripp Trapp","category":"high_chair","gonggu_price":"정보 없음","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":true}' }).mockRejectedValueOnce(new DeepSeekHttpError(402));
  const r = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls, client: { complete } });
  expect(r.outcome).toBe('backoff'); expect(r.deepseek_calls_attempted).toBe(2); expect(r.deepseek_calls_succeeded).toBe(1);
  expect(r.deepseek_tokens_reported).toBe(15); expect(r.deepseek_tokens_used).toBeNull(); expect(r.lifetime_token_spent).toBe(15);
  expect(r.items_extracted).toBe(1); expect(r.items_sent_to_review).toBe(1); expect(r.extractions).toBe(1);
});

test('audit finalization failure publishes a diagnostic and blocks the next model call', async () => {
  const dir = await temp(), store = db(), complete = vi.fn(async () => completion());
  const r = await runDeepSeekWeb({ mode: 'daemon_tick', stateDir: dir, store, urls: urls.slice(0, 1), client: { complete }, fault: point => {
    if (point === 'terminal_checkpoint') {
      // Inject a conflicting complete row after the terminal checkpoint, before its pending audit append.
      const memory = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
      writeFileSync(join(dir, 'cycle-audit.jsonl'), JSON.stringify({ cycle_id: memory.cycle.cycle_id, conflict: true }) + '\n');
    }
  } });
  expect(r.reason).toBe('audit_conflict'); expect((await readHeartbeat(dir))?.outcome).toBe('failed');
  const retry = await runDeepSeekWeb({ mode: 'daemon_tick', stateDir: dir, store, urls: urls.slice(1), client: { complete } });
  expect(retry.reason).toBe('audit_conflict'); expect(complete).toHaveBeenCalledTimes(1);
});


test('a pre-schema-1 heartbeat is never embedded and cannot brick later cycles', async () => {
  const dir = await temp(), store = db();
  // The old collector's on-disk heartbeat has no schema_version/outcome.
  await writeFile(join(dir, 'heartbeat.json'), JSON.stringify({ at: '2026-11-09T00:00:00.000Z', run_id: 'legacy', token_spent: 1, requests_spent: 1 }));
  const client = { complete: async () => completion() };
  const first = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(0, 1), client });
  expect(first.outcome).toBe('completed');
  expect(first.last_completed_cycle).toBeNull();
  expect((await readHeartbeat(dir))?.schema_version).toBe(2);
  // The upgraded memory checkpoint written by the first cycle must load cleanly.
  const second = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(1), client });
  expect(second.outcome).toBe('completed');
  expect(second.reason).not.toBe('memory_unavailable');
  const { loadMemory } = await import('../crawler/src/deepseek-web/memory');
  expect((await loadMemory(dir)).lifetime.cycles).toBe(2);
});

test('a killed running heartbeat is preserved as interrupted rather than an older terminal summary', async () => {
  const dir = await temp(), store = db(), t = Date.now();
  const client = { complete: async () => completion() };
  await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(0, 1), client });
  // SIGKILL after the start heartbeat but before the memory checkpoint was persisted.
  const killed = initialReport('daemon_tick', t);
  killed.cycle_id = killed.run_id = 'killed-cycle';
  killed.cycle_interval_ms = 600000;
  await writeHeartbeat(dir, killed, 0, t);
  const second = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(1), client });
  expect(second.last_completed_cycle?.cycle_id).toBe('killed-cycle');
  expect(second.last_completed_cycle?.outcome).toBe('interrupted');
  expect(second.last_completed_cycle?.interruption_observed_at_kst).toMatch(/\+09:00$/);
  expect(second.last_completed_cycle?.counts_complete).toBe(false);
});

test('corrupt backoff state does not mask writer_busy for a concurrent once', async () => {
  const dir = await temp(), lock = acquireWriter(dir);
  await writeFile(join(dir, 'backoff.json'), '{broken');
  try { await expect(runDeepSeekWeb({ mode: 'once', stateDir: dir })).rejects.toThrow('writer_busy'); }
  finally { lock.release(); }
});

test('a failed backoff-state write still reports the 402 reason in the heartbeat', async () => {
  const dir = await temp(), store = db();
  const client = { complete: async () => { throw new DeepSeekHttpError(402); } };
  const report = await runDeepSeekWeb({ mode: 'once', stateDir: dir, store, urls: urls.slice(0, 1), client,
    fault: point => {
      if (point !== 'call_intent') return;
      // Make the control-state replacement reject without touching memory.json.
      rmSync(join(dir, 'backoff.json'));
      symlinkSync(join(dir, 'absent-target'), join(dir, 'backoff.json'));
    } });
  expect(report.outcome).toBe('backoff');
  expect(report.reason).toBe('deepseek_insufficient_balance');
  expect(report.backoff?.status).toBe(402);
  const h = await readHeartbeat(dir);
  expect(h?.outcome).toBe('backoff'); expect(h?.reason).toBe('deepseek_insufficient_balance');
  expect(h?.backoff?.state).toBe('scheduled');
});

test('CLI daemon handles 402 without exiting and resumes successfully after the deadline', async () => {
  const dir = await temp(), store = db(), controller = new AbortController();
  let now = Date.parse('2026-11-10T00:00:00Z');
  const complete = vi.fn().mockRejectedValueOnce(new DeepSeekHttpError(402)).mockResolvedValueOnce(completion());
  const waits: number[] = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const last = await deepSeekWebCli(['daemon'], { stateDir: dir, store, urls: urls.slice(0, 1), client: { complete }, now: () => now, signal: controller.signal, wait: async ms => {
    waits.push(ms); now += ms; if (waits.length === 2) controller.abort();
  } });
  expect(waits).toEqual([3600000, 600000]); expect(complete).toHaveBeenCalledTimes(2);
  expect(last.outcome).toBe('completed'); expect(readBackoff(dir)).toBeNull();
});
