import { EXTERNAL_SOURCES, type ExternalCandidate, type ExternalSourceId, externalSourceIds } from './data';
import { normalizeTimestamp, parseTimestamp } from './deals';

export type BundleItemInput = {
  brand?: string | null;
  product_name: string;
  model_id?: string | null;
  price?: number | null;
};

export type PromoteExternalInput = {
  candidate_id: string;
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

const endedPattern = /종료|마감(?:됨|완료)?|closed|ended/i;

export function detectSourceEnded(candidate: Pick<ExternalCandidate, 'text' | 'dates_raw' | 'ends_at'>, override?: boolean) {
  if (override === true) return true;
  if (override === false) return false;
  const blob = `${candidate.text}\n${candidate.dates_raw ?? ''}`;
  if (endedPattern.test(blob)) return true;
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
  const candidate = await db.prepare('SELECT * FROM external_candidates WHERE id = ?').bind(input.candidate_id).first<ExternalCandidate>();
  if (!candidate) return { ok: false, code: 'candidate_not_found', status: 404 };
  const existingPromotion = await db.prepare(
    'SELECT deal_id FROM external_promotions WHERE candidate_id = ? OR source_url = ?',
  ).bind(candidate.id, candidate.source_url).first<{ deal_id: string }>();
  if (existingPromotion) {
    return { ok: true, deal_id: existingPromotion.deal_id, created: false, promotion_id: 'existing' };
  }
  const dupDeal = await db.prepare("SELECT id FROM deals WHERE origin = 'external_web' AND source_url = ?").bind(candidate.source_url).first<{ id: string }>();
  if (dupDeal) return { ok: true, deal_id: dupDeal.id, created: false, promotion_id: 'existing' };
  if (candidate.status === 'dismissed') return { ok: false, code: 'candidate_dismissed', status: 409 };
  if (candidate.status === 'promoted') {
    const dealId = candidate.promoted_deal_id ?? (await db.prepare("SELECT id FROM deals WHERE origin = 'external_web' AND source_url = ?").bind(candidate.source_url).first<{ id: string }>())?.id;
    if (dealId) return { ok: true, deal_id: dealId, created: false, promotion_id: 'existing' };
    return { ok: false, code: 'candidate_already_promoted', status: 409 };
  }
  const title = (input.title ?? candidate.title).trim();
  if (!title || title.length > 200) return { ok: false, code: 'invalid_title', status: 400 };
  const price = input.price !== undefined ? input.price : candidate.price_hint;
  if (!(price === null || price === undefined || (Number.isSafeInteger(price) && price >= 0))) {
    return { ok: false, code: 'invalid_price', status: 400 };
  }
  const startsAt = normalizeTimestamp(input.starts_at ?? candidate.starts_at ?? null);
  const endsAt = normalizeTimestamp(input.ends_at ?? candidate.ends_at ?? null);
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) return { ok: false, code: 'invalid_schedule', status: 400 };
  const sourceEnded = detectSourceEnded(candidate, input.source_ended);
  let sellerId = input.seller_id ?? null;
  if (sellerId) {
    if (!await db.prepare('SELECT id FROM sellers WHERE id = ?').bind(sellerId).first()) {
      return { ok: false, code: 'invalid_seller', status: 400 };
    }
  } else {
    sellerId = await db.prepare('SELECT id FROM sellers WHERE name = ? ORDER BY id LIMIT 1').bind(sellerLabel(candidate)).first<{ id: string }>().then(r => r?.id ?? null);
    if (!sellerId) {
      sellerId = `ext-${candidate.source}-${(candidate.seller_handle ?? 'unknown').slice(0, 24)}`;
      const label = sellerLabel(candidate);
      await db.prepare('INSERT INTO sellers (id, name, source_url) VALUES (?,?,?) ON CONFLICT DO NOTHING')
        .bind(sellerId, label, candidate.seller_url ?? `https://${hostFromSource(candidate.source, candidate.source_url) ?? 'example.invalid'}/`).run();
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
  const bundle = input.bundle_items ?? [];
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
  const now = new Date().toISOString();
  const dealId = crypto.randomUUID();
  const promotionId = crypto.randomUUID();
  const host = hostFromSource(candidate.source, candidate.source_url);
  const verifyLevel = 'manual';
  const brandLabel = input.brand_label ?? null;
  const categoryLabel = input.category_label ?? candidate.category ?? null;
  const statements = [
    db.prepare(`INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,status,reviewed_at,attribution,attribution_note)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_url) DO NOTHING`)
      .bind(dealId, candidate.source_url, candidate.seller_handle ?? host ?? candidate.source, candidate.text, 'external_web', candidate.captured_at, 'approved', now, 'explicit', input.reason?.trim()?.slice(0, 300) ?? 'external_web_promote'),
    db.prepare(`INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at,image_url,status,version,updated_at,origin,external_candidate_id,source_host,source_ended,brand_label,category_label,promoted_by,promoted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'published',1,?,'external_web',?,?,?,?,?,?,?)
      ON CONFLICT(id) DO NOTHING`)
      .bind(dealId, modelId, sellerId, title, price ?? null, candidate.source_url, verifyLevel, now, startsAt, endsAt, now, candidate.id, host, sourceEnded ? 1 : 0, brandLabel, categoryLabel, input.promoted_by, now),
    db.prepare(`INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at)
      VALUES (?,?,1,'promote_external',?,?,?,?,?,?,?,?,?,NULL,?, 'published',?) ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), dealId, input.request_id, input.request_id, input.reason?.trim() ?? null, modelId, sellerId, title, price ?? null, startsAt, endsAt, now, now),
    db.prepare("UPDATE external_candidates SET status = 'promoted', reviewed_at = ?, promoted_deal_id = ? WHERE id = ? AND status = 'candidate'")
      .bind(now, dealId, candidate.id),
    db.prepare('INSERT INTO external_promotions (id,candidate_id,deal_id,source_url,promoted_by,promoted_at,request_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(promotionId, candidate.id, dealId, candidate.source_url, input.promoted_by, now, input.request_id),
  ];
  bundle.forEach((row, index) => {
    statements.push(db.prepare('INSERT INTO deal_bundle_items (id,deal_id,position,brand,product_name,model_id,price) VALUES (?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), dealId, index, row.brand ?? null, row.product_name.trim(), row.model_id ?? null, row.price ?? null));
  });
  const results = await db.batch(statements);
  if (!results[1].meta.changes) {
    const again = await db.prepare("SELECT id FROM deals WHERE source_url = ?").bind(candidate.source_url).first<{ id: string }>();
    if (again) return { ok: true, deal_id: again.id, created: false, promotion_id: 'existing' };
    return { ok: false, code: 'promote_failed', status: 409 };
  }
  return { ok: true, deal_id: dealId, created: true, promotion_id: promotionId };
}
