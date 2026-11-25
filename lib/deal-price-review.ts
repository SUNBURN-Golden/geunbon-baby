import { carryClosedRound, evidencedOpening, recordPublishedPrice } from './deal-publication';
import { assessPriceEvidence, digest, displayExclusion, filterOfferCapture, identityToken, offerSourceClosed, parsePriceEvidence, withoutStandaloneClosure, type PriceEvidence, type PriceResult, type VerifiedPrices } from '../shared/deal-price-evidence';
import { canonicalUrl } from '../shared/privacy-rules';
import { normalizeTimestamp } from './deals';
import { officialPriceAllowed, officialPriceGuard } from './official-price-sources';
import { publicDealEligibility } from './verified-deal-sql';

export type PriceTargetKind = 'ingest' | 'candidate' | 'deal';
export type PriceTarget = {
  id: string; source_url: string; revision: string; status: string; model_id?: string | null; price?: number | null;
  starts_at?: string | null; ends_at?: string | null; price_checked_at?: string | null; price_evidence_id?: string | null; price_evidence_version?: number | null;
  price_verification?: string; capture_text: string | null;
};
export const priceTargetTables = {
  ingest: { table: 'ingested_items', revision: 'captured_at', status: 'pending' },
  candidate: { table: 'external_candidates', revision: 'price_revision', status: 'candidate' },
  deal: { table: 'deals', revision: 'CAST(version AS TEXT)', status: 'published' },
} as const;
export function priceCaptureSql(kind: PriceTargetKind) {
  return kind === 'deal' ? `COALESCE(
    (SELECT c.text FROM external_candidates c WHERE c.id = deals.external_candidate_id),
    (SELECT i.text FROM ingested_items i WHERE i.id = deals.id))` : 'text';
}

export async function priceTarget(db: D1Database, kind: PriceTargetKind, id: string) {
  const { table, revision } = priceTargetTables[kind];
  return db.prepare(`SELECT *, ${revision} AS revision, ${priceCaptureSql(kind)} AS capture_text FROM ${table} WHERE id = ?`).bind(id).first<PriceTarget>();
}

export function externalPriceSource(db: D1Database, id: string) {
  return db.prepare("SELECT source_url FROM deals WHERE id = ? AND origin = 'external_web'")
    .bind(id).first<{ source_url: string }>();
}

export function nextExternalPriceTarget(db: D1Database, cursor: string, relatedTo: string | null = null) {
  return db.prepare(`SELECT d.id,d.source_url,CAST(d.version AS TEXT) AS revision,
      json_extract(p.body,'$.offer.source.hash') AS capture_hash,
      json_extract(p.body,'$.official.source.hash') AS official_hash,
      json_extract(p.body,'$.official_approval') AS authority,
      d.price_checked_at, CASE WHEN d.price_verification = 'verified' THEN p.body END AS prior
    FROM deals d JOIN ingested_items i ON i.id = d.id AND i.status = 'approved'
    LEFT JOIN deal_price_evidence p ON p.id = d.price_evidence_id
    WHERE d.status = 'published' AND d.origin = 'external_web' AND d.id > ?
      AND (? IS NULL OR d.id <> ? AND d.list_price_source_url =
        (SELECT target.list_price_source_url FROM deals target WHERE target.id = ?))
    ORDER BY d.id LIMIT 1`)
    .bind(cursor, relatedTo, relatedTo, relatedTo).first();
}

