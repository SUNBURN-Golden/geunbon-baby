export const UNKNOWN = '정보 없음' as const;

export type ScopedCategory = 'stroller' | 'high_chair' | 'car_seat' | 'play_gym' | 'carrier' | 'bouncer';

export type GongguExtraction = {
  brand: string;
  model: string;
  category: ScopedCategory | typeof UNKNOWN;
  gonggu_price: string;
  regular_price: string;
  period: string;
  gifts: string;
  conditions: string;
  seller: string;
  url: string;
  checked_date: string;
  in_scope: boolean;
  catalog_product_id?: string;
  offer_ref?: string;
  notes?: string;
};

export type ReviewQueueItem = {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  extraction: GongguExtraction;
  source_kind: 'public_web';
  verify_level: 'model_extract';
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

export type DeepSeekWebConfig = {
  profile_id: string;
  profile_version: number;
  model: { provider: string; default_model: string; reasoning_note: string };
  scope_categories: { id: ScopedCategory; ko: string[]; examples: string[] }[];
  prohibited_hosts: string[];
  fetch: { min_interval_ms: number; jitter_ms: [number, number]; timeout_ms: number; max_bytes: number; user_agent_note: string };
  budget: { max_tokens_per_run: number; max_requests_per_run: number; max_completion_tokens: number; estimated_prompt_tokens: number };
  memory: { heartbeat_max_age_ms: number; max_queue_urls: number };
  selection: {
    max_pangpang_detail_per_cycle: number;
    listing_discovery_policy_version: number;
    listing_refresh_min_ms: number;
  };
  seed_urls: string[];
};

export type RunMemory = {
  version: 2;
  updated_at: string;
  plan_notes: string[];
  observed_urls: string[];
  pending_urls: string[];
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
  output_counts: { extractions: number; proposals: number; blocked: number; review_pending: number };
};

export type TickCoverage = {
  searches: { url: string; catalog_product_id: string | null; category: ScopedCategory | null; term: string | null }[];
  listing: Partial<Record<ScopedCategory | 'unscoped', { raw: number; scoped: number; enqueued: number }>>;
  extracted: Partial<Record<ScopedCategory, number>>;
};

export type CollectionStatus =
  | 'active'
  | 'budget_saturated'
  | 'idle'
  | 'idle_dedup'
  | 'listing_no_candidates'
  | 'blocked';

export type RunReport = {
  run_id: string;
  at: string;
  model: string;
  mode: 'once' | 'dry_run' | 'daemon_tick';
  cycle_token_spent: number;
  cycle_requests_spent: number;
  lifetime_token_spent: number;
  lifetime_cycles: number;
  /** @deprecated use cycle_token_spent */
  token_spent: number;
  /** @deprecated use cycle_requests_spent */
  requests_spent: number;
  extractions: number;
  proposals: number;
  blocked: number;
  review_pending: number;
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

export type DeepSeekUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type DeepSeekClient = {
  complete: (input: { system: string; user: string }) => Promise<{ content: string; usage: DeepSeekUsage; model: string }>;
};
