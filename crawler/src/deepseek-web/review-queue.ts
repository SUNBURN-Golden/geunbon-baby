import { isCheckedExtraction, projectExtraction, validateCheckedExtraction, validateLegacyExtraction } from './extract';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { readState, safePath, prepareStateDir, syncDirectory } from './atomic-state';
import { sha256 } from './page-content';
import { cacheKey } from './cache-identity';
import type { CacheEntry } from './extraction-cache';
import type { GongguExtraction, ReviewQueueItem } from './types';

export async function readQueue(dir: string): Promise<ReviewQueueItem[]> {
  try {
    const text = readState(join(dir, 'review-queue.jsonl'));
    if (text && !text.endsWith('\n')) throw new Error();
    const rows = text.split('\n').filter(Boolean).map(l => JSON.parse(l) as ReviewQueueItem);
    const ids = new Set<string>();
    const current = new Map<string, ReviewQueueItem>();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || ids.has(row.id) || !['pending', 'approved', 'rejected'].includes(row.status) || !row.extraction || typeof row.extraction.url !== 'string') throw new Error();
      const url = canonicalUrl(row.extraction.url); ids.add(row.id);
      if (row.source_kind !== 'public_web' || row.verify_level !== 'model_extract' || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw new Error();
      if (row.extraction.fact_check !== undefined) validateCheckedExtraction(row.extraction);
      else validateLegacyExtraction(JSON.stringify(row.extraction), url, row.extraction.checked_date);
      if (row.revision && (row.revision.version !== 1 || row.revision.canonical_url !== canonicalUrl(row.extraction.url) || !['content_hash', 'contract_hash', 'cache_key', 'delivery_id'].every(k => /^[a-f0-9]{64}$/.test(String(row.revision![k as keyof typeof row.revision]))))) throw new Error();
      if (row.revision) {
        const r = row.revision, prior = current.get(url);
        if (row.extraction.fact_check && (row.extraction.fact_check.source_hash !== r.content_hash || row.extraction.fact_check.observed_at !== r.extracted_at)) throw new Error();
        if (r.prior_revision_id !== (prior?.id ?? null) || r.cache_key !== cacheKey(url, r.content_hash, r.contract_hash) || r.delivery_id !== sha256(JSON.stringify(['review@1', prior?.id ?? null, r.cache_key])) || row.id !== r.delivery_id || !['first_observation', 'legacy_predecessor', 'content_changed', 'contract_changed', 'content_returned'].includes(r.change_reason) || ![r.extracted_at, r.observed_at].every(t => typeof t === 'string' && Number.isFinite(Date.parse(t)))) throw new Error();
      }
      current.set(url, row);
    }
    return rows.map(row => ({ ...row, extraction: projectExtraction(row.extraction) }));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('review_state_unavailable'); }
}
async function append(dir: string, item: ReviewQueueItem) {
  try {
    prepareStateDir(dir);
    const fd = openSync(safePath(join(dir, 'review-queue.jsonl')), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(JSON.stringify(item) + '\n');
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(dir);
  } catch { throw new Error('review_state_unavailable'); }
}
export async function enqueueReview(dir: string, extraction: GongguExtraction) {
  if (!isCheckedExtraction(extraction)) throw new Error('extraction_result_invalid');
  const item: ReviewQueueItem = { id: randomUUID(), status: 'pending', created_at: new Date().toISOString(), extraction, source_kind: 'public_web', verify_level: 'model_extract' };
  await append(dir, item); return item;
}
// One source offer = product identity + seller + window + prices + bundle lines.
// Raw wording must not hide the same offer behind a different phrasing: the
// 2026-11-11 review saw the same 하베브릭스 deal queued three times under
// different model punctuation, seller suffixes and period spacing.
const offerToken = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[&,·/…]+/g, ' ').replace(/\s+/g, ' ').trim();
// A seller is its handle, not its decoration: @somda.park, somda.park and
// "@somda.park (인스타그램)" are one seller. Non-handle names stay verbatim so
// distinct Korean-only seller strings never collide.
const sellerToken = (seller: string) => {
  const handle = /@?[A-Za-z0-9][A-Za-z0-9._]{1,29}/.exec(seller);
  return handle ? handle[0].replace(/^@/, '').toLowerCase() : seller.replace(/\s+/g, ' ').trim();
};
const dayToken = (d: NonNullable<GongguExtraction['start_date']>) => `${d.year ?? ''}-${d.month ?? ''}-${d.day ?? ''}`;
function offerKey(e: GongguExtraction) {
  const p = projectExtraction(e);
  // Checked rows key on canonical date components; legacy rows keep their
  // whitespace-stripped period so well-formed strings still collide.
  const window = p.start_date || p.end_date ? `${p.start_date ? dayToken(p.start_date) : ''}~${p.end_date ? dayToken(p.end_date) : ''}` : p.period.replace(/\s+/g, '');
  // An item name/option/price change is substantive: it must not be hidden by
  // duplicate_offer against a different URL.
  const bundle = p.bundle_items?.map(item => 'price_fact' in item
    ? JSON.stringify([item.brand, offerToken(item.product_name), offerToken(item.option_text ?? ''), item.price_fact.value, item.model_match?.model_id ?? null])
    : JSON.stringify([item.source_brand, offerToken(item.product_name), offerToken(item.option_text ?? ''), item.gonggu_price])).sort() ?? null;
  return JSON.stringify([isCheckedExtraction(e), p.catalog_product_id ?? offerToken(`${p.brand} ${p.model}`), sellerToken(p.seller), window, p.gonggu_price, p.regular_price, bundle]);
}
export async function enqueueReviewIfNew(dir: string, extraction: GongguExtraction, entry?: CacheEntry, observedAt = new Date().toISOString()): Promise<{ enqueued: boolean; reason?: string }> {
  if (!isCheckedExtraction(extraction) || entry && (entry.version !== 2 || !isCheckedExtraction(entry.result) || JSON.stringify(entry.result) !== JSON.stringify(extraction) || entry.canonical_url !== canonicalUrl(extraction.url) || entry.content_hash !== extraction.fact_check.source_hash || entry.cache_key !== cacheKey(entry.canonical_url,entry.content_hash,entry.contract_hash))) throw new Error('extraction_result_invalid');
  const existing = await readQueue(dir);
  const url = canonicalUrl(extraction.url);
  const prior = existing.filter(row => canonicalUrl(row.extraction.url) === url).at(-1);
  if (entry) {
    if (prior?.revision?.cache_key === entry.cache_key) return { enqueued: false, reason: 'duplicate_revision' };
    if (!prior && !extraction.in_scope) return { enqueued: false, reason: 'out_of_scope' };
    if (!prior && existing.some(row => canonicalUrl(row.extraction.url) !== url && offerKey(row.extraction) === offerKey(extraction))) return { enqueued: false, reason: 'duplicate_offer' };
    // Same-URL transitions always reach review, including a return to historical content.
    const returned = existing.some(r => r.revision?.cache_key === entry.cache_key);
    const delivery = sha256(JSON.stringify(['review@1', prior?.id ?? null, entry.cache_key]));
    const item: ReviewQueueItem = { id: delivery, status: 'pending', created_at: observedAt, extraction, source_kind: 'public_web', verify_level: 'model_extract',
      revision: { version: 1, canonical_url: url, content_hash: entry.content_hash, contract_hash: entry.contract_hash, cache_key: entry.cache_key, delivery_id: delivery, prior_revision_id: prior?.id ?? null,
        change_reason: !prior ? 'first_observation' : !prior.revision ? 'legacy_predecessor' : returned ? 'content_returned' : prior.revision.content_hash !== entry.content_hash ? 'content_changed' : 'contract_changed', extracted_at: entry.extracted_at, observed_at: observedAt } };
    await append(dir, item); return { enqueued: true };
  }
  if (prior) return { enqueued: false, reason: 'duplicate_url' };
  if (existing.some(row => offerKey(row.extraction) === offerKey(extraction))) return { enqueued: false, reason: 'duplicate_offer' };
  await enqueueReview(dir, extraction); return { enqueued: true };
}
export async function countPending(dir: string) {
  const current = new Map<string, ReviewQueueItem>();
  for (const row of await readQueue(dir)) current.set(canonicalUrl(row.extraction.url), row);
  return [...current.values()].filter(i => i.status === 'pending').length;
}
export async function hasPendingUrl(dir: string, url: string) {
  const rows = await readQueue(dir);
  return rows.filter(row => canonicalUrl(row.extraction.url) === canonicalUrl(url)).at(-1)?.status === 'pending';
}
