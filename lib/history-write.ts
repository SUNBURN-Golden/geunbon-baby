import { assessPriceEvidence, displayExclusion, instant, offerDeadlinePrecision, parsePriceEvidence } from '../shared/deal-price-evidence';
import { capturedRound } from '../shared/offer-round';
import { bundleComponents, configurationMatches } from './deal-price-review';
import { commit, decision, digest, guard, key, object, observation, reject, replay, safeSource, statement, string } from './history-review';

function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return reject('invalid_version');
  return value;
}

export async function mergeCampaigns(db: D1Database, raw: unknown) {
  const b = object(raw);
  const review = decision(b);
  const id = key(b.survivor_id), retired = key(b.retired_id);
  if (id === retired) return reject('invalid_merge');
  const expected = version(b.survivor_version), retiredVersion = version(b.retired_version);
  const proofIds = b.observations===undefined ? null : Array.isArray(b.observations) && b.observations.length===2 ?
    b.observations.map(key) : reject('invalid_merge_evidence');
  const hash = await digest([review,id,retired,expected,retiredVersion,proofIds]);
  const receipt = `merge:${review.request_id}`;
  const previous = await replay<{ campaign_id: string; alias_id: string }>(db,receipt,hash);
  if (previous) return previous;
  const pairedProof = proofIds ? await Promise.all(proofIds.map(async (proof,i) => {
    const row = await statement(db,`SELECT o.locator,o.source_url,p.body FROM campaign_observations o
      JOIN deal_price_evidence p ON p.id=o.proof_id AND p.outcome='verified'
      WHERE o.id=? AND o.campaign_id=? AND o.retracted_by IS NULL`,proof,i===0?id:retired)
      .first<{locator:string;source_url:string;body:string}>();
    if (!row) return null;
    const parsed = await parsePriceEvidence(JSON.parse(row.body),true);
    const round = parsed?.offer && capturedRound(parsed.offer.source.text,row.source_url,row.locator);
    return round?.key ?? null;
  })) : null;
  if (pairedProof && (!pairedProof[0] || pairedProof[0]!==pairedProof[1])) return reject('invalid_merge_evidence',409);
  const now = new Date().toISOString();
  const writes = [
    guard(db, `EXISTS (SELECT 1 FROM seller_campaigns a JOIN seller_campaigns b ON a.seller_id=b.seller_id
      WHERE a.id=? AND a.version=? AND b.id=? AND b.version=? AND a.merged_into IS NULL AND b.merged_into IS NULL)`, id,expected,retired,retiredVersion),
    ...(proofIds ? proofIds.map((proof,i) => guard(db,`EXISTS (SELECT 1 FROM campaign_observations
      WHERE id=? AND campaign_id=? AND retracted_by IS NULL)`,proof,i===0?id:retired)) : [
      guard(db,`EXISTS (SELECT 1 FROM campaign_source_aliases a JOIN campaign_source_aliases b
        ON a.seller_id=b.seller_id WHERE a.campaign_id=? AND b.campaign_id=? AND a.source_url=b.source_url
        AND a.evidence_ref=b.evidence_ref)`,id,retired),
    ]),
    statement(db, 'UPDATE campaign_deals SET campaign_id=? WHERE campaign_id=?',id,retired),
    statement(db, 'UPDATE campaign_observations SET campaign_id=? WHERE campaign_id=?',id,retired),
    statement(db, 'UPDATE offer_price_observations SET campaign_id=? WHERE campaign_id=?',id,retired),
    statement(db, 'UPDATE campaign_offers SET campaign_id=? WHERE campaign_id=?',id,retired),
    statement(db, 'UPDATE campaign_source_aliases SET campaign_id=? WHERE campaign_id=?',id,retired),
    statement(db, 'UPDATE seller_campaigns SET merged_into=? WHERE merged_into=?',id,retired),
    statement(db, 'UPDATE seller_campaigns SET merged_into=?,version=version+1 WHERE id=?',id,retired),
    statement(db, 'UPDATE seller_campaigns SET version=version+1 WHERE id=?',id),
    statement(db, `UPDATE official_approvals SET state='superseded',decided_at=?,actor=?,reason=?
      WHERE state='approved' AND digest IN (SELECT digest FROM official_attestations WHERE campaign_id=?)`,now,review.actor,review.reason,retired),
    statement(db, `INSERT INTO history_operations(id,action,namespace,record_key,revision_key,item_key,committed_at,payload)
      VALUES (?,'merge','history',?,?, 'round',?,json_object('retired',?,'digest',?,'observations',json(?)))`,
      receipt,id,String(expected),now,retired,hash,JSON.stringify(proofIds)),
  ];
  return (await commit(db,writes,receipt,hash,{ campaign_id:id,alias_id:retired },review.actor,review.reason,now)).result;
}

