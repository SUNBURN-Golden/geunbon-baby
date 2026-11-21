export const UNKNOWN = '정보 없음' as const;

export const BUNDLE_ITEMS_VERSION = 'bundle-items@1' as const;

export type ScopedCategory = 'stroller' | 'high_chair' | 'car_seat' | 'play_gym' | 'carrier' | 'bouncer';

/** Raw item emitted by the model, before any source verification. */
export type RawBundleItem = {
  region_index: number;
  source_brand: string | null;
  product_name: string;
  option_text: string | null;
  category: ScopedCategory | null;
  gonggu_price: string | null;
  source_quote: string;
};

export type ItemModelMatch = {
  model_id: string;
  brand: string;
  confidence: number;
  matched: string;
};

/** Durable, source-verified bundle item. */
export type CheckedBundleItem = {
  position: number;
  region_index: number;
  source_brand: string | null;
  brand: string | null;
  product_name: string;
  option_text: string | null;
  category: ScopedCategory | null;
  source_quote: string;
  source_span: { start: number; end: number };
  price_fact: import('../../lib/deal-fact-check').Fact<number>;
  model_match: ItemModelMatch | null;
  model_status: 'matched' | 'ambiguous' | 'no_match';
};

export type BundleItem = RawBundleItem | CheckedBundleItem;

export type BundleCheck = {
  version: typeof BUNDLE_ITEMS_VERSION;
  item_price_version: import('../../lib/deal-fact-check').ItemFactVersion;
  status: 'verified' | 'dropped_not_bundle_page' | 'dropped_out_of_scope';
  region_count: number;
  item_count: number;
  dropped_count?: number;
};

export type GongguExtraction = {
  brand: string;
  model: string;
  category: ScopedCategory | typeof UNKNOWN;
  gonggu_price: string | number | null;
  regular_price: string | number | null;
  period: string;
  start_date?: import('../../lib/deal-fact-check').CheckedDate | null;
  end_date?: import('../../lib/deal-fact-check').CheckedDate | null;
  fact_check?: import('../../lib/deal-fact-check').FactCheck;
  needs_fact_check?: boolean;
  gifts: string;
  conditions: string;
  seller: string;
  url: string;
  checked_date: string;
  in_scope: boolean;
  catalog_product_id?: string;
  offer_ref?: string;
  notes?: string;
  bundle_title?: string;
  bundle_items?: BundleItem[];
  bundle_check?: BundleCheck;
};

/** New durable facts: numbers/nulls and structured source dates, never raw candidates. */
export type CheckedGongguExtraction = Omit<GongguExtraction, 'gonggu_price' | 'regular_price' | 'start_date' | 'end_date' | 'fact_check' | 'needs_fact_check' | 'bundle_items'> & {
  gonggu_price: number | null; regular_price: number | null;
  start_date: import('../../lib/deal-fact-check').CheckedDate | null;
  end_date: import('../../lib/deal-fact-check').CheckedDate | null;
  fact_check: import('../../lib/deal-fact-check').FactCheck;
  bundle_items?: CheckedBundleItem[];
};

export type ReviewQueueItem = {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  extraction: GongguExtraction;
  source_kind: 'public_web';
  verify_level: 'model_extract';
  revision?: { version: 1; canonical_url: string; content_hash: string; contract_hash: string; cache_key: string; delivery_id: string; prior_revision_id: string | null; change_reason: 'first_observation' | 'legacy_predecessor' | 'content_changed' | 'contract_changed' | 'content_returned'; extracted_at: string; observed_at: string };
};

export type ParserFixProposal = {
  kind: 'parser_fix_proposal';
  created_at: string;
  url: string;
  parser_ref: string;
  symptom: string;
  evidence_quote: string;
  suggested_change: string;
  self_edit: false;
};

export type CycleBudget = {
  cycle_id: string;
  token_spent: number;
  tokens_reserved: number;
  requests_spent: number;
  requests_reserved: number;
};

export type LifetimeAudit = {
  token_spent: number;
  requests: number;
  cycles: number;
  model_calls: number;
};

/** Approved manufacturer/importer page visited for coverage only (never model-extracted). */
export type OfficialSourceConfig = {
  id: string;
  registry_id: string;
  /** Raw fetch URL, kept byte-for-byte so registry path patterns (trailing slash) still match. */
  url: string;
  brand: string;
  category: ScopedCategory;
  fields: string[];
  enabled: boolean;
  recheck_ms?: number;
};

export type OfficialVisitOutcome = 'fetched' | 'registry_denied' | 'domain_blocked' | 'robots_blocked' | 'redirect_blocked' | 'fetch_failed';

export type RotationState = {
  policy_version: 1;
  category_digest: string;
  category_cursor: number;
  /** Rotates the reserved/leftover legacy work slots so one URL cannot monopolise them. */
  legacy_cursor: number;
  search_cursor: Partial<Record<ScopedCategory, number>>;
  official_cursor: Partial<Record<ScopedCategory, number>>;
  official_visits: Record<string, {
    source_id: string;
    url: string;
    canonical_url: string;
    last_at: string;
    next_due_at: string;
    outcome: OfficialVisitOutcome;
    reason: string | null;
  }>;
  last_cycle: { categories: ScopedCategory[]; official: number; pages: number } | null;
};