export function sameOffer(left: string, right: string) {
  if (left === right) return true;
  try { return canonicalUrl(left) === canonicalUrl(right); } catch { return false; }
}
export async function validatedEvidence(value: unknown, url: string) {
  const evidence = await parsePriceEvidence(value);
  return evidence && sameOffer(evidence.offer_url, url) ? evidence : null;
}
export function reviewEvidenceGuard(kind: 'ingest' | 'candidate', id: string, revision: string, proof: Pick<PriceReview, 'id' | 'evidence'> | null, observation = false) {
  const authority = officialPriceGuard(proof?.evidence ?? null);
  if (observation) return {
    sql: `${evidenceCurrent(kind)} AND EXISTS (SELECT 1 FROM deal_price_evidence p
      JOIN deal_price_backfill_receipts r ON r.observation_id = p.id
      WHERE p.target_kind = ? AND p.target_id = ? AND p.target_revision = ? AND p.id = ?
      AND r.outcome IN ('capture_changed','legacy_hash_missing')) AND ${authority.sql}`,
    values: [...evidenceCurrentArgs(kind, id, revision), kind, id, revision, proof?.id ?? null, ...authority.values],
  };
  return {
    sql: `${evidenceCurrent(kind)} AND (SELECT evidence_id FROM deal_price_evidence_heads
      WHERE target_kind = ? AND target_id = ? AND target_revision = ?) IS ? AND ${authority.sql}`,
    values: [...evidenceCurrentArgs(kind, id, revision), kind, id, revision, proof?.id ?? null, ...authority.values],
  };
}
function evidenceCurrent(kind: PriceTargetKind) {
  const { table, revision } = priceTargetTables[kind];
  return `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND ${revision} = ? AND status = ?
    ${kind === 'deal' ? "AND EXISTS (SELECT 1 FROM ingested_items i WHERE i.id = deals.id AND i.status = 'approved')" : ''})`;
}
function evidenceCurrentArgs(kind: PriceTargetKind, id: string, revision: string) {
  return [id, revision, priceTargetTables[kind].status];
}