export async function retractHistory(db: D1Database, raw: unknown) {
  const b = object(raw);
  const review = decision(b);
  const observationId = key(b.observation_id);
  const campaign = key(b.campaign_id);
  const expected = version(b.expected_version);
  const hash = await digest([review,observationId,campaign,expected]);
  const receipt = `retract:${review.request_id}`;
  const prior = await replay<{ observation_id: string }>(db,receipt,hash);
  if (prior) return prior;
  const now = new Date().toISOString();
  const writes = [
    guard(db, `EXISTS (SELECT 1 FROM campaign_observations o JOIN seller_campaigns c ON c.id=o.campaign_id
      WHERE o.id=? AND c.id=? AND c.version=? AND c.merged_into IS NULL AND o.retracted_by IS NULL)`,observationId,campaign,expected),
    statement(db, `INSERT INTO history_operations(id,action,namespace,record_key,revision_key,item_key,proof_id,committed_at,payload)
      SELECT ?,'retract','history',?,?,'observation',proof_id,?,json_object('observation_id',id)
      FROM campaign_observations WHERE id=?`,receipt,campaign,String(expected),now,observationId),
    statement(db, 'UPDATE seller_campaigns SET version=version+1 WHERE id=?',campaign),
  ];
  return (await commit(db,writes,receipt,hash,{ observation_id:observationId },review.actor,review.reason,now)).result;
}

