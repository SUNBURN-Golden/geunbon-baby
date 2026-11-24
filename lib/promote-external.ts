import { EXTERNAL_SOURCES, type ExternalCandidate, type ExternalSourceId, externalSourceIds } from './data';
import { digest, offerSourceClosed } from '../shared/deal-price-evidence';
import { bundleComponents, configurationMatches, currentReviewEvidence, pendingPriceObservation, reviewEvidenceGuard, priceBindings, priceColumns } from './deal-price-review';
import { normalizeTimestamp, parseTimestamp } from './deals';
import { officialPriceAllowed } from './official-price-sources';

export type BundleItemInput = {
  brand?: string | null;
  product_name: string;
  model_id?: string | null;
  price?: number | null;
};

export type PromoteExternalInput = {
  candidate_id: string;
  price_evidence_id?: string | null;
  expected_revision?: string;
  promoted_by: string;
  request_id: string;
  reason?: string | null;
  seller_id?: string | null;
  model_id?: string | null;
  title?: string | null;
  price?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  source_ended?: boolean;
  brand_label?: string | null;
  category_label?: string | null;
  bundle_items?: BundleItemInput[];
};

export type PromoteExternalResult =
  | { ok: true; deal_id: string; created: boolean; promotion_id: string }
  | { ok: false; code: string; status: number; detail?: Record<string, string> };

export function detectSourceEnded(candidate: Pick<ExternalCandidate, 'text' | 'dates_raw' | 'ends_at'>, override?: boolean) {
  if (override === true) return true;
  if (override === false) return false;
  const blob = `${candidate.text}\n${candidate.dates_raw ?? ''}`;
  if (offerSourceClosed(blob)) return true;
  if (candidate.ends_at) {
    const end = parseTimestamp(candidate.ends_at);
    if (Number.isFinite(end) && end < Date.now()) return true;
  }
  return false;
}

function hostFromSource(source: string, sourceUrl: string) {
  if (externalSourceIds.includes(source as ExternalSourceId)) return EXTERNAL_SOURCES[source as ExternalSourceId].host;
  try { return new URL(sourceUrl).hostname; } catch { return null; }
}

function sellerLabel(candidate: ExternalCandidate) {
  return candidate.seller_name?.trim()
    || (candidate.seller_handle ? `@${candidate.seller_handle}` : null)
    || EXTERNAL_SOURCES[candidate.source as ExternalSourceId]?.name
    || candidate.source;
}

