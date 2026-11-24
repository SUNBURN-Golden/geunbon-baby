import { canonicalUrl } from '../../../shared/privacy-rules';
import { upgradeReport } from './heartbeat';
import type { CycleBudget, LifetimeAudit, RotationState, RunMemory } from './types';

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
const canonicalOrRaw = (url: string) => { try { return canonicalUrl(url); } catch { return url; } };
const canonicalSet = (urls: string[]) => [...new Set(urls.map(canonicalOrRaw))];
export function emptyRotation(): RotationState {
  return {
    policy_version: 1,
    category_digest: '',
    category_cursor: 0,
    legacy_cursor: 0,
    search_cursor: {},
    official_cursor: {},
    official_visits: {},
    last_cycle: null,
  };
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
  const cycle = ([3, 4, 5].includes(raw.version ?? 0) && raw.cycle) ? raw.cycle : emptyCycle(cycleId);
  const gone = raw.gone_urls ?? {};
  return {
    version: 5,
    pending_result: raw.pending_result ?? null,
    finalized_cycle_id: raw.finalized_cycle_id ?? null,
    terminal_summary: raw.terminal_summary ? upgradeReport(raw.terminal_summary) : null,
    pending_audit: raw.pending_audit ?? null,
    active_cycle: raw.active_cycle ? { ...raw.active_cycle, snapshot: upgradeReport(raw.active_cycle.snapshot) } : null,
    updated_at: raw.updated_at ?? new Date().toISOString(),
    plan_notes: raw.plan_notes ?? [],
    observed_urls: canonicalSet(raw.observed_urls ?? []),
    external_price_cursor: raw.external_price_cursor,
    pending_urls: canonicalSet(raw.pending_urls ?? []).filter(url => !Object.hasOwn(gone, url)),
    gone_urls: gone,
    fetch_retry_after: raw.fetch_retry_after ?? {},
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
    pending_catalog_meta: Object.fromEntries(Object.entries(raw.pending_catalog_meta ?? {}).filter(([url]) => !Object.hasOwn(gone, canonicalOrRaw(url)))),
    rotation: { ...emptyRotation(), ...(raw.rotation ?? {}) },
    output_counts: raw.output_counts ?? { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 },
  };
}
