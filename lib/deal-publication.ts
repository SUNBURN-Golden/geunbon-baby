import { configurationFields, metadataStart, type Configuration, type PriceEvidence } from '../shared/deal-price-evidence';
import { normalizeTimestamp } from './deals';

// Legacy offers have no accepted metadata reading for the opening. Only use a
// matching explicit start in the captured offer, never the approval timestamp.
export function evidencedOpening(evidence: PriceEvidence | undefined, startsAt: string | null) {
  const opening = normalizeTimestamp(startsAt);
  if (!opening) return null;
  const found = new Set(evidence?.offer?.source.text.split('\n').map(metadataStart).filter(Boolean));
  return found.size === 1 && found.has(opening) ? opening : null;
}

export function recordPublishedPrice(db: D1Database, dealId: string, requestId: string, opening: string | null = null, configuration?: Configuration) {
  const key = configuration ? JSON.stringify(configurationFields.map(field =>
    configuration[field].trim().replace(/[A-Z]/g, char => char.toLowerCase()))) : null;
  return db.prepare(`INSERT INTO deal_price_history
    SELECT fresh.deal_id,fresh.deal_version,fresh.price_evidence_id,fresh.deal_price_krw,
      COALESCE(fresh.configuration_key,?,prior.configuration_key),fresh.approval_scope,
      fresh.price_checked_at,fresh.published_at,
      COALESCE(fresh.opened_at,?,CASE WHEN prior.opened_at=d.verified_start_utc THEN prior.opened_at END)
    FROM hook_publication_evidence fresh
    JOIN deals d ON d.id=fresh.deal_id
    LEFT JOIN deal_price_history prior ON prior.deal_id=fresh.deal_id AND prior.deal_version=fresh.deal_version-1
      AND prior.price_evidence_id=fresh.price_evidence_id
    WHERE fresh.deal_id=? AND fresh.request_id=?
    ON CONFLICT DO NOTHING`).bind(key, opening, dealId, requestId);
}

export function carryClosedRound(db: D1Database, dealId: string, version: number, requestId: string) {
  return db.prepare(`INSERT INTO deal_round_reviews(deal_id,deal_version,round_id,source_url,reviewed_at)
    SELECT prior.deal_id,d.version,prior.round_id,prior.source_url,prior.reviewed_at
    FROM deals d JOIN deal_round_reviews prior ON prior.deal_id=d.id AND prior.deal_version=d.version-1
    JOIN deal_revisions r ON r.deal_id=d.id AND r.version=d.version AND r.request_id=?
    JOIN deal_revisions old ON old.deal_id=d.id AND old.version=prior.deal_version
      AND old.seller_id=d.seller_id AND old.model_id IS d.model_id
      AND old.starts_at IS d.starts_at AND old.ends_at IS d.ends_at
    WHERE d.id=? AND d.version=? AND d.status='published' AND d.source_ended=1
    ON CONFLICT DO NOTHING`).bind(requestId, dealId, version);
}