async function evidenceRecord(kind: PriceTargetKind, target: PriceTarget, evidence: PriceEvidence) {
  const body = JSON.stringify(evidence), result = assessPriceEvidence(evidence);
  const id = await digest(JSON.stringify([kind, target.id, target.revision, body]));
  return { id, body, result, evidence };
}
function insertEvidence(db: D1Database, kind: PriceTargetKind, target: PriceTarget, proof: Awaited<ReturnType<typeof evidenceRecord>>, now: string, operation?: { key: string; id: string }) {
  const authority = officialPriceGuard(operation ? null : proof.evidence);
  const observed = proof.evidence.offer?.source.observed_at ?? (kind === 'ingest' ? normalizeTimestamp(target.revision) : null) ?? now;
  return db.prepare(`INSERT INTO deal_price_evidence (id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${evidenceCurrent(kind)} AND ${authority.sql}
      ${operation ? '' : `AND EXISTS (SELECT 1 FROM ${priceTargetTables[kind].table} WHERE id = ? AND text IS ?)`}
      ${operation ? 'AND EXISTS (SELECT 1 FROM deal_price_backfill_receipts WHERE request_id = ? AND operation_id = ?)' : ''}
      ON CONFLICT(id) DO NOTHING`)
    .bind(proof.id, kind, target.id, target.revision, proof.result.outcome, proof.body, now, observed,
      ...evidenceCurrentArgs(kind, target.id, target.revision), ...authority.values,
      ...(operation ? [] : [target.id, target.capture_text]),
      ...(operation ? [operation.key, operation.id] : []));
}
function updateHead(db: D1Database, kind: PriceTargetKind, target: PriceTarget, proofId: string) {
  return db.prepare(`INSERT INTO deal_price_evidence_heads (target_kind,target_id,target_revision,evidence_id)
    SELECT ?,?,?,? WHERE ${evidenceCurrent(kind)} AND EXISTS (SELECT 1 FROM deal_price_evidence WHERE id = ?)
    ON CONFLICT(target_kind,target_id,target_revision) DO UPDATE SET evidence_id = excluded.evidence_id
    WHERE deal_price_evidence_heads.evidence_id <> excluded.evidence_id
      AND (SELECT observed_at,rowid FROM deal_price_evidence WHERE id = excluded.evidence_id) >
          (SELECT observed_at,rowid FROM deal_price_evidence WHERE id = deal_price_evidence_heads.evidence_id)`)
    .bind(kind, target.id, target.revision, proofId, ...evidenceCurrentArgs(kind, target.id, target.revision), proofId);
}
type SocialCapture = { text: string; capturedAt: string; suggestions: string | null };
export async function stageIngestEvidence(db: D1Database, kind: 'ingest' | 'candidate', id: string, evidence: PriceEvidence, expected?: string, social?: SocialCapture) {
  const target = await priceTarget(db, kind, id);
  if (!target || target.status !== priceTargetTables[kind].status || (expected !== undefined && expected !== target.revision) ||
      !sameOffer(evidence.offer_url, target.source_url)) return null;
  const statements: D1PreparedStatement[] = [];
  if (social && target.capture_text !== social.text) {
    if (!evidence.offer || assessPriceEvidence(evidence).outcome === 'provider_retryable' ||
        Date.parse(social.capturedAt) <= Date.parse(target.revision)) return null;
    const authority = officialPriceGuard(evidence);
    statements.push(db.prepare(`UPDATE ingested_items SET text = ?, captured_at = ?, suggestions = ?
      WHERE id = ? AND status = 'pending' AND captured_at = ? AND ${authority.sql}
        AND NOT EXISTS (SELECT 1 FROM deal_price_evidence_heads h JOIN deal_price_evidence p ON p.id = h.evidence_id
          WHERE h.target_kind = 'ingest' AND h.target_id = ? AND h.target_revision = ? AND p.observed_at >= ?)`)
      .bind(social.text, social.capturedAt, social.suggestions, id, target.revision, ...authority.values,
        id, target.revision, evidence.offer.source.observed_at));
    target.revision = social.capturedAt;
    target.capture_text = social.text;
  }
  if (evidence.offer && evidence.offer.source.text !== filterOfferCapture(target.capture_text ?? '')) return null;
  const proof = await evidenceRecord(kind, target, evidence);
  const now = new Date().toISOString();
  await db.batch([...statements, insertEvidence(db, kind, target, proof, now), updateHead(db, kind, target, proof.id)]);
  const selected = await db.prepare('SELECT evidence_id FROM deal_price_evidence_heads WHERE target_kind = ? AND target_id = ? AND target_revision = ?')
    .bind(kind, id, target.revision).first<{ evidence_id: string }>();
  return selected?.evidence_id === proof.id ? { id: proof.id, outcome: proof.result.outcome, revision: target.revision } : null;
}
export async function currentReviewEvidence(db: D1Database, kind: 'ingest' | 'candidate', id: string, revision: string) {
  const row = await db.prepare(`SELECT p.id,p.body FROM deal_price_evidence_heads AS h
    JOIN deal_price_evidence AS p ON p.id = h.evidence_id
    WHERE h.target_kind = ? AND h.target_id = ? AND h.target_revision = ?`).bind(kind, id, revision).first<{ id: string; body: string }>();
  if (!row) return null;
  const evidence = await parsePriceEvidence(JSON.parse(row.body));
  return evidence ? { id: row.id, evidence, result: assessPriceEvidence(evidence) } : null;
}
export function bundleComponents(facts: VerifiedPrices) {
  const components = facts.configuration.bundle.trim();
  return /^(?:없음|단품|none|standalone)$/i.test(components) ? [] : components.split(/[,;+·]/).map(name => name.trim());
}

export async function configurationMatches(db: D1Database, facts: VerifiedPrices, modelId: string | null, bundle: string[] = []) {
  if (!modelId) return false;
  const model = await db.prepare('SELECT brand,name FROM models WHERE id = ?').bind(modelId).first<{ brand: string; name: string }>();
  if (!model) return false;
  const { brand, model: name } = facts.configuration;
  const components = bundleComponents(facts);
  const normalized = components.map(identityToken).sort();
  return normalized.every(Boolean) && identityToken(brand) === identityToken(model.brand) && identityToken(name) === identityToken(model.name) &&
    JSON.stringify(bundle.map(identityToken).sort()) === JSON.stringify(normalized);
}
export function priceBindings(result: PriceResult | null, evidenceId: string | null, version: number) {
  const facts = result?.facts;
  return [
    facts?.deal_price_krw ?? null, facts?.list_price_krw ?? null, facts?.price_source_url ?? null,
    facts?.list_price_source_url ?? null, facts?.price_checked_at ?? null, facts ? 'verified' : 'unverified',
    evidenceId, evidenceId ? version : null, facts?.orders_open ? 1 : 0,
  ];
}
export const priceColumns = 'deal_price_krw,list_price_krw,price_source_url,list_price_source_url,price_checked_at,price_verification,price_evidence_id,price_evidence_version,orders_open';

