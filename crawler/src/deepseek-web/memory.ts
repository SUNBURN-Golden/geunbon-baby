import { validReceipt } from './extraction-cache';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateMemory } from './memory-schema';
import { validHeartbeat } from './heartbeat';
import { atomicState, readState } from './atomic-state';
import type { RunMemory } from './types';
export function emptyMemory(now = new Date().toISOString()): RunMemory {
  return migrateMemory({ version: 3, updated_at: now, plan_notes: [], observed_urls: [], pending_urls: [],
    last_heartbeat_at: null, last_run_id: null, last_collection_status: 'idle',
    output_counts: { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 } }, randomUUID());
}
function validate(raw: RunMemory & { version: number }) {
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!raw || ![1, 2, 3, 4, 5].includes(raw.version)) throw new Error();
  for (const field of ['plan_notes', 'observed_urls', 'pending_urls'] as const) if (!Array.isArray(raw[field]) || !raw[field].every(v => typeof v === 'string')) throw new Error();
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const field of ['next_search_hints', 'modeled_post_urls'] as const) if (raw[field] !== undefined && (!Array.isArray(raw[field]) || !raw[field].every(v => typeof v === 'string'))) throw new Error();
  if (raw.output_counts !== undefined && (!record(raw.output_counts) || ![raw.output_counts.extractions, raw.output_counts.proposals, raw.output_counts.blocked, raw.output_counts.review_pending].every(count))) throw new Error();
  if (raw.catalog_search_cursor !== undefined && !count(raw.catalog_search_cursor)) throw new Error();
  if (raw.listing_discovery !== undefined && (!record(raw.listing_discovery) || Object.values(raw.listing_discovery).some(v => !record(v) || !count(v.policy_version) || !count(v.last_enqueue_count) || typeof v.last_at !== 'string' || !Number.isFinite(Date.parse(v.last_at))))) throw new Error();
  const categories = new Set(['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer']);
  if (raw.pending_catalog_meta !== undefined && (!record(raw.pending_catalog_meta) || Object.values(raw.pending_catalog_meta).some(v => !record(v) || typeof v.catalog_product_id !== 'string' || typeof v.category !== 'string' || !categories.has(v.category)))) throw new Error();
  const search = raw.last_catalog_search;
  if (search !== undefined && search !== null && (!record(search) || typeof search.product_id !== 'string' || typeof search.term !== 'string' || typeof search.url !== 'string' || !categories.has(search.category))) throw new Error();
  if (raw.rotation !== undefined) {
    const r = raw.rotation;
    const cursorMap = (v: unknown) => record(v) && Object.entries(v).every(([k, n]) => categories.has(k) && count(n));
    const visitOutcomes = new Set(['fetched', 'registry_denied', 'domain_blocked', 'robots_blocked', 'redirect_blocked', 'fetch_failed']);
    if (!record(r) || r.policy_version !== 1 || !(r.category_digest === '' || typeof r.category_digest === 'string' && /^[0-9a-f]{64}$/.test(r.category_digest))
      || !count(r.category_cursor) || (r.legacy_cursor !== undefined && !count(r.legacy_cursor)) || !cursorMap(r.search_cursor) || !cursorMap(r.official_cursor)
      || !record(r.official_visits) || !Object.entries(r.official_visits).every(([id, v]) => /^[\w-]{1,80}$/.test(id) && record(v) && typeof v.source_id === 'string' && typeof v.url === 'string' && typeof v.canonical_url === 'string'
        && typeof v.last_at === 'string' && Number.isFinite(Date.parse(v.last_at)) && typeof v.next_due_at === 'string' && Number.isFinite(Date.parse(v.next_due_at))
        && visitOutcomes.has(String(v.outcome)) && (v.reason === null || typeof v.reason === 'string'))
      || !(r.last_cycle === null || record(r.last_cycle) && Array.isArray(r.last_cycle.categories) && r.last_cycle.categories.every(c => typeof c === 'string' && categories.has(c)) && count(r.last_cycle.official) && count(r.last_cycle.pages))) throw new Error();
  }
  if (raw.lifetime !== undefined && (!record(raw.lifetime) || ![raw.lifetime.token_spent, raw.lifetime.requests, raw.lifetime.cycles, raw.lifetime.model_calls].every(count))) throw new Error();
  if (raw.active_cycle != null && (!validHeartbeat(raw.active_cycle.snapshot) || !raw.cycle || raw.active_cycle.snapshot.cycle_id !== raw.cycle.cycle_id || !['in_flight', 'settled', null].includes(raw.active_cycle.call))) throw new Error();
  if (raw.terminal_summary != null && (!validHeartbeat(raw.terminal_summary) || raw.terminal_summary.cycle_id !== raw.finalized_cycle_id || raw.terminal_summary.outcome === 'running')) throw new Error();
  if (raw.pending_audit != null && (!record(raw.pending_audit) || raw.pending_audit.cycle_id !== raw.finalized_cycle_id || raw.pending_audit.lifetime_token_spent !== raw.lifetime?.token_spent || raw.pending_audit.lifetime_cycles !== raw.lifetime?.cycles)) throw new Error();
  if (raw.version >= 2) {
    if (!raw.cycle || typeof raw.cycle.cycle_id !== 'string' || !raw.lifetime) throw new Error();
    if (![raw.cycle.token_spent, raw.cycle.requests_spent, raw.cycle.tokens_reserved, raw.cycle.requests_reserved, raw.lifetime.token_spent, raw.lifetime.requests, raw.lifetime.cycles, raw.lifetime.model_calls].every(count)) throw new Error();
  } else if (![raw.token_spent ?? 0, raw.requests_spent ?? 0].every(count)) throw new Error();
  if (raw.version >= 3) {
    if (raw.active_cycle && (!validHeartbeat(raw.active_cycle.snapshot) || !raw.active_cycle.snapshot || raw.active_cycle.snapshot.cycle_id !== raw.cycle.cycle_id || !['in_flight', 'settled', null].includes(raw.active_cycle.call))) throw new Error();
    if (!raw.active_cycle && (raw.cycle.token_spent || raw.cycle.requests_spent || raw.cycle.tokens_reserved || raw.cycle.requests_reserved)) throw new Error();
    if (raw.terminal_summary !== null && (!validHeartbeat(raw.terminal_summary) || raw.terminal_summary.cycle_id !== raw.finalized_cycle_id || raw.terminal_summary.outcome === 'running')) throw new Error();
    if (raw.finalized_cycle_id !== null && typeof raw.finalized_cycle_id !== 'string') throw new Error();
    if (raw.pending_audit && (!record(raw.pending_audit) || raw.pending_audit.cycle_id !== raw.finalized_cycle_id || raw.pending_audit.lifetime_token_spent !== raw.lifetime.token_spent || raw.pending_audit.lifetime_cycles !== raw.lifetime.cycles)) throw new Error();
  }
}
export async function loadMemory(dir: string): Promise<RunMemory> {
  try {
    const parsed = JSON.parse(readState(join(dir, 'memory.json')));
    validate(parsed);
    if (([4, 5].includes(parsed.version) || parsed.pending_result !== undefined) && parsed.pending_result !== null && !validReceipt(parsed.pending_result)) throw new Error('pending_result_unavailable');
    if (parsed.version === 2 && [parsed.cycle.token_spent, parsed.cycle.requests_spent, parsed.cycle.tokens_reserved, parsed.cycle.requests_reserved].some(n => n > 0)) {
      // v2 sometimes folded the same cycle before saving its reset. Never guess.
      const rows = readState(join(dir, 'cycle-audit.jsonl')).split('\n').filter(Boolean).map(l => JSON.parse(l));
      const matches = rows.filter(r => r.cycle_id === parsed.cycle.cycle_id);
      if (matches.length !== 1 || matches[0].cycle_token_spent !== parsed.cycle.token_spent || matches[0].cycle_requests !== parsed.cycle.requests_spent || matches[0].lifetime_token_spent !== parsed.lifetime.token_spent || matches[0].lifetime_cycles !== parsed.lifetime.cycles || parsed.cycle.tokens_reserved || parsed.cycle.requests_reserved) throw new Error();
    }
    return migrateMemory(parsed, parsed.cycle?.cycle_id ?? randomUUID());
  } catch (e) {
    if (e instanceof Error && e.message === 'pending_result_unavailable') throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // Only a missing memory file is a new installation; a missing reconciliation audit is not.
      try { readState(join(dir, 'memory.json')); } catch (again) { if ((again as NodeJS.ErrnoException).code === 'ENOENT') return emptyMemory(); }
    }
    throw new Error('memory_unavailable');
  }
}
export async function saveMemory(dir: string, memory: RunMemory) {
  memory.token_spent = memory.cycle.token_spent;
  memory.tokens_reserved = memory.cycle.tokens_reserved;
  memory.requests_spent = memory.cycle.requests_spent;
  memory.requests_reserved = memory.cycle.requests_reserved;
  memory.updated_at = new Date().toISOString();
  try { atomicState(join(dir, 'memory.json'), memory); } catch { throw new Error('memory_unavailable'); }
}
export function newRunId() { return randomUUID(); }
