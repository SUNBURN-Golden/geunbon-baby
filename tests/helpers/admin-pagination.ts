export type ReviewList = 'queue' | 'candidates';
export type ReviewRow = { id: string; captured_at: string; status: string };
export type ReviewPage = { data: ReviewRow[]; next_cursor: string | null };
export const reviewTables = { queue: 'ingested_items', candidates: 'external_candidates' } as const;
export const reviewStatuses = { queue: 'pending', candidates: 'candidate' } as const;
export const reviewId = (list: ReviewList, index: number) => `${list}-${String(index).padStart(4, '0')}`;

export async function insertReviewRow(db: D1Database, list: ReviewList, id: string, capturedAt = '2026-10-20T00:00:00.000Z') {
  if (list === 'queue') {
    await db.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES (?,?,?,?,?,?)')
      .bind(id, `https://www.instagram.com/p/${id}/`, 'offline.fixture', `Synthetic caption ${id}`, 'post', capturedAt).run();
  } else {
    await db.prepare('INSERT INTO external_candidates (id,source,source_url,title,text,captured_at,last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, 'pangpang', `https://09pangpang.com/deal/${id}`, `Synthetic candidate ${id}`, 'Offline fixture', capturedAt, capturedAt).run();
  }
}

export async function seedReviewRows(db: D1Database, list: ReviewList, count: number) {
  const indices = Array.from({ length: count }, (_, index) => index);
  // Shuffled insertion order and ties larger than the endpoints' default pages.
  const shuffled = [...indices.filter(i => i % 2 === 0).reverse(), ...indices.filter(i => i % 2 === 1).reverse()];
  for (const index of shuffled) await insertReviewRow(db, list, reviewId(list, index), index < Math.ceil(count / 2) ? '2026-10-20T00:00:00.000Z' : '2026-10-21T00:00:00.000Z');
}

export async function orderedReviewRows(db: D1Database, list: ReviewList) {
  return (await db.prepare(`SELECT id,captured_at,status FROM ${reviewTables[list]} WHERE status = ? ORDER BY captured_at ASC,id ASC`)
    .bind(reviewStatuses[list]).all<ReviewRow>()).results;
}

export function fixtureCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
