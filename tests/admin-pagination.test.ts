import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { adminCandidatesPage, adminQueuePage, handleApi, issueAdminSession } from '../lib/api';
import type { Env } from '../lib/db';
import { api, approval, migrate } from './helpers/deal-timestamps';
import { fixtureCursor, insertReviewRow, orderedReviewRows, reviewId, reviewStatuses, reviewTables, seedReviewRows, type ReviewList, type ReviewPage } from './helpers/admin-pagination';
import { memoryD1 } from './helpers/sqlite';

const lists = ['queue', 'candidates'] as const;
let memory: ReturnType<typeof memoryD1>, call: ReturnType<typeof api>;
beforeEach(async () => {
  memory = memoryD1(); await migrate(memory.db); call = api(memory.db);
});
afterEach(() => memory.close());

async function page(list: ReviewList, params = new URLSearchParams()) {
  const response = await call(`admin/${list}?${params}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json<ReviewPage>();
}
async function traverse(list: ReviewList, limit?: number, cursor?: string | null) {
  const ids: string[] = [], sizes: number[] = [];
  do {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const result = await page(list, params);
    ids.push(...result.data.map(row => row.id)); sizes.push(result.data.length);
    cursor = result.next_cursor;
    expect(sizes.length).toBeLessThan(500);
  } while (cursor);
  return { ids, sizes };
}

test.each(lists)('%s traverses beyond the former cap with shuffled timestamp ties and mandatory status selection', async list => {
  const count = list === 'queue' ? 237 : 437, maximum = list === 'queue' ? 100 : 200;
  await seedReviewRows(memory.db, list, count);
  for (const status of list === 'queue' ? ['approved', 'rejected'] : ['dismissed']) {
    const id = `excluded-${status}`;
    await insertReviewRow(memory.db, list, id);
    await memory.db.prepare(`UPDATE ${reviewTables[list]} SET status = ? WHERE id = ?`).bind(status, id).run();
  }
  const expected = (await orderedReviewRows(memory.db, list)).map(row => row.id);
  const result = await traverse(list);
  expect(result).toEqual({ ids: expected, sizes: [maximum, maximum, 37] });
  expect(new Set(result.ids).size).toBe(count);
  expect((await traverse(list, maximum)).ids).toEqual(expected);
  expect((await traverse(list, 1)).ids).toEqual(expected);
  expect((await page(list)).data.every(row => row.status === reviewStatuses[list])).toBe(true);
  const shared = list === 'queue' ? await adminQueuePage(memory.db) : await adminCandidatesPage(memory.db);
  expect(shared).toEqual(await page(list));
});

test.each(lists)('%s handles empty, singleton, exact multiples, partial final pages, and lookahead boundaries', async list => {
  expect(await page(list)).toEqual({ data: [], next_cursor: null });
  await seedReviewRows(memory.db, list, 1);
  expect(await traverse(list, 1)).toEqual({ ids: [reviewId(list, 0)], sizes: [1] });
  await memory.db.prepare(`DELETE FROM ${reviewTables[list]}`).run();
  await seedReviewRows(memory.db, list, 6);
  expect((await traverse(list, 3)).sizes).toEqual([3, 3]);
  expect((await traverse(list, 4)).sizes).toEqual([4, 2]);
  const first = await page(list, new URLSearchParams({ limit: '3' }));
  const decoded = JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString('utf8'));
  expect(decoded).toEqual([1, list, first.data.at(-1)!.captured_at, first.data.at(-1)!.id]);
  const next = await page(list, new URLSearchParams({ limit: '3', cursor: first.next_cursor! }));
  expect(next.data[0].id).toBe(reviewId(list, 3));
  expect(next.next_cursor).toBeNull();
});

test.each(lists)('%s preserves exact legacy timestamp text and UTF-8 IDs at the boundary', async list => {
  const times = ['2026-10-20', '2026-10-20 00:00:00', '2026-10-20T00:00:00', '2026-10-20T00:00:00.000Z', '2026-10-20T09:00:00+09:00'];
  for (const timestamp of times) for (const suffix of ['가', '나']) await insertReviewRow(memory.db, list, `${timestamp}-${suffix}`, timestamp);
  const expected = await orderedReviewRows(memory.db, list);
  expect((await traverse(list, 1)).ids).toEqual(expected.map(row => row.id));
});

test.each(lists)('%s rejects malformed, noncanonical, wrong-endpoint, and oversized cursors before reading D1', async list => {
  const tuple = [1, list, '2026-10-20T00:00:00.000Z', 'anchor'];
  const valid = fixtureCursor(tuple);
  const padded = ['a', 'ab', 'abc'].map(id => fixtureCursor([...tuple.slice(0, 3), id])).find(cursor => cursor.length % 4 !== 0)!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const nonzeroPaddingBits = padded.slice(0, -1) + alphabet[alphabet.indexOf(padded.at(-1)!) + 1];
  const malformed = [
    '', '!', 'a', 'not-a-cursor', 'a'.repeat(2049), `${valid}=`, `${valid}\n`, nonzeroPaddingBits,
    Buffer.from('{').toString('base64url'), Buffer.from([0xff, 0xfe]).toString('base64url'),
    Buffer.from(` ${JSON.stringify(tuple)}`).toString('base64url'),
    ...[null, {}, [], [1, list], [...tuple, 'extra'], [2, ...tuple.slice(1)], ['1', ...tuple.slice(1)],
      [1, list === 'queue' ? 'candidates' : 'queue', ...tuple.slice(2)],
      [1, list, 123, 'anchor'], [1, list, 'x'.repeat(65), 'anchor'], [1, list, 'invalid', 'anchor'], [1, list, '2026-02-30T00:00:00Z', 'anchor'],
      [1, list, '2026-10-20T25:00:00Z', 'anchor'], [1, list, tuple[2], ''],
      [1, list, tuple[2], ' '], [1, list, tuple[2], 12], [1, list, tuple[2], 'x'.repeat(257)],
      [1, list, tuple[2], 'id\n']].map(fixtureCursor),
  ];
  const prepare = vi.spyOn(memory.db, 'prepare');
  for (const cursor of malformed) {
    const response = await call(`admin/${list}?${new URLSearchParams({ cursor })}`);
    expect(response.status, cursor).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_cursor' });
  }
  const duplicate = await call(`admin/${list}?cursor=${valid}&cursor=${valid}`);
  expect(duplicate.status).toBe(400); expect(await duplicate.json()).toEqual({ error: 'invalid_cursor' });
  expect(prepare).not.toHaveBeenCalled();
  // A valid boundary need not refer to an existing row.
  expect(await page(list, new URLSearchParams({ cursor: valid }))).toEqual({ data: [], next_cursor: null });
});

test.each(lists)('%s rejects nondecimal, out-of-range and duplicate limits before reading D1', async list => {
  const prepare = vi.spyOn(memory.db, 'prepare');
  for (const limit of ['', '0', '-1', '1.5', '1e2', '0x10', '+1', ' 1', '1 ', 'NaN', 'Infinity', list === 'queue' ? '101' : '201', '9'.repeat(300)]) {
    const response = await call(`admin/${list}?${new URLSearchParams({ limit })}`);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_limit' });
  }
  const response = await call(`admin/${list}?limit=1&limit=2`);
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_limit' });
  expect(prepare).not.toHaveBeenCalled();
  expect(await page(list, new URLSearchParams({ limit: '001' }))).toEqual({ data: [], next_cursor: null });
});

test.each(lists)('%s authenticates before pagination validation or D1 access, retaining 401/503 and no-store', async list => {
  const admin = 'timestamp-admin-test-only', ingest = 'timestamp-ingest-test-only', status = 'timestamp-status-test-only';
  const env: Env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: admin, INGEST_TOKEN: ingest, COLLECTOR_STATUS_TOKEN: status };
  const session = await issueAdminSession(admin);
  const prepare = vi.spyOn(memory.db, 'prepare');
  for (const token of [undefined, 'wrong-test-token', ingest, status, session]) for (const query of ['', '?cursor=!&limit=bad&limit=2']) {
    const response = await handleApi(new Request(`https://local.invalid/api/v1/admin/${list}${query}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), cookie: `agamajung_admin=${session}` },
    }), ['admin', list], env);
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(await response.json<Record<string, unknown>>())).toEqual(['error']);
  }
  for (const changed of [{ ADMIN_TOKEN: undefined }, { INGEST_TOKEN: admin }]) {
    const response = await handleApi(new Request(`https://local.invalid/api/v1/admin/${list}?cursor=!`, { headers: { authorization: `Bearer ${admin}` } }), ['admin', list], { ...env, ...changed });
    expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(prepare).not.toHaveBeenCalled();
});

