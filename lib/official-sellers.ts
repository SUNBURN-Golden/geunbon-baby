import { canonical, isDigest, verifyAttestation, type OfficialPolicy } from '../shared/official-seller';
import { commit, decision, digest, guard, object, reject, replay, statement } from './history-review';

const brandAssignment = `EXISTS (SELECT 1 FROM accepted_seller_rounds c
  JOIN accepted_offer_prices o ON o.campaign_id=c.id JOIN models m ON m.id=o.model_id
  WHERE c.seller_id=? AND m.brand=? AND (? IS NULL OR c.id=?))`;

export async function manageOfficialSeller(db: D1Database, raw: unknown, policyJSON?: string) {
  const b = object(raw);
  const now = new Date().toISOString();
  if (b.action === 'store') {
    let policy: OfficialPolicy;
    try { policy = JSON.parse(policyJSON ?? 'null'); if (!policy?.brands || !policy.models || !policy.keys) throw new Error(); }
    catch { return reject('verifier_unconfigured', 503); }
    const packet = await verifyAttestation(b.packet, policy);
    if (!packet || packet.envelope.claim.captured_at > now) return reject('invalid_attestation');
    const { envelope: e, digest: id } = packet;
    const c = e.claim;
    const receipt = `official:${id}`;
    const previous = await replay<{ digest: string; state: string }>(db,receipt,id);
    if (previous) return previous;
    const writes = [
      guard(db, `EXISTS (SELECT 1 FROM canonical_sellers WHERE id=? AND canonical_id=id) AND ${brandAssignment}`,
        c.seller_id,c.seller_id,c.brand_id,c.campaign_id,c.campaign_id),
      guard(db,`EXISTS (SELECT 1 FROM seller_identity_aliases WHERE seller_id=? AND source_url=?)`,c.seller_id,c.seller_identity_url),
      guard(db, `NOT EXISTS (SELECT 1 FROM official_attestations WHERE seller_id=? AND brand_id=? AND campaign_id IS ?
        AND json_extract(envelope,'$.envelope.claim.captured_at')>=?)`,c.seller_id,c.brand_id,c.campaign_id,c.captured_at),
      statement(db, `UPDATE official_approvals SET state='superseded',decided_at=?,actor=?,reason=?
        WHERE state='approved' AND digest IN (SELECT digest FROM official_attestations WHERE seller_id=? AND brand_id=? AND campaign_id IS ?)`,
        now,e.key_id,'newer verified evidence',c.seller_id,c.brand_id,c.campaign_id),
      statement(db,'INSERT INTO official_attestations VALUES (?,?,?,?,?,?,?)',id,e.key_id,c.seller_id,c.brand_id,c.campaign_id,c.evidence_url,canonical(packet)),
      statement(db,"INSERT INTO official_approvals VALUES (?,'approved',?,?,?)",id,now,e.key_id,'independent provider agreement'),
    ];
    return (await commit(db,writes,receipt,id,{ digest:id,state:'approved' },e.key_id,'independent provider agreement',now)).result;
  }
  const review = decision(b);
  const id = b.digest;
  if (!isDigest(id) || b.action !== 'revoke') return reject('invalid_attestation_decision');
  const hash = await digest([review,id,b.action]);
  const receipt = `official-revoke:${review.request_id}`;
  const prior = await replay<{ digest: string; state: string }>(db,receipt,hash);
  if (prior) return prior;
  return (await commit(db,[
    guard(db,"EXISTS (SELECT 1 FROM official_approvals WHERE digest=? AND state='approved')",id),
    statement(db,"UPDATE official_approvals SET state='revoked',decided_at=?,actor=?,reason=? WHERE digest=?",now,review.actor,review.reason,id),
  ],receipt,hash,{digest:id,state:'revoked'},review.actor,review.reason,now)).result;
}
