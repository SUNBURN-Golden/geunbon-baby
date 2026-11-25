import { OFFICIAL_PRICE_MAX_AGE_MS } from '../shared/deal-price-evidence';
import { timestampSql } from './deal-query-sql';

export const verifiedStart = 'verified_start_utc';
export const verifiedStartColumnSql = `${verifiedStart} TEXT GENERATED ALWAYS AS (
    CASE WHEN price_verification = 'verified' THEN ${timestampSql('starts_at')} END
  ) STORED`;

function verifiedPriceFacts(prefix = '') {
  const field = (name: string) => prefix + name;
  const end = field('ends_at');
  const checked = field('price_checked_at');
  const canonical = (f: string) => `${f} = strftime('%Y-%m-%dT%H:%M:%fZ', ${f}, '+0 seconds')`;
  return `${field('status')} = 'published' AND ${field('price_verification')} = 'verified'
    AND ${field('price_evidence_id')} IS NOT NULL AND ${field('price_evidence_version')} = ${field('version')}
    AND ${field('deal_price_krw')} >= 0 AND ${field('list_price_krw')} > 0 AND ${field('discount_pct')} > 0
    AND ${canonical(end)} AND ${canonical(checked)}
    AND ${field('price_source_url')} GLOB 'https://?*' AND ${field('list_price_source_url')} GLOB 'https://?*'`;
}

export const verifiedPriceColumnSql = `verified_price_ready INTEGER GENERATED ALWAYS AS (
    CASE WHEN ${verifiedPriceFacts()} THEN 1 ELSE 0 END
  ) STORED`;

export const verifiedDealPredicate = (prefix = '') => `${prefix}verified_price_ready = 1`;

export const officialProofExpiry = (checked: string) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${checked}, '+${OFFICIAL_PRICE_MAX_AGE_MS / 1000} seconds')`;

export function publicDealEligibility(alias = 'deals', nowMs: number | string = Date.now()) {
  const now = typeof nowMs === 'number' ? `'${new Date(nowMs).toISOString()}'` : nowMs;
  return `${verifiedDealPredicate(alias === 'deals' ? '' : alias + '.')}
    AND EXISTS (SELECT 1 FROM ingested_items AS approval WHERE approval.id = ${alias}.id AND approval.status = 'approved')
    AND EXISTS (${publicDealApprovalQuery(alias, now, '1')})`;
}

export const publicDealApprovalExpiry = (alias: string, now: string) =>
  publicDealApprovalQuery(alias, now, "MIN(json_extract(scope.value, '$.expires_at'))");

function publicDealApprovalQuery(alias: string, now: string, select: string) {
  return `SELECT ${select} FROM deal_price_evidence AS proof
      JOIN official_price_approvals AS authority ON authority.id = 1
      JOIN json_each(authority.scopes) AS scope
      WHERE proof.id = ${alias}.price_evidence_id AND proof.outcome = 'verified'
      AND (proof.target_id = ${alias}.id AND proof.target_kind = 'deal'
        AND (proof.target_revision = CAST(${alias}.version AS TEXT)
          OR EXISTS (SELECT 1 FROM deal_revisions r WHERE r.deal_id = ${alias}.id
            AND r.version = ${alias}.version AND r.price_evidence_id = proof.id))
        OR proof.target_id = ${alias}.id AND proof.target_kind = 'ingest'
          AND EXISTS (SELECT 1 FROM ingested_items i WHERE i.id = ${alias}.id AND i.captured_at = proof.target_revision)
        OR proof.target_id = ${alias}.external_candidate_id AND proof.target_kind = 'candidate'
          AND EXISTS (SELECT 1 FROM external_candidates c WHERE c.id = proof.target_id AND c.price_revision = proof.target_revision))
      AND json_extract(scope.value, '$.id') = json_extract(proof.body, '$.official_approval.id')
      AND json_extract(scope.value, '$.revision') = json_extract(proof.body, '$.official_approval.revision')
      AND json_extract(scope.value, '$.variant') IS json_extract(proof.body, '$.official_approval.variant')
      AND json_extract(scope.value, '$.url') = ${alias}.list_price_source_url
      AND json_extract(proof.body, '$.official.source.url') = ${alias}.list_price_source_url
      AND json_extract(proof.body, '$.offer.source.url') = ${alias}.price_source_url
      AND json_extract(proof.body, '$.official.source.observed_at') = ${alias}.price_checked_at
      AND json_extract(scope.value, '$.approved_at') <= ${alias}.price_checked_at
      AND ${alias}.price_checked_at < json_extract(scope.value, '$.expires_at')
      AND json_extract(scope.value, '$.expires_at') > ${now}
      AND ${officialProofExpiry(alias + '.price_checked_at')} > ${now}`;
}

export const eligible = verifiedDealPredicate();
export const naturalVerified = `${eligible} AND source_ended = 0`;
export const verifiedInterval = `${naturalVerified} AND ${verifiedStart} IS NOT NULL AND ${verifiedStart} <= ends_at`;
export const activeStart = `COALESCE(${verifiedStart}, '0000-01-01T00:00:00.000Z')`;
export const verifiedActive = `${naturalVerified} AND ((${verifiedStart} IS NULL AND orders_open = 1) OR (${verifiedStart} IS NOT NULL AND ${verifiedStart} <= ends_at))`;
export const verifiedEndOnly = `${naturalVerified} AND ${verifiedStart} IS NULL`;
export const verifiedClosed = `${eligible} AND source_ended = 1`;
export const verifiedUnknown = `${naturalVerified} AND ${verifiedStart} > ends_at`;
export const verifiedDealIndexes = [
  ['verified_deal_chronology', 'starts_at, id', eligible],
  ['verified_deal_model_chronology', 'model_id, starts_at, id', eligible],
  ['verified_deal_ending', `ends_at, id, ${activeStart}`, verifiedActive],
  ['verified_deal_discount', `(-discount_pct), ends_at, id, ${activeStart}`, verifiedActive],
  ['verified_deal_model_active', `model_id, ends_at, ${activeStart}, deal_price_krw`, verifiedActive],
  ['verified_deal_upcoming', `${verifiedStart}, id`, verifiedInterval],
  ['verified_deal_ended', 'ends_at DESC, id', verifiedInterval],
  ['verified_deal_end_only_ended', 'ends_at DESC, id', verifiedEndOnly],
  ['verified_deal_end_only_unknown', 'ends_at, id', verifiedEndOnly],
  ['verified_deal_closed', 'ends_at DESC, id', verifiedClosed],
  ['verified_deal_unknown', 'ends_at, id', verifiedUnknown],
] as const;

export const verifiedDealIndexSql = verifiedDealIndexes.map(([name, keys, predicate]) =>
  `CREATE INDEX ${name} ON deals (${keys}) WHERE ${predicate};`).join('\n\n') + '\n';