// Historical imports never write live deals or create price evidence from suggested facts.
export async function importHistory(db: D1Database, raw: unknown) {
  const b = object(raw);
  const review = decision(b);
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 12) return reject('invalid_observations');
  const hash = await digest([review,b.items]);
  const receipt = `import:${review.request_id}`;
  const previous = await replay<{ observations: string[]; campaigns: string[] }>(db,receipt,hash);
  if (previous) return previous;
  const now = new Date().toISOString();
  const writes: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const input of b.items) {
    const item = object(input);
    const source = observation(item.observation);
    if (!['site-ingest','site-external','site-deal','review-queue','collector'].includes(source.namespace) || !source.observed_at) return reject('invalid_observation');
    const seller = key(item.seller_id), model = key(item.model_id);
    const deal = item.deal_id == null ? null : key(item.deal_id);
    const expected = deal ? version(item.expected_version) : null;
    const title = string(item.title);
    const locator = string(item.locator,250);
    const sellerUrl = safeSource(item.seller_url);
    const proof = await parsePriceEvidence(item.price_evidence);
    const facts = proof && assessPriceEvidence(proof).facts;
    if (!proof?.offer || !proof.official || !proof.official_approval || !facts ||
        displayExclusion(facts.deal_price_krw,facts.list_price_krw) || proof.offer_url !== source.source_url ||
        !await configurationMatches(db,facts,model,bundleComponents(facts))) return reject('invalid_history_price_proof');
    const offer = proof.offer.source, official = proof.official.source;
    const observedAt = source.precision === 'day'
      ? new Date(Date.parse(offer.observed_at) + 9 * 3600000).toISOString().slice(0,10) : offer.observed_at;
    const decisionAt = [offer.observed_at,official.observed_at].sort().at(-1)!;
    if (observedAt !== source.observed_at || decisionAt > now || facts.ends_at < offer.observed_at ||
        Math.abs(Date.parse(offer.observed_at) - Date.parse(official.observed_at)) >= 86_400_000) return reject('invalid_observation_date');
    const round = capturedRound(offer.text, source.source_url, locator);
    const component = item.scope === 'component';
    if (component && (bundleComponents(facts).length || deal ||
        !/^(?:구성품\s*)?(?:별도\s*구매|단독\s*구매)\s*[:：]\s*(?:가능|판매)$/mu.test(offer.text))) {
      return reject('component_separate_purchase_required');
    }
    if (!deal && !round) return reject('round_discriminator_required');
    const proofId = item.proof_id == null ? null : key(item.proof_id);
    if (deal ? !proofId : proofId!==null) return reject('invalid_publication_proof');
    const id = 'history:' + await digest([source.namespace,source.record_key,source.revision_key,source.item_key]);
    const recordedProof = proofId ?? id;
    ids.push(id);
    if (deal) writes.push(guard(db,`EXISTS (SELECT 1 FROM deals d JOIN canonical_sellers c ON c.id=d.seller_id
      JOIN deal_price_evidence p ON p.id=d.price_evidence_id
      WHERE d.id=? AND d.version=? AND d.status='published' AND c.canonical_id=? AND d.model_id=?
        AND d.price_evidence_id=? AND json(p.body)=json(?))`,deal,expected,seller,model,recordedProof,JSON.stringify(proof)));
    if (source.namespace === 'site-ingest' || source.namespace === 'site-external') {
      const table = source.namespace === 'site-ingest' ? 'ingested_items' : 'external_candidates';
      const revision = source.namespace === 'site-ingest' ? 'captured_at' : 'price_revision';
      writes.push(guard(db,`EXISTS (SELECT 1 FROM ${table} WHERE id=? AND ${revision}=? AND source_url=? AND status NOT IN ('rejected','dismissed'))`,
        source.record_key,source.revision_key,source.source_url));
    }
    if (source.namespace === 'site-deal' && (source.record_key !== deal || source.revision_key !== String(expected))) return reject('invalid_preconditions');
    writes.push(guard(db,`EXISTS (SELECT 1 FROM seller_identity_aliases a JOIN canonical_sellers c ON c.id=a.seller_id
      WHERE c.canonical_id=? AND (a.source_url=? OR a.platform='storefront' AND a.identity=rtrim(?,'/')))
      AND (? IS NOT NULL OR instr(?,?)>0)`,seller,sellerUrl,sellerUrl,deal,offer.text,sellerUrl));
    if (!proofId) writes.push(statement(db,`INSERT INTO deal_price_evidence
      (id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
      VALUES (?,'deal',?,?,'verified',?,?,?)`,recordedProof,id,source.revision_key,JSON.stringify(proof),now,offer.observed_at));
    const payload = { title, source_url:source.source_url, locator, seller_url:sellerUrl, evidence_ref:offer.hash, round,
      scope:component ? 'component' : undefined, deadline:facts.ends_at, precision:offerDeadlinePrecision(proof.offer.readings[0]),
      ...(source.precision === 'day' ? { observed_day:source.observed_at } : {}) };
    if (!instant(decisionAt)) return reject('invalid_observation_date');
    writes.push(statement(db,`INSERT INTO history_operations
      (id,action,namespace,record_key,revision_key,item_key,deal_id,deal_version,seller_id,model_id,proof_id,committed_at,payload)
      VALUES (?,'import',?,?,?,?,?,?,?,?,?,?,?)`,id,source.namespace,source.record_key,source.revision_key,source.item_key,
      deal,expected,seller,model,recordedProof,decisionAt,JSON.stringify(payload)));
    writes.push(guard(db,'EXISTS (SELECT 1 FROM campaign_observations WHERE id=?)',id));
  }
  type Result = { observations: string[]; campaigns: string[] };
  // The receipt derives campaign identities from the completed batch, so replay returns the original mapping.
  writes.push(statement(db,`INSERT INTO history_receipts
    SELECT ?,?,json_object('observations',json(?),'campaigns',json_group_array(DISTINCT campaign_id)),?,?,?
    FROM campaign_observations WHERE id IN (SELECT value FROM json_each(?))`,
    receipt,hash,JSON.stringify(ids),review.actor,review.reason,now,JSON.stringify(ids)));
  try { await db.batch(writes); }
  catch (error) {
    const prior = await replay<Result>(db,receipt,hash);
    if (prior) return prior;
    if (/history_precondition|UNIQUE constraint failed/.test(String(error))) return reject('stale_review',409);
    throw error;
  }
  return (await replay<Result>(db,receipt,hash))!;
}

