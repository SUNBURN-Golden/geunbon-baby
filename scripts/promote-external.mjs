#!/usr/bin/env node
/**
 * Promote an external_candidates row (or DeepSeek review item) to a published /deals entry.
 *
 * Env: ADMIN_TOKEN (required), PROMOTE_API_ORIGIN (default http://127.0.0.1:8787),
 * COLLECTOR_DB for current Linux source authority when using a price sidecar.
 */
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || 'true'];
}));

const origin = process.env.PROMOTE_API_ORIGIN ?? 'http://127.0.0.1:8787';
const endpoint = new URL(origin);
if (endpoint.username || endpoint.password || endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) {
  throw new Error('invalid_promotion_endpoint');
}
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error('ADMIN_TOKEN required');
  process.exit(1);
}

let evidenceId = args['price-evidence-id'];
let expectedRevision = args['expected-revision'];
let recheckQueue;
let candidateId = args['candidate-id'];
let reviewFacts;
let bundleItems = [];
let bundleTitle = null;
let bundleLabels = {};
if (args['from-review-queue']) {
  const path = args['from-review-queue'];
  const line = Number(args.line ?? 0);
  const readRows = () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const rows = readRows();
  const item = rows[line];
  if (!item?.extraction?.url) throw new Error('review queue line missing extraction.url');
  if (item.status === 'rejected') throw new Error('review_candidate_rejected');
  const { tsImport } = await import('tsx/esm/api');
  const { reviewPromotionFacts, reviewBundleItems, reviewBundleTitle, reviewBundleLabels } = await tsImport('./review-facts.ts', import.meta.url);
  const { readQueuePrices, queueObservations } = await tsImport('../crawler/src/deal-prices/review-sidecar.ts', import.meta.url);
  const { canonicalUrl } = await tsImport('../shared/privacy-rules.ts', import.meta.url);
  const url = canonicalUrl(item.extraction.url);
  const selected = JSON.stringify(item);
  const assertCurrent = (snapshot) => {
    const latest = snapshot.findLastIndex(row => canonicalUrl(row.extraction.url) === url);
    if (line !== latest || JSON.stringify(snapshot[line]) !== selected) throw new Error('review_candidate_superseded');
  };
  assertCurrent(rows);
  const observationId = args['price-observation'];
  const priceEvidence = observationId ? (await queueObservations(dirname(path), item)).find(row => row.id === observationId)?.evidence :
    await readQueuePrices(dirname(path), item);
  if (observationId && !priceEvidence) throw new Error('price_observation_not_current');
  recheckQueue = async () => {
    assertCurrent(readRows());
    if (!priceEvidence?.official) return;
    const { openRuntimeCollectorStore } = await tsImport('../crawler/src/deepseek-web/runtime-store.ts', import.meta.url);
    const { priceSourceAuthority } = await tsImport('../crawler/src/deal-prices/runtime.ts', import.meta.url);
    const store = openRuntimeCollectorStore();
    try {
      if (!priceSourceAuthority(store).approved(priceEvidence)) throw new Error('official_source_not_approved');
    } finally { store.close(); }
  };
  reviewFacts = reviewPromotionFacts(item.extraction);
  if (priceEvidence) {
    const { assessPriceEvidence } = await tsImport('../shared/deal-price-evidence.ts', import.meta.url);
    const { facts } = assessPriceEvidence(priceEvidence);
    if (facts) reviewFacts = { ...reviewFacts, price: facts.deal_price_krw, ends_at: facts.ends_at };
  }

  bundleItems = reviewBundleItems(item.extraction);
  bundleTitle = reviewBundleTitle(item.extraction);
  bundleLabels = reviewBundleLabels(item.extraction);
  await recheckQueue();
  const ingest = await fetch(`${origin}/api/v1/ingest`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${process.env.INGEST_TOKEN ?? token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'external_listing',
      ...(priceEvidence ? { price_evidence: priceEvidence } : {}),
      source: 'pangpang',
      source_url: item.extraction.url,
      title: bundleTitle || `${item.extraction.brand} ${item.extraction.model}`.trim().slice(0, 200) || 'DeepSeek 추출 공구',
      text: priceEvidence?.offer?.source.text ?? item.extraction.url,
      seller_handle: /^[A-Za-z0-9._]{1,30}$/.test(item.extraction.seller?.replace(/^@/, '') ?? '') ? item.extraction.seller.replace(/^@/, '') : null,
      price_hint: reviewFacts.price,
      price_raw: reviewFacts.price === null ? null : String(reviewFacts.price),
      starts_at: reviewFacts.starts_at,
      ends_at: reviewFacts.ends_at,
      captured_at: priceEvidence?.offer?.source.observed_at ?? item.created_at,
    }),
  });
  const ingested = await ingest.json();
  candidateId = ingested?.data?.id;
  evidenceId = ingested?.data?.price_evidence_id;
  expectedRevision = ingested?.data?.revision;
  if (!ingest.ok || typeof candidateId !== 'string' || !candidateId.trim()) throw new Error('review_candidate_ingest_failed');
  if (priceEvidence && !evidenceId && ingested.data.status !== 'promoted') throw new Error('review_candidate_evidence_not_staged');
}

if (!candidateId) {
  console.error('--candidate-id=... or --from-review-queue=path --line=0 required');
  process.exit(1);
}

const body = {
  action: 'promote',
  ...(evidenceId ? { price_evidence_id: evidenceId } : {}),
  ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
  ...(reviewFacts ?? {}),
  request_id: args['request-id'] ?? randomUUID(),
  promoted_by: args['promoted-by'] ?? 'cli',
  seller_id: args['seller-id'] || null,
  model_id: args['model-id'] || null,
  reason: args.reason ?? 'CLI promote after manual review',
};
// Review-queue bundles ride along automatically; --bundle-json stays an explicit override.
if (bundleItems.length) {
  if (bundleTitle) body.title = bundleTitle;
  body.bundle_items = bundleItems;
  Object.assign(body, bundleLabels);
}
if (args['bundle-json']) body.bundle_items = JSON.parse(readFileSync(args['bundle-json'], 'utf8'));

await recheckQueue?.();
const res = await fetch(`${origin}/api/v1/admin/candidates/${encodeURIComponent(candidateId)}`, {
  method: 'POST',
  redirect: 'error',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await res.json();
if (!res.ok) {
  console.error(data);
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
