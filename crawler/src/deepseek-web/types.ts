export const UNKNOWN = '정보 없음' as const;

export type ScopedCategory = 'stroller' | 'high_chair' | 'car_seat' | 'play_gym' | 'carrier';

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

export type DeepSeekWebConfig = {
  profile_id: string;
  profile_version: number;
  model: { provider: string; default_model: string; reasoning_note: string };
  scope_categories: { id: ScopedCategory; ko: string[]; examples: string[] }[];
  prohibited_hosts: string[];
  fetch: { min_interval_ms: number; jitter_ms: [number, number]; timeout_ms: number; max_bytes: number; user_agent_note: string };
  budget: { max_tokens_per_run: number; max_requests_per_run: number; max_completion_tokens: number };
  memory: { heartbeat_max_age_ms: number; max_queue_urls: number };
  seed_urls: string[];
};

export type RunMemory = {
  version: 1;
  updated_at: string;
  plan_notes: string[];
  observed_urls: string[];
  pending_urls: string[];
  token_spent: number;
  requests_spent: number;
  last_heartbeat_at: string | null;
  last_run_id: string | null;
  output_counts: { extractions: number; proposals: number; blocked: number; review_pending: number };
};

export type RunReport = {
  run_id: string;
  at: string;
  model: string;
  mode: 'once' | 'dry_run' | 'daemon_tick';
  token_spent: number;
  requests_spent: number;
  extractions: number;
  proposals: number;
  blocked: number;
  review_pending: number;
  heartbeat_fresh: boolean;
  pid: number;
};

export type DeepSeekUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type DeepSeekClient = {
  complete: (input: { system: string; user: string }) => Promise<{ content: string; usage: DeepSeekUsage; model: string }>;
};
