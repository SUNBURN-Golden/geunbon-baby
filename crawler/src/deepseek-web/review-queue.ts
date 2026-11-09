import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GongguExtraction, ReviewQueueItem } from './types';

async function readQueue(dir: string) {
  try {
    return (await readFile(join(dir, 'review-queue.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as ReviewQueueItem);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

function offerKey(extraction: GongguExtraction) {
  const ref = extraction.offer_ref ?? extraction.url;
  return `${extraction.catalog_product_id ?? ref}|${extraction.seller}|${extraction.period}`;
}

export async function enqueueReview(dir: string, extraction: GongguExtraction) {
  await mkdir(dir, { recursive: true });
  const item: ReviewQueueItem = { id: randomUUID(), status: 'pending', created_at: new Date().toISOString(), extraction, source_kind: 'public_web', verify_level: 'model_extract' };
  await appendFile(join(dir, 'review-queue.jsonl'), `${JSON.stringify(item)}\n`);
  return item;
}

export async function enqueueReviewIfNew(dir: string, extraction: GongguExtraction): Promise<{ enqueued: boolean; reason?: 'duplicate_url' | 'duplicate_offer' }> {
  const existing = await readQueue(dir);
  for (const row of existing) {
    const ex = row.extraction;
    if (ex.url === extraction.url) return { enqueued: false, reason: 'duplicate_url' };
    if (extraction.catalog_product_id && ex.catalog_product_id === extraction.catalog_product_id
      && ex.seller === extraction.seller && ex.period === extraction.period) {
      return { enqueued: false, reason: 'duplicate_offer' };
    }
    if (!extraction.catalog_product_id && offerKey(ex) === offerKey(extraction)) {
      return { enqueued: false, reason: 'duplicate_offer' };
    }
  }
  await enqueueReview(dir, extraction);
  return { enqueued: true };
}

export async function countPending(dir: string) {
  const items = await readQueue(dir);
  return items.filter(i => i.status === 'pending').length;
}

export async function hasPendingUrl(dir: string, url: string) {
  const items = await readQueue(dir);
  return items.some(i => i.status === 'pending' && i.extraction.url === url);
}
