import { ExtractionCache, validReceipt, type PendingResult } from './extraction-cache';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicState } from './atomic-state';
import { backoffDelay, backoffView, failBackoff, readBackoff, saveBackoff, type BackoffState } from './backoff';
import { beginCycle, cycleHold, cycleSettle, finalizeCycle, flushPendingAudit } from './budget-cycle';
import { createDeepSeekClient, DeepSeekHttpError, usageFrom } from './client';
import { cycleInterval, loadDeepSeekWebConfig, stateDir, modelProfile } from './config';
import { assertDomainPolicyReadable, isGlobalEmergencyStop } from './domain-policy';
import { kst, readHeartbeat, validHeartbeat, writeHeartbeat } from './heartbeat';
import { loadMemory, newRunId, saveMemory } from './memory';
import { openRuntimeCollectorStore } from './runtime-store';
import { acquireWriter, type WriterOwnership } from './writer-ownership';
import type { RunnerOptions } from './runner';
import type { CollectionReport, DeepSeekClient, DeepSeekWebConfig, RunMemory, RunReport } from './types';
import type { CollectorStore } from '../store';

const fixedReasons = new Set(['extraction_cache_unavailable', 'pending_result_unavailable', 'deepseek_model_profile_unverified', 'extraction_result_invalid', 'review_state_unavailable', 'proposal_state_unavailable', 'source_response_invalid', 'collector_db_required', 'collector_db_unavailable', 'domain_state_unavailable', 'emergency_stop', 'invalid_deepseek_web_config', 'invalid_cycle_interval', 'memory_unavailable', 'backoff_state_unavailable', 'deepseek_api_key_missing', 'deepseek_http_failed', 'deepseek_empty', 'audit_conflict', 'audit_unavailable', 'accounting_recovery_required', 'usage_unknown']);
export function fixedReason(error: unknown) {
  if (error instanceof DeepSeekHttpError) return error.reason;
  return error instanceof Error && fixedReasons.has(error.message) ? error.message : 'cycle_failed';
}
export function initialReport(mode: RunReport['mode'], now: number): RunReport {
  const id = newRunId(), at = new Date(now).toISOString();
  return { schema_version: 2, cycle_id: id, run_id: id, at, model: 'unknown', mode, pid: process.pid,
    heartbeat_at: at, heartbeat_fresh: true, cycle_interval_ms: null, cycle_started_at_kst: kst(now), cycle_ended_at_kst: null,
    interruption_observed_at_kst: null, outcome: 'running', reason: null, deepseek_calls_attempted: 0, deepseek_calls_succeeded: 0,
    deepseek_prompt_cache_hit_tokens: 0, deepseek_prompt_cache_miss_tokens: 0, deepseek_completion_tokens: 0, cache_usage_complete: true, extraction_cache_hits: 0, extraction_cache_misses: 0, candidate_pages_accepted: 0, candidate_pages_rejected: 0, deepseek_tokens_reported: 0, deepseek_tokens_used: 0, usage_complete: true, counts_complete: true,
    items_extracted: 0, items_sent_to_review: 0, backoff: null, last_completed_cycle: null,
    cycle_token_spent: 0, cycle_requests_spent: 0, lifetime_token_spent: null, lifetime_cycles: null, token_spent: 0, requests_spent: 0,
    extractions: 0, proposals: 0, blocked: 0, review_pending: null, listing_enqueued: 0, listing_refresh_attempts: 0, dedup_skips: 0,
    coverage: { searches: [], listing: {}, extracted: {} }, collection_status: 'idle', halt_reason: null };
}
export type CycleContext = {
  dir: string; config: DeepSeekWebConfig; memory: RunMemory; report: RunReport;
  client: DeepSeekClient; store?: CollectorStore; checkpoint: () => Promise<void>;
  complete: (input: { system: string; user: string }, reserve: number, acknowledge?: (completion: Awaited<ReturnType<DeepSeekClient['complete']>>) => PendingResult) => ReturnType<DeepSeekClient['complete']>;
};
async function publishTerminal(dir: string, report: RunReport, now: number) {
  await writeHeartbeat(dir, report, 0, now);
  atomicState(join(dir, 'validation-artifact.json'), { ...report, heartbeat_age_ms: 0, validated_at: new Date(now).toISOString(), profile: 'deepseek-web', heartbeat_stale_warning: 'heartbeat_fresh reflects write-time only; re-check age before treating as live health' });
}
async function recover(dir: string, memory: RunMemory, now: number, backoff: BackoffState | null) {
  await flushPendingAudit(dir, memory);
  if (memory.active_cycle) {
    const r = memory.active_cycle.snapshot;
    if (r.outcome === 'running') {
      r.outcome = 'interrupted'; r.reason = 'owner_gone'; r.cycle_ended_at_kst = null;
      r.interruption_observed_at_kst = kst(now); r.counts_complete = false;
      if (memory.active_cycle.call === 'in_flight') { r.usage_complete = false; r.deepseek_tokens_used = null; r.cache_usage_complete = false; r.deepseek_prompt_cache_hit_tokens = r.deepseek_prompt_cache_miss_tokens = r.deepseek_completion_tokens = null; }
    }
    r.backoff = backoffView(backoff, now);
    r.heartbeat_at = new Date(now).toISOString();
    r.cycle_token_spent = r.token_spent = memory.cycle.token_spent;
    r.cycle_requests_spent = r.requests_spent = memory.cycle.requests_spent;
    r.lifetime_token_spent = memory.lifetime.token_spent + memory.cycle.token_spent;
    r.lifetime_cycles = memory.lifetime.cycles + 1;
    await finalizeCycle(dir, memory, { ...r, last_completed_cycle: null });
    await publishTerminal(dir, r, now);
  }
}
export async function cycleLifecycle(options: RunnerOptions, execute: (ctx: CycleContext) => Promise<void>): Promise<CollectionReport> {
  const now = options.now ?? Date.now;
  const operational = resolve(stateDir());
  const dir = resolve(options.stateDir ?? (options.mode === 'dry_run' ? await mkdtemp(join(tmpdir(), 'deepseek-web-dry-')) : operational));
  // Explicit dry-run directories are test artifacts, never the configured operational directory.
  if (options.mode === 'dry_run' && dir === operational) throw new Error('dry_run_state_conflict');
  let ownership: WriterOwnership;
  try {
    if (options.ownership && options.ownership.dir !== dir) throw new Error('writer_unavailable');
    ownership = options.ownership ?? acquireWriter(dir);
  } catch (e) {
    // Contention is not a collection cycle and must never replace the owner's snapshot.
    if (e instanceof Error && e.message === 'writer_busy' && options.mode === 'once') {
      // Corrupt control/heartbeat state must not mask the writer classification.
      let b: BackoffState | null = null;
      try { b = readBackoff(dir); } catch { /* report writer_busy below */ }
      if (b && Date.parse(b.next_attempt_at) > now()) {
        const old = await readHeartbeat(dir).catch(() => null);
        return { ...(old ?? {}), outcome: 'backoff', reason: b.reason, backoff: backoffView(b, now())! };
      }
    }
    throw new Error(e instanceof Error && e.message === 'writer_busy' ? 'writer_busy' : 'writer_unavailable');
  }
  let memory: RunMemory | undefined, ownedStore: CollectorStore | undefined;
  let backoff: BackoffState | null = null;
  const report = initialReport(options.mode, now());
  let failure: unknown;
  let accountingSafe = false;
  try {
    // A valid scheduled backoff is a read-only response, including for a newly restarted daemon.
    // Invalid control state is handled inside a visible lifecycle below.
    try { backoff = readBackoff(dir); } catch { /* publish diagnostic below */ }
    if (backoff && Date.parse(backoff.next_attempt_at) > now()) {
      const old = await readHeartbeat(dir);
      if (options.mode === 'once' || old?.outcome !== 'running') {
        return { ...(old ?? {}), outcome: 'backoff', reason: backoff.reason, backoff: backoffView(backoff, now())! };
      }
    }
    try { report.cycle_interval_ms = cycleInterval(); } catch { /* start snapshot still publishes */ }
    // Carry a prior snapshot forward only when it is schema-valid. A pre-schema-1
    // heartbeat must never be embedded in memory.json, where validHeartbeat would
    // reject it on every later load and permanently brick the collector.
    const readPrevious = await readHeartbeat(dir).catch(() => null);
    const previous = readPrevious && validHeartbeat(readPrevious) ? readPrevious : null;
    report.last_completed_cycle = previous && previous.outcome !== 'running' ? { ...previous, last_completed_cycle: null } : null;
    await writeHeartbeat(dir, report, 0, now());
    // Protected initialization: every failure below has a terminal heartbeat.
    cycleInterval();
    let config: DeepSeekWebConfig;
    try { config = options.loadConfig ? options.loadConfig() : loadDeepSeekWebConfig(); } catch { throw new Error('invalid_deepseek_web_config'); }
    backoff = readBackoff(dir);
    // Prove control storage writable before permitting any model work.
    saveBackoff(dir, backoff);
    memory = await loadMemory(dir);
    // A settled completion is durable proof of recovery even if the process died before clearing control state.
    if (backoff && memory.active_cycle?.call === 'settled' && memory.active_cycle.snapshot.deepseek_calls_succeeded > 0) {
      saveBackoff(dir, null); backoff = null;
    }
    await recover(dir, memory, now(), backoff);
    if (previous?.outcome === 'running' && previous.cycle_id !== memory.terminal_summary?.cycle_id) {
      // The running heartbeat outlived its memory checkpoint (SIGKILL before the
      // start checkpoint): preserve it as interrupted instead of replacing it with
      // an older terminal summary.
      report.last_completed_cycle = { ...previous, last_completed_cycle: null, outcome: 'interrupted', reason: 'owner_gone', cycle_ended_at_kst: null, interruption_observed_at_kst: kst(now()), counts_complete: false };
    } else if (memory.terminal_summary) {
      report.last_completed_cycle = { ...memory.terminal_summary, last_completed_cycle: null };
    }
    if (backoff && Date.parse(backoff.next_attempt_at) > now()) {
      // Recovery may have finalized a killed running cycle; do not start work before the deadline.
      const recovered = memory.terminal_summary;
      if (recovered) return { ...recovered, outcome: 'backoff', reason: backoff.reason, backoff: backoffView(backoff, now()) };
    }
    const store = options.store ?? (options.mode !== 'dry_run' ? ownedStore = openRuntimeCollectorStore() : undefined);
    if (store) {
      assertDomainPolicyReadable(store);
      if (isGlobalEmergencyStop(store)) throw new Error('emergency_stop');
    }
    const profile = modelProfile(config);
    const cache = new ExtractionCache(dir);
    if (memory.pending_result) {
      cache.promote(memory.pending_result, options.fault);
      memory.pending_result = null;
      await saveMemory(dir, memory);
      options.fault?.('receipt_cleared');
    }
    // Revalidate deferred representations through the normal robots/source gate before delivery.
    memory.pending_urls = [...new Set([...memory.pending_urls, ...cache.pending(config.memory.max_queue_urls).map(entry => entry.canonical_url)])];
    beginCycle(memory, report.cycle_id);
    memory.active_cycle = { snapshot: report, call: null };
    accountingSafe = true;
    report.lifetime_token_spent = memory.lifetime.token_spent;
    report.lifetime_cycles = memory.lifetime.cycles;
    report.model = profile.provider_model;
    const checkpoint = async () => {
      report.cycle_token_spent = report.token_spent = memory!.cycle.token_spent;
      report.cycle_requests_spent = report.requests_spent = memory!.cycle.requests_spent;
      report.backoff = backoffView(backoff, now());
      await saveMemory(dir, memory!);
    };
    await checkpoint();
    const client = options.client ?? createDeepSeekClient({ apiKey: options.mode === 'dry_run' ? 'mock' : process.env.DEEPSEEK_API_KEY ?? '', model: report.model, thinking: profile.thinking, maxCompletionTokens: config.budget.max_completion_tokens, fetchImpl: options.fetchImpl, fixturePath: process.env.DEEPSEEK_WEB_FIXTURE });
    const ctx: CycleContext = { dir, config, memory, report, store, client, checkpoint,
      async complete(input, reserve, acknowledge) {
        options.signal?.throwIfAborted();
        if (memory!.pending_result) throw new Error('pending_result_unavailable');
        const priorHit = report.deepseek_prompt_cache_hit_tokens, priorMiss = report.deepseek_prompt_cache_miss_tokens, priorCompletion = report.deepseek_completion_tokens;
        cycleHold(memory!, reserve);
        report.deepseek_calls_attempted++;
        memory!.active_cycle!.call = 'in_flight';
        report.usage_complete = false; report.deepseek_tokens_used = null;
        report.cache_usage_complete = false; report.deepseek_prompt_cache_hit_tokens = report.deepseek_prompt_cache_miss_tokens = report.deepseek_completion_tokens = null;
        await checkpoint(); // Invocation intent is durable before sending the request.
        options.fault?.('call_intent');
        let completion;
        try { completion = await client.complete({ ...input, signal: options.signal }); }
        catch (error) {
          if (error instanceof DeepSeekHttpError && (error.status === 402 || error.status === 429)) {
            try { backoff = failBackoff(dir, backoff, error.status, now()); }
            catch {
              // A control-state write failure must not hide the provider reason.
              // Keep an in-memory deadline so this process still backs off; the next
              // cycle revalidates writable storage before any model call.
              const failures = Math.min(Number.MAX_SAFE_INTEGER, (backoff?.failures ?? 0) + 1);
              const at = now();
              backoff = { schema_version: 1, status: error.status, reason: error.status === 402 ? 'deepseek_insufficient_balance' : 'deepseek_rate_limited', failures, failed_at: new Date(at).toISOString(), next_attempt_at: new Date(at + backoffDelay(failures)).toISOString() };
            }
            options.fault?.('backoff_persisted');
          }
          // Reservation and unknown usage survive failures, including interrupted calls.
          await checkpoint();
          throw error;
        }
        options.fault?.('model_responded');
        report.deepseek_calls_succeeded++;
        const usage = usageFrom({ usage: completion.usage });
        const priorUnknown = report.deepseek_calls_attempted - 1 !== report.deepseek_calls_succeeded - 1;
        if (usage.total_tokens !== null) {
          cycleSettle(memory!, reserve, usage.total_tokens);
          report.deepseek_tokens_reported += usage.total_tokens;
        }
        report.usage_complete = usage.total_tokens !== null && !priorUnknown;
        report.deepseek_tokens_used = report.usage_complete ? report.deepseek_tokens_reported : null;
        report.deepseek_prompt_cache_hit_tokens = priorHit !== null && usage.prompt_cache_hit_tokens != null ? priorHit + usage.prompt_cache_hit_tokens : null;
        report.deepseek_prompt_cache_miss_tokens = priorMiss !== null && usage.prompt_cache_miss_tokens != null ? priorMiss + usage.prompt_cache_miss_tokens : null;
        report.cache_usage_complete = report.deepseek_prompt_cache_hit_tokens !== null && report.deepseek_prompt_cache_miss_tokens !== null;
        report.deepseek_completion_tokens = priorCompletion !== null && usage.completion_tokens !== null ? priorCompletion + usage.completion_tokens : null;
        let validationFailed = false;
        if (acknowledge) {
          try {
            const receipt = acknowledge(completion);
            if (!validReceipt(receipt)) throw new Error('extraction_result_invalid');
            memory!.pending_result = receipt;
          }
          catch { validationFailed = true; }
        }
        memory!.active_cycle!.call = 'settled';
        if (validationFailed) report.reason = 'extraction_result_invalid';
        await checkpoint(); // Acknowledged settlement precedes parsing or queue appends.
        options.fault?.('call_settled');
        if (backoff) { saveBackoff(dir, null); backoff = null; }
        await checkpoint();
        if (validationFailed) throw new Error('extraction_result_invalid');
        return { ...completion, usage };
      },
    };
    await execute(ctx);
    report.outcome = 'completed';
  } catch (error) {
    failure = error;
    report.outcome = options.signal?.aborted ? 'interrupted' : error instanceof DeepSeekHttpError && [402, 429].includes(error.status) ? 'backoff' : 'failed';
    report.reason = options.signal?.aborted ? 'shutdown' : fixedReason(error);
    report.halt_reason = report.reason;
    if (['memory_unavailable', 'audit_conflict', 'audit_unavailable', 'accounting_recovery_required'].includes(report.reason)) accountingSafe = false;
  } finally {
    try {
      ownedStore?.close();
      // Read-only backoff returns above have no synthetic cycle or writes.
      if (report.outcome !== 'running') {
        report.cycle_ended_at_kst = kst(now());
        report.heartbeat_at = new Date(now()).toISOString();
        report.backoff = backoffView(backoff, now());
        if (memory && accountingSafe && memory.active_cycle) {
          report.cycle_token_spent = report.token_spent = memory.cycle.token_spent;
          report.cycle_requests_spent = report.requests_spent = memory.cycle.requests_spent;
          report.lifetime_token_spent = memory.lifetime.token_spent + memory.cycle.token_spent;
          report.lifetime_cycles = memory.lifetime.cycles + 1;
          memory.last_heartbeat_at = report.heartbeat_at;
          memory.last_run_id = report.run_id;
          memory.last_collection_status = report.collection_status;
          try {
            await finalizeCycle(dir, memory, { ...report, last_completed_cycle: null }, options.fault);
          } catch (error) {
            // The durable checkpoint owns recovery. Do not retry a lifetime fold in this invocation.
            failure = error;
            report.outcome = 'failed'; report.reason = fixedReason(error); report.halt_reason = report.reason;
          }
        }
        await publishTerminal(dir, report, now());
      }
    } finally { if (!options.ownership) ownership.release(); }
  }
  if (failure && report.outcome === 'failed' && options.mode !== 'daemon_tick') throw new Error(report.reason!);
  return report;
}

/** Abort both active requests and waits; no transaction is held while waiting. */
export async function waitFor(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
