import { normalizeTimestamp } from './deals';

export type DealReview = {
  round_id: string;
  round_seller_id: string;
  event_key: string;
  opened_at: string;
  round_source: string;
};

const currentDeal = "d.id = ? AND d.version = ? AND d.status = 'published'";

export async function dealRoundReview(db: D1Database, id: string, version: number) {
  return db.prepare(`SELECT r.id AS round_id, r.seller_id AS round_seller_id, r.event_key, r.opened_at,
    link.source_url AS round_source FROM deal_round_reviews link JOIN seller_rounds r ON r.id=link.round_id
    WHERE link.deal_id=? AND link.deal_version=?`).bind(id, version).first<DealReview>();
}

export async function updateDealRound(
  db: D1Database, id: string, version: number, input: Record<string, unknown>, source: string | null,
) {
  if (input.action === 'clear') {
    const removed = await db.prepare(`DELETE FROM deal_round_reviews WHERE deal_id = ? AND deal_version = ?
      AND EXISTS (SELECT 1 FROM deals AS d WHERE ${currentDeal}) RETURNING deal_id`).bind(id, version, id, version).all();
    if (!removed.success) return 503;
    if (removed.results.length) return 200;
    return await db.prepare(`SELECT 1 FROM deals d WHERE ${currentDeal}`).bind(id, version).first() ? 200 : 409;
  }
  if (input.action !== 'confirm' || input.confirmed !== true || !source) return 400;
  const opening = normalizeTimestamp(input.opened_at);
  const key = typeof input.event_key === 'string' ? input.event_key.trim() : '';
  const seller = input.seller_id;
  if (!opening || typeof seller !== 'string' || !seller || !key || key.length > 160 || /[:/\u0000-\u001f\u007f]/.test(key)) return 400;
  const now = new Date().toISOString();
  const eligible = `${currentDeal} AND d.seller_id=? AND d.seller_id NOT GLOB 'ext-*-unknown'`;
  const results = await db.batch([
    db.prepare(`INSERT INTO seller_rounds(id, seller_id, event_key, opened_at, source_url, reviewed_at)
      SELECT ?, d.seller_id, ?, ?, ?, ? FROM deals d
      WHERE ${eligible}
      ON CONFLICT(seller_id, event_key) DO NOTHING`)
      .bind(crypto.randomUUID(), key, opening, source, now, id, version, seller),
    db.prepare(`INSERT INTO deal_round_reviews(deal_id, deal_version, round_id, source_url, reviewed_at)
      SELECT d.id, d.version, r.id, ?, ? FROM deals d JOIN seller_rounds r ON r.seller_id=d.seller_id
      WHERE ${eligible} AND r.event_key=? AND r.opened_at=?
      ON CONFLICT(deal_id, deal_version) DO UPDATE SET
      round_id = excluded.round_id, source_url = excluded.source_url, reviewed_at = excluded.reviewed_at`)
      .bind(source, now, id, version, seller, key, opening),
  ]);
  return results.some(result => !result.success) ? 503 : results[1].meta.changes ? 200 : 409;
}
