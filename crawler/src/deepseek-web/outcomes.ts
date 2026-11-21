import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchFailure } from '../../lib/external/fetch';
export type OutcomeKind =
  | 'preparation_truncated'
  | 'candidate_rejected'
  | 'extraction_cache_hit'
  | 'extracted'
  | 'out_of_scope'
  | 'listing_enqueued'
  | 'listing_scope_no_core'
  | 'listing_parser_empty'
  | 'listing_no_premium_targets'
  | 'duplicate_skip'
  | 'fetch_blocked'
  | 'fetch_failed'
  | 'official_visit'
  | 'official_registry_denied'
  | 'official_domain_blocked'
  | 'official_robots_blocked'
  | 'official_redirect_blocked'
  | 'official_fetch_failed'
  | 'model_failed';

export function fetchFailureDetail(failure: FetchFailure) {
  const base = { stage: failure.stage, hostname: failure.hostname };
  if (failure.kind !== 'http') {
    const reason = `fetch_${failure.kind}` as const;
    return { ...base, reason, ...('phase' in failure ? { phase: failure.phase } : {}) };
  }
  const { status } = failure;
  if (failure.stage === 'page' && (status === 404 || status === 410)) return { ...base, status, reason: 'http_gone' } as const;
  if (failure.retryAt !== null) {
    return { ...base, status, reason: 'http_host_backoff' as const, retry_after: new Date(failure.retryAt).toISOString() };
  }
  return { ...base, status, reason: 'http_error' as const };
}
export async function logOutcome(dir: string, row: {
  run_id: string;
  cycle_id: string;
  url: string;
  outcome: OutcomeKind;
  detail?: Record<string, unknown>;
}) {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'outcomes.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}
