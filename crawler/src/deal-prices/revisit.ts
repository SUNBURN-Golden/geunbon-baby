import { join } from 'node:path';
import { atomicState, readState } from '../deepseek-web/atomic-state';
import { digest } from '../../../shared/deal-price-evidence';
import type { ExternalPriceTarget, PriceSubmission } from './external-observation';

type Revisit = {
  identity: string; nextDue: number; lastSuccess: number | null; lastFailure: string | null;
  failures: number; pending: PriceSubmission | null;
};

export async function priceRevisit(dir: string, target: ExternalPriceTarget, scopesRevision: string) {
  const path = join(dir, 'price-revisits', await digest(target.id) + '.json');
  const identity = JSON.stringify([target.revision, target.capture_hash, target.official_hash, target.authority, scopesRevision]);
  let saved: Revisit | null = null;
  try { saved = JSON.parse(readState(path)) as Revisit; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let record: Revisit = saved?.identity === identity || saved?.pending ? saved :
    { identity, nextDue: 0, lastSuccess: null, lastFailure: null, failures: 0, pending: null };
  return {
    isDue(now: number) { return record.pending !== null || record.nextDue <= now; },
    pending: record.pending,
    submit(submission: PriceSubmission) {
      record = { ...record, pending: submission };
      atomicState(path, record);
    },
    finish(now: number, interval: number, outcome: string, revision = target.revision) {
      const failure = ['provider_retryable', 'source_inaccessible', 'official_source_not_approved', 'superseded'].includes(outcome);
      const failures = failure ? Math.min(10, record.failures + 1) : 0;
      const proof = record.pending?.price_evidence;
      const applied = outcome === 'verified' || ['equal_price', 'above_list', 'discount_below_one_percent'].includes(outcome);
      const nextIdentity = JSON.stringify([revision, applied ? proof?.offer?.source.hash ?? null : target.capture_hash,
        applied ? proof?.official?.source.hash ?? null : target.official_hash,
        applied && proof?.official_approval ? JSON.stringify(proof.official_approval) : target.authority, scopesRevision]);
      record = { identity: nextIdentity, pending: null, failures, lastFailure: failure ? outcome : null,
        lastSuccess: applied ? now : record.lastSuccess,
        nextDue: now + (failure ? Math.min(interval, 300_000 * 2 ** failures) : interval) };
      atomicState(path, record);
    },
  };
}