export async function promoteExternalCandidate(db: D1Database, input: PromoteExternalInput): Promise<PromoteExternalResult> {
  for (const value of [input.starts_at, input.ends_at]) {
    if (value !== undefined && value !== null && normalizeTimestamp(value) === null) return { ok: false, code: 'invalid_schedule', status: 400 };
  }
  const candidate = await db.prepare('SELECT * FROM external_candidates WHERE id = ?').bind(input.candidate_id).first<ExternalCandidate>();
  if (!candidate) return { ok: false, code: 'candidate_not_found', status: 404 };
  const selectedId = input.price_evidence_id ?? null;
  const requestHash = await digest(JSON.stringify([input, selectedId]));
  const previous = () => db.prepare('SELECT id,candidate_id,deal_id,request_hash FROM external_promotions WHERE request_id = ?')
    .bind(input.request_id).first<{ id: string; candidate_id: string; deal_id: string; request_hash: string | null }>();
  const replay = async (row: Awaited<ReturnType<typeof previous>>): Promise<PromoteExternalResult | null> => {
    if (!row) return null;
    if (row.candidate_id !== candidate.id || row.request_hash !== null && row.request_hash !== requestHash) return { ok: false, code: 'request_id_reused', status: 409 };
    return { ok: true, deal_id: row.deal_id, created: false, promotion_id: row.id };
  };
  const prior = await replay(await previous());
  if (prior) return prior;
  if (candidate.status === 'dismissed') return { ok: false, code: 'candidate_dismissed', status: 409 };
  if (candidate.status === 'promoted') {
    const dealId = candidate.promoted_deal_id;
    return dealId ? { ok: true, deal_id: dealId, created: false, promotion_id: 'existing' } : { ok: false, code: 'candidate_already_promoted', status: 409 };
  }
  const collision = () => db.prepare('SELECT id,verified_offer_id FROM deals WHERE source_url = ? ORDER BY verified_offer_id IS NULL LIMIT 1')
    .bind(candidate.source_url).first<{ id: string; verified_offer_id: string | null }>();
  if ((await collision())?.verified_offer_id) return { ok: false, code: 'offer_source_conflict', status: 409 };
  const revision = candidate.price_revision ?? 'legacy';
  const head = await currentReviewEvidence(db, 'candidate', candidate.id, revision);
  const observation = selectedId && selectedId !== head?.id ?
    await pendingPriceObservation(db, 'candidate', candidate.id, revision, selectedId) : null;
  const proof = observation ?? head;
  if (input.expected_revision !== undefined && input.expected_revision !== revision ||
      selectedId !== (proof?.id ?? null)) return { ok: false, code: 'stale_evidence', status: 409 };
  if (!await officialPriceAllowed(db, proof?.evidence ?? null)) return { ok: false, code: 'official_source_not_approved', status: 409 };
  const facts = proof?.result.facts;
  const title = (input.title ?? candidate.title).trim();
  if (!title || title.length > 200) return { ok: false, code: 'invalid_title', status: 400 };
  const price = facts?.deal_price_krw ?? (input.price !== undefined ? input.price : candidate.price_hint);
  if (!(price === null || price === undefined || (Number.isSafeInteger(price) && price >= 0))) {
    return { ok: false, code: 'invalid_price', status: 400 };
  }
  const selectedStart = input.starts_at !== undefined ? input.starts_at : candidate.starts_at;
  const selectedEnd = facts?.ends_at ?? (input.ends_at !== undefined ? input.ends_at : candidate.ends_at);
  const startsAt = normalizeTimestamp(selectedStart ?? null);
  const endsAt = normalizeTimestamp(selectedEnd ?? null);
  if (selectedStart != null && (typeof selectedStart !== 'string' || startsAt === null) || selectedEnd != null && (typeof selectedEnd !== 'string' || endsAt === null)) return { ok: false, code: 'invalid_schedule', status: 400 };
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) return { ok: false, code: 'invalid_schedule', status: 400 };
  const sourceEnded = detectSourceEnded({ ...candidate, text: proof?.evidence.offer?.source.text ?? candidate.text, ends_at: endsAt }, input.source_ended);
  let sellerId = input.seller_id ?? null;
  let createSeller = false;
  if (sellerId) {
    if (!await db.prepare('SELECT id FROM sellers WHERE id = ?').bind(sellerId).first()) {
      return { ok: false, code: 'invalid_seller', status: 400 };
    }
  } else {
    sellerId = await db.prepare('SELECT id FROM sellers WHERE name = ? ORDER BY id LIMIT 1').bind(sellerLabel(candidate)).first<{ id: string }>().then(r => r?.id ?? null);
    if (!sellerId) {
      sellerId = `ext-${candidate.source}-${(candidate.seller_handle ?? 'unknown').slice(0, 24)}`;
      createSeller = true;
    }
  }
  let modelId = input.model_id ?? null;
  if (modelId && !await db.prepare('SELECT id FROM models WHERE id = ?').bind(modelId).first()) {
    return { ok: false, code: 'invalid_model', status: 400 };
  }
  if (!modelId && candidate.model_match === 1 && candidate.suggestions) {
    try {
      const parsed = JSON.parse(candidate.suggestions) as { models?: { model_id?: string }[] };
      const first = parsed.models?.[0]?.model_id;
      if (first && await db.prepare('SELECT id FROM models WHERE id = ?').bind(first).first()) modelId = first;
    } catch { /* optional */ }
  }
  const bundle = input.bundle_items?.length ? input.bundle_items : facts ? bundleComponents(facts).map(product_name => ({ product_name } as BundleItemInput)) : [];
  if (bundle.length > 24) return { ok: false, code: 'bundle_too_large', status: 400 };
  for (const row of bundle) {
    if (!row.product_name?.trim() || row.product_name.length > 200) return { ok: false, code: 'invalid_bundle', status: 400 };
    if (row.model_id && !await db.prepare('SELECT id FROM models WHERE id = ?').bind(row.model_id).first()) {
      return { ok: false, code: 'invalid_bundle_model', status: 400 };
    }
    if (!(row.price === null || row.price === undefined || (Number.isSafeInteger(row.price) && row.price >= 0))) {
      return { ok: false, code: 'invalid_bundle_price', status: 400 };
    }
  }
  if (facts && (input.price != null && input.price !== facts.deal_price_krw ||
      input.ends_at != null && normalizeTimestamp(input.ends_at) !== facts.ends_at ||
      !await configurationMatches(db, facts, modelId, bundle.map(row => row.product_name)))) {
    return { ok: false, code: 'evidence_configuration_or_fact_conflict', status: 409 };
  }
  const now = new Date().toISOString();
  const dealId = crypto.randomUUID();
  const promotionId = crypto.randomUUID();
  const host = hostFromSource(candidate.source, candidate.source_url);
  const brandLabel = input.brand_label ?? null;
  const categoryLabel = input.category_label ?? candidate.category ?? null;
  const proofId = proof?.id ?? null;
  const guard = reviewEvidenceGuard('candidate', candidate.id, revision, proof, !!observation);
  const statements = [
    db.prepare(`INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,status,reviewed_at,attribution,attribution_note)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND NOT EXISTS (SELECT 1 FROM external_promotions WHERE request_id = ?)
      ON CONFLICT(source_url) DO NOTHING`)
      .bind(dealId, candidate.source_url, candidate.seller_handle ?? host ?? candidate.source, candidate.text, 'external_web', candidate.captured_at, 'approved', now, 'explicit',
        input.reason?.trim()?.slice(0, 300) ?? 'external_web_promote', ...guard.values, input.request_id),
    db.prepare(`INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at,image_url,status,version,updated_at,origin,external_candidate_id,source_host,source_ended,brand_label,category_label,promoted_by,promoted_at,${priceColumns})
      SELECT id,?,?,?, ?,source_url,'manual',?,?,?,NULL,'published',1,?,'external_web',?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?
      FROM ingested_items WHERE id = ?`)
      .bind(modelId, sellerId, title, price ?? null, now, startsAt, endsAt, now, candidate.id, host, sourceEnded ? 1 : 0, brandLabel, categoryLabel, input.promoted_by, now,
        ...priceBindings(proof?.result ?? null, proofId, 1), dealId),
    db.prepare(`INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at,price_evidence_id)
      SELECT ?,id,1,'promote_external',?,?,?,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,?,price_evidence_id FROM deals WHERE id = ?`)
      .bind(crypto.randomUUID(), input.request_id, requestHash, input.reason?.trim() ?? null, now, dealId),
    db.prepare("UPDATE external_candidates SET status = 'promoted', reviewed_at = ?, promoted_deal_id = ? WHERE id = ? AND status = 'candidate' AND EXISTS (SELECT 1 FROM deals WHERE id = ?)")
      .bind(now, dealId, candidate.id, dealId),
    db.prepare(`INSERT INTO external_promotions (id,candidate_id,deal_id,source_url,promoted_by,promoted_at,request_id,request_hash)
      SELECT ?,?,id,source_url,?,?,?,? FROM deals WHERE id = ?`)
      .bind(promotionId, candidate.id, input.promoted_by, now, input.request_id, requestHash, dealId),
  ];
  if (createSeller) {
    statements.splice(1, 0, db.prepare(`INSERT INTO sellers (id,name,source_url)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM ingested_items WHERE id = ?) ON CONFLICT DO NOTHING`)
      .bind(sellerId, sellerLabel(candidate), candidate.seller_url ?? `https://${host ?? 'example.invalid'}/`, dealId));
  }
  for (const [index, row] of bundle.entries()) {
    statements.push(db.prepare(`INSERT INTO deal_bundle_items (id,deal_id,position,brand,product_name,model_id,price)
      SELECT ?,id,?,?,?,?,? FROM deals WHERE id = ?`)
      .bind(crypto.randomUUID(), index, row.brand ?? null, row.product_name.trim(), row.model_id ?? null, row.price ?? null, dealId));
  }
  let results;
  try { results = await db.batch(statements); }
  catch (error) {
    if (/offer_source_conflict/.test(String(error))) return { ok: false, code: 'offer_source_conflict', status: 409 };
    throw error;
  }
  if (!results[0].meta.changes) {
    const concurrent = await replay(await previous());
    if (concurrent) return concurrent;
    const again = await collision();
    if (again?.verified_offer_id) return { ok: false, code: 'offer_source_conflict', status: 409 };
    if (again) return { ok: true, deal_id: again.id, created: false, promotion_id: 'existing' };
    return { ok: false, code: 'stale_evidence', status: 409 };
  }
  return { ok: true, deal_id: dealId, created: true, promotion_id: promotionId };
}
