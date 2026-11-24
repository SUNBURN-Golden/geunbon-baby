import { normalizeTimestamp } from '../../lib/deals';

// Query and presentation fixtures seed the approved projection directly. The
// verification suites use the authenticated ingest and review entry points.
export const fixtureCheckedAt = '2026-10-20T16:00:00.000Z';
const officialUrl = 'https://fixture.example/official';
const approvalId = '9'.repeat(64);
export const fixtureScope = { id: approvalId, revision: 2, url: officialUrl, brand: 'fixture', model: 'fixture',
  approved_at: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' };
export const fixtureProofBody = (url: string, checkedAt: string) => JSON.stringify({
  offer: { source: { url } }, official: { source: { url: officialUrl, observed_at: checkedAt } },
  official_approval: { id: approvalId, revision: 2 },
});
export async function seedFixtureAuthority(db: D1Database) {
  await db.prepare("INSERT OR IGNORE INTO official_price_approvals VALUES (1,?,?)")
    .bind(fixtureCheckedAt, JSON.stringify([fixtureScope])).run();
}
export async function seedPublicPrice(db: D1Database, id: string, deal: number, list = 430000) {
  await db.prepare(`INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,status)
    VALUES (?,?,'fixture','fixture','post',?,'approved') ON CONFLICT(id) DO UPDATE SET status = 'approved'`)
    .bind(id, `https://fixture.example/offers/${encodeURIComponent(id)}`, fixtureCheckedAt).run();
  const row = await db.prepare('SELECT ends_at,source_url,version FROM deals WHERE id = ?').bind(id)
    .first<{ ends_at: string; source_url: string; version: number }>();
  if (!row) throw new Error('Missing fixture deal');
  const deadline = normalizeTimestamp(row.ends_at);
  if (!deadline) return;
  await seedFixtureAuthority(db);
  const evidence = 'fixture-' + id;
  const checked = new Date(Date.now()).toISOString();
  await db.prepare(`INSERT INTO deal_price_evidence (id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
    VALUES (?,'deal',?,?,'verified',?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,observed_at=excluded.observed_at`)
    .bind(evidence, id, String(row.version), fixtureProofBody(row.source_url, checked), checked, checked).run();
  await db.prepare(`UPDATE deals SET ends_at = ?,deal_price_krw = ?,list_price_krw = ?,price_source_url = ?,
    list_price_source_url = 'https://fixture.example/official',price_checked_at = ?,price_verification = 'verified',
    price_evidence_id = ?,price_evidence_version = version WHERE id = ?`)
    .bind(deadline, deal, list, row.source_url, checked, evidence, id).run();
  await seedFixtureHistory(db,id);
}

// Large pagination and presentation fixtures stand in for a committed publication.
export function seedFixtureHistory(db: D1Database, onlyId: string | null = null) {
  const projection = `FROM deals d JOIN sellers s ON s.id=d.seller_id
    WHERE d.verified_price_ready=1 AND (? IS NULL OR d.id=?)`;
  const now = new Date(Date.now()).toISOString();
  const fixtureConfig = JSON.stringify(['fixture','fixture','1','default','1','none']);
  const statements = [
    db.prepare(`INSERT INTO seller_campaigns(id,seller_id,title,starts_at,source_url,locator,evidence_ref)
      SELECT d.id,d.seller_id,d.title,d.verified_start_utc,d.source_url,'fixture','fixture' ${projection} ON CONFLICT DO NOTHING`).bind(onlyId,onlyId),
    db.prepare(`INSERT INTO campaign_deals SELECT d.id,d.id ${projection} ON CONFLICT DO NOTHING`).bind(onlyId,onlyId),
    db.prepare(`INSERT INTO campaign_offers(id,campaign_id,deal_id,model_id,configuration_key,scope)
      SELECT d.id,d.id,d.id,COALESCE((SELECT id FROM models WHERE id=d.model_id),(SELECT id FROM models LIMIT 1)),?,'unit'
      ${projection} ON CONFLICT DO NOTHING`).bind(fixtureConfig,onlyId,onlyId),
    db.prepare(`INSERT INTO offer_price_observations
      SELECT d.id,d.id,d.id,o.model_id,?,'unit',d.deal_price_krw,d.list_price_krw,?,'instant',?,
        d.source_url,d.list_price_source_url,d.price_checked_at,d.ends_at,'instant',?,2,?, ?,d.price_evidence_id,'fixture'
      FROM deals d JOIN campaign_offers o ON o.id=d.id WHERE (? IS NULL OR d.id=?) ON CONFLICT DO NOTHING`)
      .bind(fixtureConfig,now,now,approvalId,fixtureScope.approved_at,fixtureScope.expires_at,onlyId,onlyId),
    db.prepare(`INSERT INTO history_operations
      SELECT d.id,'merge','fixture',d.id,CAST(d.version AS TEXT),'parent',d.id,d.version,d.seller_id,o.model_id,d.price_evidence_id,?,'{}'
      FROM deals d JOIN campaign_offers o ON o.id=d.id WHERE (? IS NULL OR d.id=?) ON CONFLICT DO NOTHING`)
      .bind(now,onlyId,onlyId),
    db.prepare(`INSERT INTO campaign_observations
      SELECT p.id,'fixture',p.id,'1','parent',p.id,p.id,p.source_url,'fixture','fixture',?,'instant',?,p.proof_id,1,NULL
      FROM offer_price_observations p WHERE (? IS NULL OR p.id=?) ON CONFLICT DO NOTHING`)
      .bind(now,now,onlyId,onlyId),
  ];
  return (async () => { for (const write of statements) await write.run(); })();
}