export type PriceObservationReceipt = { error?: string; outcome?: string; observation_id?: string; revision?: string };
export async function recordBackfill(db: D1Database, kind: PriceTargetKind, id: string, expected: string, key: string, value: unknown, live = false, pinnedReason?: 'capture_changed' | 'legacy_hash_missing'): Promise<PriceObservationReceipt> {
  const target = await priceTarget(db, kind, id);
  if (!target) return { error: 'target_not_found' };
  const evidence = await validatedEvidence(value, target.source_url);
  if (!evidence) return { error: 'invalid_evidence' };
  const proof = await evidenceRecord(kind, { ...target, revision: expected }, evidence);
  const requestHash = await digest(JSON.stringify([kind, id, expected, proof.id, pinnedReason ?? null]));
  const replay = async () => {
    const result = await db.prepare('SELECT request_hash,outcome,observation_id,revision FROM deal_price_backfill_receipts WHERE request_id = ?')
      .bind(key).first<{ request_hash: string; outcome: string; observation_id: string; revision: string }>();
    return result ? result.request_hash === requestHash ? { outcome: result.outcome, observation_id: result.observation_id, revision: result.revision } : { error: 'request_id_reused' } : null;
  };
  const prior = await replay();
  if (prior) return prior;
  if (target.revision !== expected || target.status !== priceTargetTables[kind].status) return { error: 'superseded' };
  const offerText = evidence.offer?.source.text;
  const captureChanged = !!offerText && offerText !== filterOfferCapture(target.capture_text ?? '');
  const captureReason = pinnedReason ?? (captureChanged ? target.capture_text ? 'capture_changed' : 'legacy_hash_missing' : null);
  const closed = !!offerText && offerSourceClosed(offerText);
  if (proof.result.outcome === 'provider_retryable' && !(live && closed)) return { outcome: 'provider_retryable' };
  if (!await officialPriceAllowed(db, evidence)) return { error: 'official_source_not_approved' };
  const now = new Date().toISOString();
  const facts = proof.result.facts;
  let outcome: string = facts ? displayExclusion(facts.deal_price_krw, facts.list_price_krw) ?? 'verified' : proof.result.outcome;
  let application = proof.result;
  let retainPrices = false;
  let invalidateRelated = false;
  let stageOnly = kind !== 'deal' && !!captureReason;
  const normalizedStart = normalizeTimestamp(target.starts_at);
  if (kind === 'deal') {
    const old = target.price_evidence_id ? await db.prepare('SELECT body FROM deal_price_evidence WHERE id = ?').bind(target.price_evidence_id).first<{ body: string }>() : null;
    const oldEvidence = old ? await parsePriceEvidence(JSON.parse(old.body)) : null;
    const oldFacts = oldEvidence ? assessPriceEvidence(oldEvidence).facts : null;
    const observed = evidence.offer?.source.observed_at;
    const last = live ? await db.prepare(`SELECT p.observed_at FROM deal_revisions r JOIN deal_price_evidence p ON p.id = r.price_evidence_id
      WHERE r.deal_id = ? AND r.action = 'verify_prices' ORDER BY r.version DESC LIMIT 1`).bind(id).first<{ observed_at: string }>() : null;
    const oldObserved = [oldEvidence?.offer?.source.observed_at, last?.observed_at].filter(Boolean).sort().at(-1);
    if (live ? !observed || !!oldObserved && observed <= oldObserved : observed && oldObserved && observed < oldObserved) {
      return live ? { outcome: 'superseded' } : { error: 'superseded' };
    }
    const bundles = (await db.prepare('SELECT product_name FROM deal_bundle_items WHERE deal_id = ? ORDER BY position').bind(id).all<{ product_name: string }>()).results;
    if (facts && (
      live && !oldFacts ||
      !await configurationMatches(db, facts, target.model_id ?? null, bundles.map(row => row.product_name)) ||
      target.price != null && target.price !== facts.deal_price_krw ||
      target.ends_at != null && normalizeTimestamp(target.ends_at) !== facts.ends_at ||
      target.starts_at != null && target.starts_at !== '' && (!normalizedStart || normalizedStart >= facts.ends_at) ||
      oldFacts && (oldFacts.deal_price_krw !== facts.deal_price_krw || oldFacts.list_price_krw !== facts.list_price_krw ||
        oldFacts.list_price_source_url !== facts.list_price_source_url || oldFacts.price_source_url !== facts.price_source_url ||
        Object.keys(facts.configuration).some(key => {
          const field = key as keyof VerifiedPrices['configuration'];
          return identityToken(oldFacts.configuration[field]) !== identityToken(facts.configuration[field]);
        }))
    )) {
      outcome = live && !oldFacts ? 'first_proof_requires_review' : 'prior_fact_conflict';
      application = { outcome: 'configuration_mismatch' };
    }
    const officialChanged = !!oldFacts && !!evidence.official && (
      !facts || oldFacts.list_price_krw !== facts.list_price_krw ||
      oldFacts.list_price_source_url !== facts.list_price_source_url ||
      JSON.stringify(oldEvidence?.official_approval?.variant ?? null) !== JSON.stringify(evidence.official_approval?.variant ?? null)
    );
    invalidateRelated = officialChanged && oldFacts.list_price_source_url === evidence.official?.source.url;
    if (!facts && closed && oldEvidence?.offer && offerText &&
        withoutStandaloneClosure(offerText) === oldEvidence.offer.source.text && !officialChanged) {
      const currentProof = await db.prepare(`SELECT 1 FROM deals WHERE id = ? AND ${publicDealEligibility()}`).bind(id).first();
      retainPrices = !!currentProof;
      if (retainPrices) outcome = 'source_closed';
    }
    if (live && !retainPrices && !facts && (outcome === 'source_inaccessible' || outcome === 'provider_retryable') &&
        (!offerText || offerText === oldEvidence?.offer?.source.text)) return { outcome };
    if (!live && captureReason) {
      stageOnly = true;
      outcome = captureReason;
      application = { outcome: 'configuration_mismatch' };
    }
    if (facts && !application.facts) stageOnly = true;
  }
  if (kind !== 'deal') {
    if (captureReason) outcome = captureReason;
    const latest = await currentReviewEvidence(db, kind, id, expected);
    const observed = evidence.offer?.source.observed_at;
    if (observed && latest?.evidence.offer && observed < latest.evidence.offer.source.observed_at) return { error: 'superseded' };
  }
  const authority = officialPriceGuard(evidence);
  const guard = `${evidenceCurrent(kind)} AND ${authority.sql}${!live && offerText ?
    ` AND EXISTS (SELECT 1 FROM ${priceTargetTables[kind].table} WHERE id = ? AND ${priceCaptureSql(kind)} IS ?)` : ''}`;
  const guardArgs = [...evidenceCurrentArgs(kind, id, expected), ...authority.values, ...(!live && offerText ? [id, target.capture_text] : [])];
  const receiptId = crypto.randomUUID();
  const receiptRevision = kind === 'deal' ? String(Number(expected) + 1) : expected;
  const statements = [
    db.prepare(`INSERT INTO deal_price_backfill_receipts (request_id,request_hash,outcome,operation_id,observation_id,revision)
      SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(request_id) DO NOTHING`).bind(key, requestHash, outcome, receiptId, proof.id, receiptRevision, ...guardArgs),
    insertEvidence(db, kind, target, proof, now, { key, id: receiptId }),
  ];
  if (kind === 'deal') {
    const version = Number(expected) + 1;
    if (invalidateRelated) statements.push(db.prepare(`UPDATE deals SET price_verification = 'unverified'
      WHERE id <> ? AND status = 'published' AND list_price_source_url = ? AND price_checked_at <= ?
      AND (? IS NULL OR list_price_krw IS NOT ?)
      AND EXISTS (SELECT 1 FROM deal_price_evidence p WHERE p.id = deals.price_evidence_id
          AND json_extract(p.body,'$.official_approval.variant') IS ?)
      AND EXISTS (SELECT 1 FROM deal_price_backfill_receipts WHERE request_id = ? AND operation_id = ?)`)
      .bind(id, evidence.official!.source.url, evidence.official!.source.observed_at,
        facts?.list_price_krw ?? null, facts?.list_price_krw ?? null, evidence.official_approval?.variant ? JSON.stringify(evidence.official_approval.variant) : null, key, receiptId));
    const priceUpdate = retainPrices ? 'price_evidence_version = ?' :
      application.facts ? `(${priceColumns}) = (?,?,?,?,?,?,?,?,?)` : "price_verification = 'unverified'";
    statements.push(
      db.prepare(`INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at,price_evidence_id)
        SELECT ?,id,?,'verify_prices',?,?,?,?,seller_id,title,price,CASE WHEN ? THEN ? ELSE starts_at END,COALESCE(?,ends_at),image_url,checked,status,?,?
        FROM deals WHERE id = ? AND status = 'published' AND version = ? AND EXISTS (SELECT 1 FROM deal_price_backfill_receipts WHERE request_id = ? AND operation_id = ?)`)
        .bind(receiptId, version, 'prices-' + key, requestHash, outcome, target.model_id ?? null, application.facts ? 1 : 0, normalizedStart, application.facts?.ends_at ?? null, now, retainPrices ? target.price_evidence_id ?? null : proof.id, id, Number(expected), key, receiptId),
      db.prepare(`UPDATE deals SET ${priceUpdate},
        source_ended = CASE WHEN ? THEN 1 ELSE source_ended END,
        starts_at = CASE WHEN ? THEN ? ELSE starts_at END, ends_at = COALESCE(?,ends_at), version = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'published' AND EXISTS (SELECT 1 FROM deal_revisions WHERE id = ?)`)
        .bind(...(retainPrices ? [version] : application.facts ? priceBindings(application, proof.id, version) : []), closed ? 1 : 0,
          application.facts ? 1 : 0, normalizedStart, application.facts?.ends_at ?? null,
          version, now, id, Number(expected), receiptId),
    );
    if (closed && (retainPrices || application.facts)) {
      statements.push(carryClosedRound(db, id, version, 'prices-' + key));
    }
    if (application.facts) {
      statements.push(recordPublishedPrice(db, id, 'prices-' + key, evidencedOpening(evidence, normalizedStart), application.facts.configuration));
    }
    // Observation takedowns, closures, and corrections only demote the live
    // projection above. They never erase a previously valid publication: a
    // normally ended round stays comparable after its proof or approval
    // expires. Only an explicit INVALIDATE_OFFER operation writes
    // invalidated_publication_proofs.
  } else if (!stageOnly) {
    // Only the writer of this receipt may advance the head.
    statements.push(db.prepare(`INSERT INTO deal_price_evidence_heads (target_kind,target_id,target_revision,evidence_id)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM deal_price_backfill_receipts WHERE request_id = ? AND operation_id = ?)
      ON CONFLICT(target_kind,target_id,target_revision) DO UPDATE SET evidence_id = excluded.evidence_id
      WHERE (SELECT observed_at,rowid FROM deal_price_evidence WHERE id = excluded.evidence_id) >=
        (SELECT observed_at,rowid FROM deal_price_evidence WHERE id = deal_price_evidence_heads.evidence_id)`)
      .bind(kind, id, expected, proof.id, key, receiptId));
  }
  await db.batch(statements);
  return await replay() ?? { error: await officialPriceAllowed(db, evidence) ? 'superseded' : 'official_source_not_approved' };
}

