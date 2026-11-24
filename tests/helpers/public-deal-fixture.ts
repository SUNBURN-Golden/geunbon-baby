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
}
