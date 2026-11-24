import { sellerIdentity } from '../shared/seller-identity';
import { capturedRound } from '../shared/offer-round';
import {
  assessPriceEvidence, digest, displayExclusion, identityToken, instant, metadataStart,
  OFFICIAL_PRICE_MAX_AGE_MS, offerDeadlinePrecision, offerSourceClosed, parsePriceEvidence, type PriceResult,
} from '../shared/deal-price-evidence';
import {
  catalogIdentity, CLOSE_OFFER, digestId, INVALIDATE_OFFER, metadataFields, OFFER_CATEGORIES, OFFER_FRESHNESS_MS,
  OFFER_KIND, offerCandidateId, offerDigestFields, offerHash, offerImage, offerKeyFields, offerRegionDigest, offerText, offerUrl, PROMOTE_OFFER,
  sellerHandle, type FailedOffer, type OfferAck, type OfferClaim, type OfferPayload, type OfferReceipt, type VerifiedOffer,
} from '../shared/verified-offer';
import { priceBindings } from './deal-price-review';
import { officialPriceGuard } from './official-price-sources';

const reply = (data: unknown, status = 200) => Response.json({ data }, { status, headers: { 'Cache-Control': 'no-store' } });
const reject = (error: string, status = 400) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const version = (value: unknown) => value === 0 || sequence(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safe = (url: unknown): url is string => typeof url === 'string' && offerUrl(url) === url;
const availability = ['open','ongoing','scheduled','unknown','closed'];
const baseKeys = ['kind','offer_id','offer_key','campaign_key','revision','expected_version','digest','checked_at','locator','catalog_revision','content_digest'];
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max &&
  v.split('\n').every(line => !line || offerText(line, max));
const valuesOf = (r: Record<string, unknown>, keys: string[]) => keys.every(k => offerText(r[k], 200));

export async function verifyBody(value: Record<string, unknown>, now: number) {
  if (value.kind !== OFFER_KIND || !digestId(value.offer_id) || !digestId(value.offer_key) || !digestId(value.campaign_key)
    || !sequence(value.revision) || !version(value.expected_version) || !digestId(value.digest) || !instant(value.checked_at)
    || Date.parse(value.checked_at) > now || !offerText(value.locator, 160) || !digestId(value.catalog_revision) || !digestId(value.content_digest)) return null;
  const { digest: asserted, ...body } = value;
  if (await offerHash(offerDigestFields(body as Omit<OfferPayload, 'digest'>)) !== asserted) return null;
  if ('failure' in value) {
    const f = value.failure;
    if (!exact(value, [...baseKeys, 'failure', 'previous_digest']) || !record(f) ||
        !exact(f, ['title','source_url','gates','retry_at','evidence']) || !offerText(f.title, 200) || !safe(f.source_url)
        || !Array.isArray(f.gates) || f.gates.length < 1 || f.gates.length > 30 ||
        new Set(f.gates).size !== f.gates.length || !f.gates.every(g => typeof g === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(g))
        || !(f.retry_at === null || instant(f.retry_at)) || !plain(f.evidence, 6500)
        || !(value.previous_digest === null || digestId(value.previous_digest)) ||
        value.expected_version !== 0 && value.previous_digest === null) return null;
    return { offer: value as unknown as FailedOffer, result: null };
  }
  const f = value.facts, live = value.liveness, closure = value.closure;
  if (!exact(value, [...baseKeys, 'facts','price_evidence','metadata','liveness', ...(closure === undefined ? [] : ['closure'])])
    || !record(f) || !exact(f, ['model_id','brand','model','category','seller_handle','seller_url','source_url','title','starts_at',
      'ends_at','deadline_precision','availability','image_url','deal_price_krw','list_price_krw','price_source_url','list_price_source_url',
      'price_checked_at','configuration','orders_open'])
    || !valuesOf(f, ['model_id','brand','model','title','seller_handle']) || !OFFER_CATEGORIES.some(c => c === f.category)
    || !safe(f.source_url) || !safe(f.seller_url) || f.seller_handle !== sellerHandle(f.seller_url)
    || !(f.image_url === null || typeof f.image_url === 'string' && offerImage(f.image_url) === f.image_url)
    || !(f.starts_at === null || instant(f.starts_at)) || !instant(f.ends_at) || f.starts_at !== null && f.starts_at >= f.ends_at
    || !availability.some(v => v === f.availability)
    || !record(live) || !exact(live, ['url','checked_at','seller_url','locator','product_digest','availability_badge'])
    || live.url !== f.source_url || live.checked_at !== value.checked_at || live.locator !== value.locator
    || live.seller_url !== f.seller_url || live.product_digest !== value.content_digest) return null;
  const badge = live.availability_badge;
  if (!(badge === null || record(badge) && exact(badge, ['value','locator']) && availability.some(v => v === badge.value)
    && offerText(badge.locator, 200))) return null;
  const evidence = await parsePriceEvidence(value.price_evidence, true);
  const variant = evidence?.official_approval?.variant;
  if (!evidence || !evidence.offer || !evidence.official || !variant
    || variant.site_model_id !== f.model_id
    || evidence.offer.source.observed_at > value.checked_at || evidence.official.source.observed_at > value.checked_at
    || f.source_url !== evidence.offer_url) return null;
  const result = assessPriceEvidence(evidence);
  if (!result.facts || displayExclusion(result.facts.deal_price_krw, result.facts.list_price_krw)
    || f.deadline_precision !== offerDeadlinePrecision(evidence.offer.readings[0])
    || Object.entries(result.facts).some(([key, val]) => JSON.stringify(f[key]) !== JSON.stringify(val) &&
      (key !== 'configuration' || !record(f.configuration) || Object.keys(f.configuration).length !== Object.keys(result.facts.configuration).length ||
        Object.entries(result.facts.configuration).some(([field, item]) => (f.configuration as Record<string, unknown>)[field] !== item)))
    || identityToken(result.facts.configuration.brand) !== identityToken(f.brand as string)
    || identityToken(result.facts.configuration.model) !== identityToken(f.model as string)) return null;
  const text = evidence.offer.source.text;
  if (!Array.isArray(value.metadata) || value.metadata.length !== 2 || !value.metadata.every(reading => {
    if (!record(reading) || !exact(reading, [...metadataFields])) return false;
    for (const key of metadataFields) {
      const field = reading[key];
      if (field === null) continue;
      if (!record(field) || !exact(field, ['value','quote']) || !offerText(field.value, 2048) || !offerText(field.quote, 500)
        || !(text.includes(field.quote) || key === 'offer' && field.quote === f.source_url
          || key === 'seller' && field.quote === f.seller_url || key === 'availability' && record(badge) && field.quote === badge.locator)) return false;
    }
    const brand = reading.brand, model = reading.model, seller = reading.seller, offer = reading.offer, start = reading.start;
    const allowed = (part: unknown, aliases: string[]) => record(part) && typeof part.value === 'string' && typeof part.quote === 'string'
      && aliases.some(alias => identityToken(alias) === identityToken(part.value as string)
        && identityToken(part.quote as string).includes(identityToken(alias)));
    const startTime = record(start) && typeof start.quote === 'string' ? metadataStart(start.quote) : null;
    return allowed(brand, [result.facts.configuration.brand, ...variant.brand_aliases]) &&
      allowed(model, [result.facts.configuration.model, ...variant.model_aliases]) &&
      record(seller) && seller.value === f.seller_url && record(offer) && offer.value === f.source_url &&
      (start === null ? f.starts_at === null : !!startTime && startTime === f.starts_at);
  })) return null;
  // A closure uses the previous price capture and a separate exact-permalink capture.
  if (closure !== undefined) {
    if (!record(closure) || !exact(closure, ['text','hash']) || !plain(closure.text, 6500) || !closure.text ||
        closure.hash !== await digest(closure.text) || !offerSourceClosed(closure.text) || f.availability !== 'closed'
        || !record(badge) || badge.value !== 'closed') return null;
  } else {
    const derived = f.starts_at && f.starts_at > value.checked_at ? 'scheduled' : result.facts.orders_open ? 'open' : 'unknown';
    if (f.availability !== derived || offerSourceClosed(text)) return null;
    // Both price readers independently bind the definitive deadline.
    if (evidence.offer.source.observed_at < new Date(now - OFFER_FRESHNESS_MS).toISOString()) return null;
  }
  const { checked_at: at, product_digest: bound, ...region } = live as unknown as VerifiedOffer['liveness'];
  void at;
  if (bound !== await offerRegionDigest(closure ? (closure as { text: string }).text : text, region, f.image_url as string | null)) return null;
  if (!closure) {
    const keys = offerKeyFields(f.seller_url, f.model_id as string, result.facts.configuration, f.source_url, value.locator as string, f.starts_at);
    if (value.offer_key !== await offerHash(keys.offer) || value.campaign_key !== await offerHash(keys.campaign)) return null;
  }
  return { offer: value as unknown as VerifiedOffer, result };
}

function buildClaim(offer: OfferPayload, action: OfferClaim['action'], request_id: string): OfferClaim {
  return { action, request_id, offer_key: offer.offer_key, revision: offer.revision, digest: offer.digest, expected_version: offer.expected_version };
}
const claimHash = (id: string, claim: OfferClaim) => offerHash([id, claim]);
export async function ingestVerifiedOffer(db: D1Database, value: Record<string, unknown>, now = Date.now()) {
  const parsed = await verifyBody(value, now);
  if (!parsed) return reject('invalid_verified_offer');
  const { offer } = parsed;
  const failed = 'failure' in offer ? offer : null;
  const facts = 'facts' in offer ? offer.facts : null;
  const { revision, digest: hash, checked_at, offer_key, campaign_key } = offer;
  const candidate = offerCandidateId(offer.offer_id);
  const source = failed?.failure.source_url ?? facts!.source_url;
  const head = () => db.prepare(`SELECT c.id,c.revision,c.digest,c.state,e.offer_key FROM verified_offer_candidates c
    JOIN verified_offer_evidence e ON e.candidate_id=c.id AND e.revision=c.revision AND e.digest=c.digest
    WHERE c.id=? AND c.revision=? AND c.digest=? AND e.offer_key=? AND c.state <> 'dismissed'`)
    .bind(candidate, revision, hash, offer_key).first<Omit<OfferAck, 'kind'>>();
  const ack = (row: Omit<OfferAck, 'kind'>) => reply({ kind: OFFER_KIND, ...row } satisfies OfferAck, 202);
  const existing = await head();
  if (existing) return ack(existing);
  if (facts) {
    const { results } = await db.prepare('SELECT id,brand,name,category FROM models').all<{ id: string; brand: string; name: string; category: string }>();
    if (await offerHash(catalogIdentity(results)) !== offer.catalog_revision ||
      !results.some(m => m.id === facts.model_id && m.brand === facts.brand && m.name === facts.model && m.category === facts.category)) return reject('catalog_changed', 409);
  }
  const next = failed ? 'review' : 'eligible';
  const commands = [
    db.prepare(`INSERT INTO verified_offer_candidates(id,revision,digest,state,checked_at)
      SELECT ?,?,?,?,? WHERE (?=0 OR EXISTS (SELECT 1 FROM verified_offer_candidates WHERE id=?))
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,state=excluded.state,checked_at=excluded.checked_at
      WHERE excluded.revision > verified_offer_candidates.revision AND verified_offer_candidates.state <> 'dismissed'
        AND (? = 0 AND verified_offer_candidates.deal_id IS NULL OR EXISTS (
          SELECT 1 FROM deals WHERE id=verified_offer_candidates.deal_id AND status='published' AND version=?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM verified_offer_evidence old
            WHERE old.candidate_id=verified_offer_candidates.id AND old.digest=? AND old.source_url=? AND old.locator=?)
          AND (verified_offer_candidates.digest=? OR EXISTS (
          SELECT 1 FROM verified_offer_operations o JOIN verified_offer_receipts r USING(request_id)
          WHERE o.candidate_id=verified_offer_candidates.id AND o.digest=? AND r.committed_revision=?)))`)
      .bind(candidate, revision, hash, next, checked_at, offer.expected_version, candidate,
        offer.expected_version, offer.expected_version, failed?.previous_digest ?? null, failed?.previous_digest ?? null,
        source, offer.locator, failed?.previous_digest ?? null, failed?.previous_digest ?? null, offer.expected_version),
    db.prepare(`INSERT INTO verified_offer_evidence(candidate_id,revision,digest,offer_key,campaign_key,source_url,locator,payload)
      SELECT id,revision,digest,?,?,?,?,? FROM verified_offer_candidates WHERE id=? AND revision=? AND digest=? AND state=?
      ON CONFLICT(candidate_id,revision) DO NOTHING`).bind(offer_key, campaign_key, source, offer.locator, JSON.stringify(offer), candidate, revision, hash, next),
    db.prepare(`INSERT INTO verified_offer_provenance(candidate_id,source_url,locator,observed_at)
      SELECT candidate_id,source_url,locator,? FROM verified_offer_evidence WHERE candidate_id=? AND revision=? AND digest=?
      ON CONFLICT(candidate_id,source_url,locator) DO UPDATE SET observed_at=max(observed_at,excluded.observed_at)`)
      .bind(checked_at, candidate, revision, hash),
  ];
  if (failed) {
    const request = await offerHash([INVALIDATE_OFFER, offer.offer_id, revision, hash]);
    const claim = buildClaim(offer, INVALIDATE_OFFER, request);
    // Accepting a failing observation and removing its predecessor's public proof share a transaction.
    commands.push(db.prepare(`INSERT INTO verified_offer_operations(request_id,request_hash,action,candidate_id,offer_key,revision,digest,deal_id,expected_version,committed_at)
      SELECT ?,?,?,c.id,e.offer_key,c.revision,c.digest,c.deal_id,?,? FROM verified_offer_candidates c
      JOIN verified_offer_evidence e ON e.candidate_id=c.id AND e.revision=c.revision
      WHERE c.id=? AND c.revision=? AND c.digest=? AND c.state='review'
      ON CONFLICT(request_id) DO NOTHING`)
      .bind(request, await claimHash(candidate, claim), INVALIDATE_OFFER, offer.expected_version, new Date(now).toISOString(), candidate, revision, hash));
  }
  await db.batch(commands);
  const row = await head();
  return row ? ack(row) : reject('offer_head_conflict', 409);
}

function parseClaim(value: Record<string, unknown>): OfferClaim | null {
  if (!exact(value, ['action','request_id','offer_key','revision','digest','expected_version'])
    || ![PROMOTE_OFFER, INVALIDATE_OFFER, CLOSE_OFFER].some(action => action === value.action)
    || !digestId(value.request_id) || !digestId(value.digest) || !digestId(value.offer_key)
    || !sequence(value.revision) || !version(value.expected_version)) return null;
  return value as unknown as OfferClaim;
}
async function receipt(db: D1Database, id: string, requestId: string, hash: string) {
  const row = await db.prepare(`SELECT o.action,o.request_id,o.request_hash,o.candidate_id,o.offer_key,o.revision,o.digest,o.committed_at,
    r.deal_id,r.committed_revision,o.expected_version FROM verified_offer_operations o
    JOIN verified_offer_receipts r USING(request_id) WHERE o.request_id=?`)
    .bind(requestId).first<Omit<OfferReceipt, 'kind' | 'promotion_id' | 'created'> & { request_hash: string }>();
  if (!row) return null;
  if (row.request_hash !== hash || row.candidate_id !== id) return reject('request_id_reused', 409);
  const { request_hash, ...data } = row;
  void request_hash;
  return reply({ ...data, kind: OFFER_KIND, promotion_id: requestId,
    created: data.action === PROMOTE_OFFER && data.expected_version === 0 } satisfies OfferReceipt);
}

export async function mutateVerifiedOffer(db: D1Database, id: string, value: Record<string, unknown>, lookup = false, now = Date.now()) {
  const input = parseClaim(value);
  if (!input || !/^verified-[a-f0-9]{64}$/.test(id)) return reject('invalid_offer_claim');
  const { action, digest: hash, offer_key, request_id, revision, expected_version } = input;
  const requestHash = await claimHash(id, input);
  const existing = await receipt(db, id, request_id, requestHash);
  if (existing || lookup) return existing ?? reject('receipt_not_found', 404);
  if (action === INVALIDATE_OFFER) return reject('offer_claim_conflict', 409);
  const current = await db.prepare(`SELECT e.payload FROM verified_offer_candidates c
    JOIN verified_offer_evidence e ON e.candidate_id=c.id AND e.revision=c.revision
    WHERE c.id=? AND c.state='eligible' AND c.revision=? AND c.digest=? AND e.offer_key=?`)
    .bind(id, revision, hash, offer_key).first<{ payload: string }>();
  if (!current) return await receipt(db, id, request_id, requestHash) ?? reject('offer_claim_conflict', 409);
  const parsed = await verifyBody(JSON.parse(current.payload), now);
  if (!parsed || !('facts' in parsed.offer) || !parsed.result) return reject('offer_evidence_expired', 409);
  const { offer, result } = parsed;
  const f = offer.facts;
  const closed = action === CLOSE_OFFER;
  const time = new Date(now).toISOString();
  const cutoff = new Date(now - OFFER_FRESHNESS_MS).toISOString();
  const priceCutoff = new Date(now - OFFICIAL_PRICE_MAX_AGE_MS).toISOString();
  if (expected_version !== offer.expected_version || closed !== !!offer.closure || offer.checked_at < cutoff || f.price_checked_at <= priceCutoff
    || !closed && f.ends_at < time) return reject('offer_evidence_expired', 409);
  const authority = officialPriceGuard(offer.price_evidence, now);
  const sellerId = 'offer-seller-' + await offerHash(f.seller_url);
  const authoritySnapshot = await db.prepare(`SELECT scope.value AS value FROM official_price_approvals a,json_each(a.scopes) scope
    WHERE json_extract(scope.value,'$.id')=? AND json_extract(scope.value,'$.revision')=?
      AND json_extract(scope.value,'$.url')=? AND json_extract(scope.value,'$.variant') IS ?`)
    .bind(offer.price_evidence.official_approval!.id,offer.price_evidence.official_approval!.revision,f.list_price_source_url,
      offer.price_evidence.official_approval!.variant ? JSON.stringify(offer.price_evidence.official_approval!.variant) : null).first<{value:string}>();
  const priceValues = makePriceValues(result, request_id, expected_version + 1, sellerId, f,
    capturedRound(offer.price_evidence.offer!.source.text,f.source_url,offer.locator),
    authoritySnapshot ? JSON.parse(authoritySnapshot.value) : null);
  try {
    await db.prepare(`INSERT INTO verified_offer_operations(request_id,action,request_hash,candidate_id,offer_key,revision,digest,deal_id,expected_version,committed_at,price_values)
      SELECT ?,?,?,c.id,e.offer_key,c.revision,c.digest,COALESCE(c.deal_id,'deal-'||c.id),?,?,?
      FROM verified_offer_candidates c
      JOIN verified_offer_evidence e ON e.candidate_id=c.id AND e.revision=c.revision AND e.digest=c.digest
      LEFT JOIN deals d ON d.id=c.deal_id
      JOIN models m ON m.id=? AND m.brand=? AND m.name=? AND m.category=?
      WHERE c.id=? AND c.state='eligible' AND c.revision=? AND c.digest=? AND e.offer_key=? AND c.checked_at BETWEEN ? AND ?
        AND (d.id IS NULL AND ?=0 OR d.status='published' AND d.version=? AND d.verified_offer_id=c.id AND d.seller_id=? AND d.model_id=m.id)
        AND (d.id IS NULL OR EXISTS (SELECT 1 FROM verified_offer_aliases a WHERE a.candidate_id=c.id AND a.offer_key IN (e.offer_key,e.campaign_key))
          OR EXISTS (
            SELECT 1 FROM verified_offer_operations prior JOIN verified_offer_receipts pr USING(request_id)
            JOIN verified_offer_evidence pe ON pe.candidate_id=prior.candidate_id AND pe.revision=prior.revision
            WHERE prior.candidate_id=c.id AND prior.action='promote_verified_offer_v2'
            AND pe.source_url=e.source_url AND pe.locator=e.locator AND json_extract(pe.payload,'$.facts.starts_at') IS NULL
            AND json_extract(pe.payload,'$.price_evidence.official_approval.variant.id')=json_extract(e.payload,'$.price_evidence.official_approval.variant.id')
            AND pr.committed_revision<=d.version))
        AND (?=0 OR d.source_ended=0 AND d.price_verification='verified' AND d.price_evidence_version=d.version
          AND EXISTS (SELECT 1 FROM deal_price_evidence p WHERE p.id=d.price_evidence_id AND json(p.body)=json(json_extract(e.payload,'$.price_evidence'))))
        AND NOT EXISTS (SELECT 1 FROM verified_offer_aliases a WHERE a.offer_key IN (e.offer_key,e.campaign_key) AND a.candidate_id<>c.id)
        AND ${authority.sql}`)
      .bind(request_id, action, requestHash, expected_version, time, priceValues, f.model_id,f.brand,f.model,f.category,
        id, revision, hash, offer_key, cutoff, time, expected_version, expected_version, sellerId, closed ? 1 : 0, ...authority.values).run();
  } catch (error) {
    const reconciled = await receipt(db, id, request_id, requestHash);
    if (reconciled) return reconciled;
    if (!/UNIQUE constraint failed|offer_(?:key|source)_conflict/.test(String(error))) throw error;
    return reject('offer_source_or_identity_conflict', 409);
  }
  return await receipt(db, id, request_id, requestHash) ?? reject('offer_claim_conflict', 409);
}

function makePriceValues(result: PriceResult, id: string, version: number, sellerId: string, f: VerifiedOffer['facts'], round: ReturnType<typeof capturedRound>, authority: unknown) {
  return JSON.stringify({ prices: priceBindings(result, id, version), seller_id: sellerId, seller_url: f.seller_url,
    seller_handle: f.seller_handle, identity: sellerIdentity(f.seller_url), round, authority, host: new URL(f.source_url).hostname });
}

export async function dismissVerifiedOffer(db: D1Database, id: string, value: Record<string, unknown>) {
  if (!sequence(value.revision) || !digestId(value.digest)) return reject('invalid_offer_dismissal');
  const result = await db.prepare(`UPDATE verified_offer_candidates SET state='dismissed'
    WHERE id=? AND revision=? AND digest=? AND state IN ('eligible','review')`)
    .bind(id, value.revision, value.digest).run();
  return result.meta.changes === 1 ? reply({ id, state: 'dismissed' }) : reject('offer_head_conflict', 409);
}

type ReviewRow = { id: string; title: string; source_url: string; gates: string; retry_at: string | null; checked_at: string };
export async function verifiedOfferReviewPage(db: D1Database, limit = 20, cursor?: string | null) {
  const after = cursor?.split('~') ?? [];
  if (cursor && (after.length !== 2 || !instant(after[0]) || !/^verified-[a-f0-9]{64}$/.test(after[1]))) return null;
  const options = Math.min(100, Math.max(1, limit));
  const { results } = await db.prepare(`SELECT c.id,c.checked_at,e.source_url,json_extract(e.payload,'$.failure.title') title,
    json_extract(e.payload,'$.failure.gates') gates,json_extract(e.payload,'$.failure.retry_at') retry_at
    FROM verified_offer_candidates c JOIN verified_offer_evidence e ON e.candidate_id=c.id AND e.revision=c.revision
    WHERE c.state='review' AND (c.checked_at,c.id)>(?,?) ORDER BY c.checked_at,c.id LIMIT ?`)
    .bind(after[0] ?? '', after[1] ?? '', options+1).all<ReviewRow>();
  const data = results.slice(0, options).map(row => ({ ...row, gates: JSON.parse(row.gates) as string[] }));
  const tail = data.at(-1);
  return { data, next_cursor: results.length > options && tail ? tail.checked_at + '~' + tail.id : null };
}