export type PriceReview = { id: string; evidence: PriceEvidence; result: PriceResult; reason: string };

async function projectProof(row: { id: string; body: string } | null, reason?: string): Promise<PriceReview | null> {
  if (!row) return null;
  const evidence = await parsePriceEvidence(JSON.parse(row.body));
  if (!evidence) return null;
  const result = assessPriceEvidence(evidence);
  const exclusion = result.facts ? displayExclusion(result.facts.deal_price_krw, result.facts.list_price_krw) : null;
  return { id: row.id, evidence, result, reason: reason ?? exclusion ?? result.outcome };
}

export async function reviewPricesFor(db: D1Database, kind: 'ingest' | 'candidate', rows: { id: string; revision: string }[]) {
  const byId = new Map<string, PriceReview>();
  for (let offset = 0; offset < rows.length; offset += 40) {
    const page = rows.slice(offset, offset + 40);
    const proofs = (await db.prepare(`SELECT p.id, p.body, h.target_id FROM deal_price_evidence_heads h
      JOIN deal_price_evidence p ON p.id = h.evidence_id WHERE h.target_kind = ?
      AND (h.target_id,h.target_revision) IN (VALUES ${page.map(() => '(?,?)').join(',')})`)
      .bind(kind, ...page.flatMap(row => [row.id, row.revision])).all<{ id: string; body: string; target_id: string }>()).results;
    for (const proof of proofs) {
      const view = await projectProof(proof);
      if (view) byId.set(proof.target_id, view);
    }
  }
  return byId;
}