test.each(lists)('%s survives review/removal before and after the boundary, including deleting its anchor', async list => {
  await seedReviewRows(memory.db, list, 12);
  const first = await page(list, new URLSearchParams({ limit: '3' }));
  const review = async (index: number, approve = false) => {
    const id = reviewId(list, index);
    const response = list === 'queue'
      ? await call(`admin/review/${id}`, approve ? approval('2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z') : { action: 'reject' })
      : await call(`admin/candidates/${id}`, { action: 'dismiss' });
    expect(response.status).toBe(200);
  };
  await review(0); await review(4, true); await review(6);
  await memory.db.prepare(`DELETE FROM ${reviewTables[list]} WHERE id IN (?, ?)`).bind(reviewId(list, 2), reviewId(list, 8)).run();
  const expected = (await orderedReviewRows(memory.db, list)).filter(row => row.id !== reviewId(list, 1)).map(row => row.id);
  expect((await traverse(list, 2, first.next_cursor)).ids).toEqual(expected);
  await memory.db.prepare(`DELETE FROM ${reviewTables[list]} WHERE status = ?`).bind(reviewStatuses[list]).run();
  expect(await page(list, new URLSearchParams({ cursor: first.next_cursor! }))).toEqual({ data: [], next_cursor: null });
});

test.each(lists)('%s is a live list: later additions appear; backdated additions require restarting', async list => {
  await seedReviewRows(memory.db, list, 6);
  const first = await page(list, new URLSearchParams({ limit: '3' }));
  await insertReviewRow(memory.db, list, 'new-after-boundary', '2026-10-22T00:00:00.000Z');
  await insertReviewRow(memory.db, list, 'new-backdated', '2026-10-19T00:00:00.000Z');
  const rest = await traverse(list, 3, first.next_cursor);
  expect(rest.ids).toEqual([reviewId(list, 3), reviewId(list, 4), reviewId(list, 5), 'new-after-boundary']);
  expect((await traverse(list)).ids[0]).toBe('new-backdated');
});

