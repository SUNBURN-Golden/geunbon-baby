import { isCheckedExtraction } from './extract';
import { ExtractionCache, validEntry, type CacheEntry } from './extraction-cache';
import { enqueueReviewIfNew } from './review-queue';
import { deliverProposal } from './proposals';
import { assertDomainPolicyReadable, evaluateUrlDomainPolicy, isGlobalEmergencyStop } from './domain-policy';
import type { CollectorStore } from '../store';
import type { DeepSeekWebConfig } from './types';
export async function deliverCached(cache: ExtractionCache, entry: CacheEntry, config: DeepSeekWebConfig, store: CollectorStore | undefined, at: string, fault?: (point: string) => void) {
  if (entry.version !== 2 || !isCheckedExtraction(entry.result)) return { deferred: true, review: false, proposal: false };
  if (!validEntry(entry)) throw new Error('extraction_result_invalid');
  if (store) { assertDomainPolicyReadable(store); if (isGlobalEmergencyStop(store)) throw new Error('emergency_stop'); }
  const policy = evaluateUrlDomainPolicy(store, entry.canonical_url, config);
  if (policy.blocked) return { deferred: true, review: false, proposal: false };
  const review = await enqueueReviewIfNew(cache.dir, entry.result, entry, at);
  fault?.('review_delivered');
  const proposal = deliverProposal(cache.dir, entry.cache_key, entry.proposal);
  fault?.('proposal_delivered');
  if (entry.pending_delivery) cache.put({ ...entry, pending_delivery: false });
  return { deferred: false, review: review.enqueued, proposal };
}