export async function pendingPriceObservation(db: D1Database, kind: 'ingest' | 'candidate', id: string, revision: string, selected?: string) {
  const row = await db.prepare(`SELECT p.id,p.body,r.outcome FROM deal_price_evidence p
    JOIN deal_price_backfill_receipts r ON r.observation_id = p.id
    WHERE p.target_kind = ? AND p.target_id = ? AND p.target_revision = ?
    AND r.outcome IN ('capture_changed','legacy_hash_missing') AND (? IS NULL OR p.id = ?)
    ORDER BY p.observed_at DESC, p.rowid DESC LIMIT 1`)
    .bind(kind, id, revision, selected ?? null, selected ?? null).first<{ id: string; body: string; outcome: string }>();
  return row ? projectProof(row, row.outcome) : null;
}

export async function reviewDealPrices(db: D1Database, ids: string[]) {
  const rows = (await db.prepare(`SELECT p.id,p.body,d.id AS deal_id,d.status,d.price_display_exclusion,d.price_evidence_version,d.version,r.reason
    FROM deals d
    LEFT JOIN deal_revisions r ON d.id = r.deal_id AND d.version = r.version AND r.action = 'verify_prices'
    JOIN deal_price_evidence p ON COALESCE(r.price_evidence_id,d.price_evidence_id) = p.id
    WHERE d.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{
      id: string; body: string; deal_id: string; status: string; price_display_exclusion: string | null; price_evidence_version: number; version: number; reason: string | null;
    }>()).results;
  const proofs = new Map<string, PriceReview>();
  for (const row of rows) {
    const reason = row.status === 'withdrawn' ? 'withdrawn' : row.reason ?? (row.price_evidence_version !== row.version ? 'revision_changed' : row.price_display_exclusion ?? undefined);
    const view = await projectProof(row, reason);
    if (view) proofs.set(row.deal_id, view);
  }
  return proofs;
}

export async function previousDealPrices(db: D1Database, id: string) {
  const rows = (await db.prepare(`SELECT p.id,p.body,MAX(r.version) AS version FROM deal_revisions r
    JOIN deals d ON d.id = r.deal_id JOIN deal_price_evidence p ON p.id = r.price_evidence_id
    LEFT JOIN deal_revisions live ON live.deal_id = d.id AND live.version = d.version AND live.action = 'verify_prices'
    WHERE d.id = ? AND p.id IS NOT COALESCE(live.price_evidence_id,d.price_evidence_id)
    GROUP BY p.id ORDER BY version DESC`)
    .bind(id).all<{ id: string; body: string }>()).results;
  const result = await Promise.all(rows.map(row => projectProof(row)));
  return result.filter((row): row is PriceReview => row !== null);
}