test('candidate refresh preserves captured_at and the outstanding continuation boundary', async () => {
  await seedReviewRows(memory.db, 'candidates', 6);
  const first = await page('candidates', new URLSearchParams({ limit: '3' }));
  for (const index of [2, 4]) {
    const response = await call('ingest', {
      kind: 'external_listing', source: 'pangpang', source_url: `https://09pangpang.com/deal/${reviewId('candidates', index)}`,
      title: 'Refreshed offline candidate', text: 'Synthetic refreshed description', captured_at: '2026-10-29T00:00:00Z',
    });
    expect(response.status).toBe(202);
  }
  expect((await traverse('candidates', 2, first.next_cursor)).ids).toEqual([3, 4, 5].map(index => reviewId('candidates', index)));
  const refreshed = await memory.db.prepare('SELECT captured_at,title FROM external_candidates WHERE id = ?').bind(reviewId('candidates', 4)).first();
  expect(refreshed).toEqual({ captured_at: '2026-10-21T00:00:00.000Z', title: 'Refreshed offline candidate' });
});

test.each(lists)('%s does not disguise database failures as empty pages or invalid cursors', async list => {
  vi.spyOn(memory.db, 'prepare').mockImplementation(() => { throw new Error('Synthetic D1 failure'); });
  await expect(call(`admin/${list}`)).rejects.toThrow('Synthetic D1 failure');
});
