import type { CycleBudget, LifetimeAudit, RunMemory } from './types';

/**
 * Pure memory-shape helpers. Kept separate from both `memory.ts` and
 * `budget-cycle.ts` so neither module imports the other.
 */
export function emptyCycle(cycleId: string): CycleBudget {
  return { cycle_id: cycleId, token_spent: 0, tokens_reserved: 0, requests_spent: 0, requests_reserved: 0 };
}
export function emptyLifetime(): LifetimeAudit {
  return { token_spent: 0, requests: 0, cycles: 0, model_calls: 0 };
}
export function migrateMemory(raw: Omit<Partial<RunMemory>, 'version'> & { version?: number }, cycleId: string): RunMemory {
  const lifetime = raw.lifetime ?? emptyLifetime();
  if (raw.version === 1) {
    const legacyTokens = raw.token_spent ?? 0;
    const legacyRequests = raw.requests_spent ?? 0;
    lifetime.token_spent += legacyTokens;
    lifetime.requests += legacyRequests;
    lifetime.model_calls += legacyRequests;
    lifetime.cycles = lifetime.cycles || 0;
  }
  const cycle = raw.version === 3 && raw.cycle ? raw.cycle : emptyCycle(cycleId);
  return {
    version: 3,
    finalized_cycle_id: raw.finalized_cycle_id ?? null,
    terminal_summary: raw.terminal_summary ?? null,
    pending_audit: raw.pending_audit ?? null,
    active_cycle: raw.active_cycle ?? null,
    updated_at: raw.updated_at ?? new Date().toISOString(),
    plan_notes: raw.plan_notes ?? [],
    observed_urls: raw.observed_urls ?? [],
    pending_urls: raw.pending_urls ?? [],
    token_spent: 0,
    tokens_reserved: 0,
    requests_spent: 0,
    requests_reserved: 0,
    cycle,
    lifetime,
    last_heartbeat_at: raw.last_heartbeat_at ?? null,
    last_run_id: raw.last_run_id ?? null,
    last_collection_status: raw.last_collection_status ?? 'idle',
    listing_discovery: raw.listing_discovery ?? {},
    next_search_hints: raw.next_search_hints ?? [],
    catalog_search_cursor: raw.catalog_search_cursor ?? 0,
    last_catalog_search: raw.last_catalog_search ?? null,
    modeled_post_urls: raw.modeled_post_urls ?? [],
    pending_catalog_meta: raw.pending_catalog_meta ?? {},
    output_counts: raw.output_counts ?? { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 },
  };
}
