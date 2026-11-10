import { join } from 'node:path';
import { atomicState, readState } from './atomic-state';
import { cycleInterval } from './config';
import type { RunReport } from './types';
export const kst = (now: number) => new Date(now + 9 * 3600000).toISOString().replace('Z', '+09:00');
export function heartbeatFresh(reportAtIso: string, now = Date.now(), maxAgeMs: number) {
  const age = now - Date.parse(reportAtIso);
  return { fresh: Number.isFinite(age) && age >= 0 && age <= maxAgeMs, age_ms: age };
}
export async function writeHeartbeat(dir: string, report: RunReport, _maxAgeMs = 0, now = Date.now()) {
  void _maxAgeMs; // Legacy call signature; freshness is now computed by status.
  report.heartbeat_at = new Date(now).toISOString();
  report.heartbeat_fresh = true;
  atomicState(join(dir, 'heartbeat.json'), { ...report, heartbeat_age_ms: 0 });
  return true;
}
export async function readHeartbeat(dir: string): Promise<RunReport | null> {
  try { const raw = JSON.parse(readState(join(dir, 'heartbeat.json'))); return validHeartbeat(raw) ? upgradeReport(raw) : raw; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
const time = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(Z|\+09:00)$/.test(value) && Number.isFinite(Date.parse(value)) && (value.endsWith('Z') ? new Date(Date.parse(value)).toISOString() === value : kst(Date.parse(value)) === value);
const reasons = new Set(['extraction_cache_unavailable', 'pending_result_unavailable', 'deepseek_model_profile_unverified', 'extraction_result_invalid', 'review_state_unavailable', 'proposal_state_unavailable', 'source_response_invalid', 'collector_db_required', 'collector_db_unavailable', 'domain_state_unavailable', 'emergency_stop', 'invalid_deepseek_web_config', 'invalid_cycle_interval', 'memory_unavailable', 'backoff_state_unavailable', 'deepseek_api_key_missing', 'deepseek_http_failed', 'deepseek_empty', 'audit_conflict', 'audit_unavailable', 'accounting_recovery_required', 'usage_unknown', 'cycle_failed', 'shutdown', 'owner_gone', 'deepseek_insufficient_balance', 'deepseek_rate_limited', 'budget_tokens', 'budget_requests', 'dedup_observed_seed', 'unsafe_url', 'prohibited_domain', 'domain_stopped']);
const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export const metricFields = ['deepseek_prompt_cache_hit_tokens', 'deepseek_prompt_cache_miss_tokens', 'deepseek_completion_tokens', 'extraction_cache_hits', 'extraction_cache_misses', 'candidate_pages_accepted', 'candidate_pages_rejected'] as const;
function validMetrics(h: RunReport) {
  return metricFields.every(k => h[k] === null || count(h[k])) && typeof h.cache_usage_complete === 'boolean' &&
    (h.cache_usage_complete ? count(h.deepseek_prompt_cache_hit_tokens) && count(h.deepseek_prompt_cache_miss_tokens) : h.deepseek_prompt_cache_hit_tokens === null && h.deepseek_prompt_cache_miss_tokens === null);
}
/** Call only after validating the historical shape. Audit intents are never migrated. */
export function upgradeReport(h: RunReport): RunReport {
  return { ...h, ...(h.schema_version === 1 ? { schema_version: 2, ...Object.fromEntries(metricFields.map(k => [k, null])), cache_usage_complete: false } : {}), last_completed_cycle: h.last_completed_cycle ? upgradeReport(h.last_completed_cycle) : null } as RunReport;
}
export function validHeartbeat(h: RunReport): boolean {
  return !!h && [1, 2].includes(h.schema_version) && typeof h.cycle_id === 'string' && h.cycle_id.length > 0 && count(h.pid) && h.pid > 0 && ['once', 'daemon_tick', 'dry_run'].includes(h.mode) &&
    (h.schema_version === 1 || validMetrics(h)) && time(h.heartbeat_at) && time(h.cycle_started_at_kst) && h.cycle_started_at_kst.endsWith('+09:00') &&
    (h.cycle_ended_at_kst === null || time(h.cycle_ended_at_kst) && h.cycle_ended_at_kst.endsWith('+09:00')) &&
    ['running', 'completed', 'failed', 'interrupted', 'backoff'].includes(h.outcome) && (h.reason === null || typeof h.reason === 'string' && reasons.has(h.reason)) &&
    [h.deepseek_calls_attempted, h.deepseek_calls_succeeded, h.deepseek_tokens_reported, h.items_extracted, h.items_sent_to_review].every(count) &&
    h.deepseek_calls_succeeded <= h.deepseek_calls_attempted && typeof h.usage_complete === 'boolean' && typeof h.counts_complete === 'boolean' &&
    (h.deepseek_tokens_used === null || count(h.deepseek_tokens_used)) && (h.usage_complete ? h.deepseek_tokens_used === h.deepseek_tokens_reported : h.deepseek_tokens_used === null) &&
    (h.review_pending === null || count(h.review_pending)) &&
    (h.last_completed_cycle === null || typeof h.last_completed_cycle === 'object' && !!h.last_completed_cycle && [1, 2].includes(h.last_completed_cycle.schema_version) && h.last_completed_cycle.last_completed_cycle === null && validHeartbeat(h.last_completed_cycle) && h.last_completed_cycle.outcome !== 'running') &&
    (h.interruption_observed_at_kst === null || time(h.interruption_observed_at_kst) && h.interruption_observed_at_kst.endsWith('+09:00')) &&
    (h.backoff === null || !!h.backoff && [402, 429].includes(h.backoff.status) && count(h.backoff.failures) && h.backoff.failures > 0 && h.backoff.schema_version === 1 && h.backoff.reason === (h.backoff.status === 402 ? 'deepseek_insufficient_balance' : 'deepseek_rate_limited') && time(h.backoff.failed_at) && time(h.backoff.next_attempt_at) && Date.parse(h.backoff.next_attempt_at) > Date.parse(h.backoff.failed_at) && ['scheduled', 'eligible'].includes(h.backoff.state)) &&
    (h.outcome === 'running' ? h.cycle_ended_at_kst === null : h.outcome === 'interrupted' || h.cycle_ended_at_kst !== null) && Date.parse(h.cycle_started_at_kst) <= Date.parse(h.heartbeat_at) && (h.cycle_ended_at_kst === null || Date.parse(h.cycle_ended_at_kst) >= Date.parse(h.cycle_started_at_kst) && Date.parse(h.cycle_ended_at_kst) <= Date.parse(h.heartbeat_at));
}
export async function heartbeatStatus(dir: string, now = Date.now(), expectedValue = process.env.DEEPSEEK_WEB_DAEMON_MS) {
  let expected: number | null = null;
  try { expected = cycleInterval(expectedValue); } catch { /* Unknown timing is explicit. */ }
  let h: RunReport | null;
  try { h = await readHeartbeat(dir); } catch { return { freshness: 'unknown', reason: 'heartbeat_unreadable', exit_code: 2, expected_interval_ms: expected }; }
  if (!h) return { freshness: 'unknown', reason: 'heartbeat_missing', exit_code: 2, expected_interval_ms: expected };
  let interval: number | null = null;
  try { if (h.cycle_interval_ms !== null && h.cycle_interval_ms !== undefined) interval = cycleInterval(String(h.cycle_interval_ms)); } catch { /* invalid */ }
  const valid = validHeartbeat(h) && interval !== null && Date.parse(h.heartbeat_at) <= now;
  const mismatch = interval !== expected;
  const stale = valid ? now - Date.parse(h.heartbeat_at) > 2 * interval! : null;
  // Only allowlisted health fields leave this read-only command, never arbitrary file contents.
  return { freshness: stale === null ? 'unknown' : stale ? 'stale' : 'fresh', stale, interval_mismatch: mismatch,
    cycle_interval_ms: interval, expected_interval_ms: expected,
    exit_code: !valid || expected === null || mismatch ? 2 : stale ? 1 : 0,
    reason: !valid ? 'heartbeat_invalid' : expected === null ? 'invalid_cycle_interval' : mismatch ? 'interval_mismatch' : null,
    ...(valid ? { outcome: h.outcome, cycle_reason: h.reason, heartbeat_at: h.heartbeat_at, cycle_started_at_kst: h.cycle_started_at_kst, cycle_ended_at_kst: h.cycle_ended_at_kst,
      deepseek_calls_attempted: h.deepseek_calls_attempted, deepseek_calls_succeeded: h.deepseek_calls_succeeded, deepseek_tokens_used: h.deepseek_tokens_used, deepseek_tokens_reported: h.deepseek_tokens_reported,
      ...Object.fromEntries(metricFields.map(k => [k, h[k]])), cache_usage_complete: h.cache_usage_complete, usage_complete: h.usage_complete, counts_complete: h.counts_complete, items_extracted: h.items_extracted, items_sent_to_review: h.items_sent_to_review,
      backoff: h.backoff ? { reason: h.backoff.status === 402 ? 'deepseek_insufficient_balance' : 'deepseek_rate_limited', failures: h.backoff.failures, next_attempt_at: h.backoff.next_attempt_at, state: Date.parse(h.backoff.next_attempt_at) > now ? 'scheduled' : 'eligible' } : null } : {}) };
}
export function printStatus(status: Awaited<ReturnType<typeof heartbeatStatus>>, json = false) {
  if (json) console.log(JSON.stringify(status, null, 2));
  else console.log(Object.entries(status).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n'));
}