export async function reassignSellerHistory(db: D1Database, raw: unknown) {
  const b = object(raw);
  const review = decision(b);
  const seller = key(b.seller_id), target = key(b.canonical_id);
  const proof = key(b.history_operation);
  const expected = version(b.generation);
  const hash = await digest([review,seller,target,proof,expected]);
  const receipt = `reassign:${review.request_id}`;
  const prior = await replay<{ seller_id:string; canonical_id:string }>(db,receipt,hash);
  if (prior) return prior;
  const now = new Date().toISOString();
  if (seller===target || !seller.startsWith('offer-seller-')) return reject('invalid_seller_reassignment');
  const writes = [
    guard(db,'EXISTS (SELECT 1 FROM history_generation WHERE id=1 AND generation=?)',expected),
    guard(db,`EXISTS (SELECT 1 FROM history_operations h JOIN seller_identity_aliases a
      ON a.platform=json_extract(h.payload,'$.identity.platform') AND a.identity=json_extract(h.payload,'$.identity.identity')
      JOIN canonical_sellers target ON target.id=a.seller_id AND target.canonical_id=target.id
      JOIN canonical_sellers original ON original.id=h.seller_id AND original.canonical_id=original.id
      JOIN campaign_observations proof ON proof.id=h.id AND proof.retracted_by IS NULL
      WHERE h.id=? AND h.namespace='verified_offer_v2' AND h.seller_id=? AND target.id=?)`,proof,seller,target),
    guard(db,`NOT EXISTS (SELECT 1 FROM campaign_source_aliases a JOIN campaign_source_aliases b ON a.discriminator=b.discriminator
      WHERE a.seller_id=? AND b.seller_id=? AND a.campaign_id<>b.campaign_id)`,seller,target),
    statement(db,'INSERT INTO seller_identity_redirects(seller_id,canonical_id) VALUES (?,?)',seller,target),
    statement(db,'UPDATE seller_identity_redirects SET canonical_id=? WHERE canonical_id=?',target,seller),
    statement(db,'UPDATE seller_campaigns SET seller_id=?,version=version+1 WHERE seller_id=?',target,seller),
    statement(db,'UPDATE campaign_source_aliases SET seller_id=? WHERE seller_id=?',target,seller),
    statement(db,`UPDATE official_approvals SET state='superseded',decided_at=?,actor=?,reason=?
      WHERE state='approved' AND digest IN (SELECT digest FROM official_attestations WHERE seller_id=?)`,now,review.actor,review.reason,seller),
    statement(db,`INSERT INTO history_operations(id,action,namespace,record_key,revision_key,item_key,seller_id,proof_id,committed_at,payload)
      SELECT ?,'reassign','history',?,?,'seller',?,proof_id,?,json_object('canonical_id',?,'proof',?) FROM history_operations WHERE id=?`,
      receipt,seller,String(expected),target,now,target,proof,proof),
  ];
  return (await commit(db,writes,receipt,hash,{seller_id:seller,canonical_id:target},review.actor,review.reason,now)).result;
}
