import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest, parsePriceEvidence, type PriceEvidence } from '../../../shared/deal-price-evidence';
import { atomicState, readState } from '../deepseek-web/atomic-state';
import type { ReviewQueueItem } from '../deepseek-web/types';

export const queuePriceRevision = (item: ReviewQueueItem) => digest(JSON.stringify([
  item.id, item.created_at, item.extraction.url, item.revision?.cache_key ?? queueCaptureHash(item),
]));
export const queueCaptureHash = (item: ReviewQueueItem) => item.revision?.content_hash ?? item.extraction.fact_check?.source_hash ?? null;
const sidecar = (directory: string, revision: string) => join(directory, 'price-evidence', `${revision}.json`);

export function writeQueuePrices(directory: string, revision: string, contentHash: string, evidence: PriceEvidence) {
  if (![revision, contentHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('price_sidecar_revision');
  atomicState(sidecar(directory, revision), { revision, contentHash, evidence });
}
export async function readQueuePrices(directory: string, item: ReviewQueueItem) {
  const revision = await queuePriceRevision(item);
  let row;
  try { row = JSON.parse(readState(sidecar(directory, revision))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('price_sidecar_unavailable');
  }
  const contentHash = queueCaptureHash(item);
  const evidence = contentHash && row?.revision === revision && row.contentHash === contentHash ? await parsePriceEvidence(row.evidence) : null;
  if (!evidence || evidence.offer_url !== item.extraction.url) return null;
  return evidence;
}

export async function writeQueueObservation(directory: string, parentId: string, revision: string,
  evidence: PriceEvidence, reason: 'capture_changed' | 'legacy_hash_missing') {
  const id = await digest(JSON.stringify([parentId, revision, evidence, reason]));
  atomicState(join(directory, 'price-observations', revision, id + '.json'), { id, parentId, revision, evidence, reason });
  return id;
}

export async function queueObservations(directory: string, item: ReviewQueueItem) {
  const revision = await queuePriceRevision(item);
  const dir = join(directory, 'price-observations', revision);
  let files: string[];
  try { files = readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(file => /^[0-9a-f]{64}\.json$/.test(file)).sort().map(async file => {
    const row = JSON.parse(readState(join(dir, file)));
    const evidence = await parsePriceEvidence(row.evidence);
    if (!evidence || row.parentId !== item.id || row.revision !== revision || row.id + '.json' !== file) {
      throw new Error('price_observation_unavailable');
    }
    return { id: row.id as string, reason: row.reason as string, evidence };
  }));
}