export type DeepSeekWebConfig = {
  profile_id: string;
  profile_version: number;
  model: { provider: string; default_model: string; reasoning_note: string; profiles: ModelProfile[] };
  scope_categories: { id: ScopedCategory; ko: string[]; examples: string[] }[];
  prohibited_hosts: string[];
  fetch: { min_interval_ms: number; jitter_ms: [number, number]; timeout_ms: number; max_bytes: number; user_agent_note: string };
  budget: { max_tokens_per_run: number; max_requests_per_run: number; max_completion_tokens: number; estimated_prompt_tokens: number };
  memory: { max_queue_urls: number };
  selection: {
    max_pangpang_detail_per_cycle: number;
    listing_discovery_policy_version: number;
    listing_refresh_min_ms: number;
    max_pages_per_cycle: number;
    category_quota_per_cycle: number;
    legacy_budget_per_cycle: number;
    official_recheck_ms: number;
  };
  official_sources: OfficialSourceConfig[];
  seed_urls: string[];
};

export type RunMemory = {
  version: 5;
  pending_result: import('./extraction-cache').PendingResult | null;
  finalized_cycle_id: string | null;
  terminal_summary: RunReport | null;
  pending_audit: Record<string, unknown> | null;
  active_cycle: { snapshot: RunReport; call: 'in_flight' | 'settled' | null } | null;
  updated_at: string;
  plan_notes: string[];
  observed_urls: string[];
  pending_urls: string[];
  gone_urls: Record<string, 404 | 410>;
  fetch_retry_after: Record<string, number>;
  /** @deprecated tick-local mirror; prefer cycle */
  token_spent: number;
  tokens_reserved: number;
  requests_spent: number;
  requests_reserved: number;
  cycle: CycleBudget;
  lifetime: LifetimeAudit;
  last_heartbeat_at: string | null;
  last_run_id: string | null;
  last_collection_status: CollectionStatus;
  listing_discovery: Record<string, { policy_version: number; last_at: string; last_enqueue_count: number }>;
  next_search_hints: string[];
  catalog_search_cursor: number;
  last_catalog_search: { product_id: string; category: ScopedCategory; term: string; url: string } | null;
  modeled_post_urls: string[];
  pending_catalog_meta: Record<string, { catalog_product_id: string; category: ScopedCategory }>;
  rotation: RotationState;
  output_counts: { extractions: number; proposals: number; blocked: number; review_pending: number };
};

export type TickCoverage = {
  searches: { url: string; catalog_product_id: string | null; category: ScopedCategory | null; term: string | null }[];
  listing: Partial<Record<ScopedCategory | 'unscoped', { raw: number; scoped: number; enqueued: number }>>;
  extracted: Partial<Record<ScopedCategory, number>>;
  rotation: {
    cursor_before: number;
    cursor_after: number;
    scheduled: ScopedCategory[];
    served: ScopedCategory[];
    planned_pages: number;
    skipped_pending: number;
  };
  official: Partial<Record<ScopedCategory, {
    due: number;
    attempted: number;
    fetched: number;
    registry_denied: number;
    domain_blocked: number;
    robots_blocked: number;
    redirect_blocked: number;
    fetch_failed: number;
  }>>;
};

export type CollectionStatus =
  | 'active'
  | 'budget_saturated'
  | 'idle'
  | 'idle_dedup'
  | 'listing_no_candidates'
  | 'blocked';

export type RunReport = {
  schema_version: 1 | 2;
  cycle_id: string;
  cycle_interval_ms: number | null;
  cycle_started_at_kst: string;
  cycle_ended_at_kst: string | null;
  interruption_observed_at_kst: string | null;
  outcome: 'running' | 'completed' | 'failed' | 'interrupted' | 'backoff';
  reason: string | null;
  deepseek_calls_attempted: number;
  deepseek_calls_succeeded: number;
  deepseek_tokens_reported: number;
  deepseek_tokens_used: number | null;
  usage_complete: boolean;
  deepseek_prompt_cache_hit_tokens: number | null;
  deepseek_prompt_cache_miss_tokens: number | null;
  deepseek_completion_tokens: number | null;
  cache_usage_complete: boolean;
  extraction_cache_hits: number | null;
  extraction_cache_misses: number | null;
  candidate_pages_accepted: number | null;
  candidate_pages_rejected: number | null;
  counts_complete: boolean;
  items_extracted: number;
  items_sent_to_review: number;
  backoff: ReturnType<typeof import('./backoff').backoffView>;
  last_completed_cycle: RunReport | null;
  run_id: string;
  at: string;
  model: string;
  mode: 'once' | 'dry_run' | 'daemon_tick';
  cycle_token_spent: number;
  cycle_requests_spent: number;
  lifetime_token_spent: number | null;
  lifetime_cycles: number | null;
  /** @deprecated use cycle_token_spent */
  token_spent: number;
  /** @deprecated use cycle_requests_spent */
  requests_spent: number;
  extractions: number;
  proposals: number;
  blocked: number;
  review_pending: number | null;
  listing_enqueued: number;
  listing_refresh_attempts: number;
  dedup_skips: number;
  coverage: TickCoverage;
  collection_status: CollectionStatus;
  halt_reason: string | null;
  heartbeat_fresh: boolean;
  heartbeat_at: string;
  pid: number;
};

export type ModelProfile = { id: string; provider_model: string; aliases: string[]; thinking: { type: 'disabled' }; max_completion_tokens: number };

export type DeepSeekUsage = { prompt_cache_hit_tokens?: number | null; prompt_cache_miss_tokens?: number | null; prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null; total_source?: 'reported' | 'derived' | 'unknown' };

export type DeepSeekClient = {
  complete: (input: { system: string; user: string; signal?: AbortSignal }) => Promise<{ content: string; usage: DeepSeekUsage; model: string; finish_reason?: string | null }>;
};

/** A suppressed invocation references existing state; it is never a synthetic collection cycle. */
export type ReadOnlyBackoffReport = Partial<RunReport> & {
  outcome: 'backoff'; reason: string;
  backoff: NonNullable<RunReport['backoff']>;
};
export type CollectionReport = RunReport | ReadOnlyBackoffReport;
