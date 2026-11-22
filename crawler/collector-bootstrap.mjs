import { randomUUID } from 'node:crypto';
import schedule from './pm2-cron.cjs';
// This module deliberately imports no configuration, database or TypeScript code.
export const outcomes = new Set(['succeeded','disabled','skipped','partial_failure','halted','exhausted','pending','interrupted','already_completed','dry_run','failed']);
export const reasons = new Set(['started','completed','no_work','quality_review','sources_disabled','schedule_disabled','already_completed','existing_engine','preview','transport_failed','checkpoint_failed','policy_skipped','checkpoint_wait','cost_wait','halted','exhausted','next_day_required','legacy_unassigned','owner_gone','execution_error','lock_error','run_locked','run_lock_busy','run_lock_unreadable','run_lock_unverifiable','internal_error','initialization_failed','result_publish_failed','summary_write_failed','call_history_unavailable','counts_negative_delta','shutdown','ready','slot_waiting_active_run','slot_waiting_lock']);
export const safeReason = value => reasons.has(value) ? value : 'internal_error';
export const safeId = value => typeof value === 'string' && /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value) ? value : null;
export const safeTime = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
export function invocation(job, source = 'manual', now = Date.now()) {
  return { job: ['discover','collect','discover-sources','backfill-engine','schedule','serve'].includes(job) ? job : 'unknown', source: source === 'scheduled' ? source : 'manual', call_id: randomUUID(), started_at: now, completed: false };
}
export function envelope(context, event, at, fields = {}) {
  return { schema_version: 1, event, generated_at: safeTime(at), started_at: safeTime(context.started_at), ended_at: ['result','service_stop'].includes(event) ? safeTime(at) : null, observed_at: null, job: context.job, source: context.source, call_id: context.call_id, logical_run_id: null, engine_run_id: null, schedule_version: null, first_slot: null, target_slot: null, slot_count: null, expected_slot: null, outcome: null, reason: 'started', counts: { engine: null, invocation: null }, history_status:null, result: null, ...fields };
}
export function publish(event, write = line => console.log(line)) {
  try { write(JSON.stringify(event)); return true; }
  catch { try { console.error(JSON.stringify({schema_version:1,event:'diagnostic',generated_at:new Date().toISOString(),reason:'result_publish_failed'})); } catch {} return false; }
}
export async function bootstrap(args = process.argv.slice(2), load = () => import('./src/local-worker.ts')) {
  const context = invocation(args[0] ?? 'serve', schedule.isPm2CollectorJob(args[0]) ? 'scheduled' : 'manual');
  const service = ['serve','schedule'].includes(context.job);
  const observed = service || context.job !== 'unknown';
  if (observed) publish(envelope(context, service ? 'service_start' : 'start', Date.now()));
  let failure;
  try {
    const loaded = await load();
    if (typeof loaded.collectorFailure === 'function') failure = loaded.collectorFailure;
    await loaded.main(context);
  } catch (error) {
    // collectorFailure emits only fixed codes and approved, redacted fields.
    let diagnostic = 'collector_failed code=internal_error';
    try { if (failure) diagnostic = failure(error); } catch {}
    if (observed && !context.completed) publish(envelope(context, service ? 'service_stop' : 'result', Date.now(), { outcome:'failed', reason:'initialization_failed', history_status:'unavailable', diagnostics:['call_history_unavailable', diagnostic] }));
    // Untracked commands have no start/result envelope; keep their failure visible
    // on stderr (as before) instead of silently exiting.
    else console.error(diagnostic);
    process.exitCode = 1;
  }
}
