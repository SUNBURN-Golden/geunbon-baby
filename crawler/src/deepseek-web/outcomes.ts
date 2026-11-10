import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  | 'model_failed';
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
