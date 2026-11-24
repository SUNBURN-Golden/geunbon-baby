import { readFile } from 'node:fs/promises';
import type { SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import { adminCandidatesPage, adminQueuePage } from '../lib/api';
import { all } from '../lib/db';
import { execute, legacy, migrate } from './helpers/deal-timestamps';
import { insertReviewRow, orderedReviewRows, reviewTables, seedReviewRows } from './helpers/admin-pagination';
import { memoryD1 } from './helpers/sqlite';

const restored = [
  { name: 'review_status_cursor', table: 'ingested_items', columns: ['status', 'captured_at', 'id'] },
  { name: 'external_candidates_status_cursor', table: 'external_candidates', columns: ['status', 'captured_at', 'id'] },
  { name: 'deals_calendar', table: 'deals', columns: ['starts_at', 'ends_at'] },
] as const;
const migration0015 = new URL('../migrations/0015_restore_dropped_indexes.sql', import.meta.url);
const indexNames = (db: D1Database) => all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name");
const restoredNames = restored.map(index => index.name);

test('full migration chain restores exactly the three indexes dropped by 0013', async () => {
  const memory = memoryD1(), baseline = memoryD1();
  try {
    await migrate(memory.db, '0015');
    await migrate(baseline.db, '0014');
    const indexes = await all<{ name: string; tbl_name: string }>(memory.db, "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name");
    for (const index of restored) expect(indexes).toContainEqual({ name: index.name, tbl_name: index.table });
    // The chain adds exactly the three restored indexes on top of the post-0014 set.
    const before = (await indexNames(baseline.db)).map(row => row.name);
    expect(indexes.map(row => row.name)).toEqual([...new Set([...before, ...restoredNames])].sort());
    for (const index of restored) {
      const info = await all<{ seqno: number; name: string }>(memory.db, `PRAGMA index_info(${index.name})`);
      expect(info.map(column => [column.seqno, column.name])).toEqual(index.columns.map((column, seqno) => [seqno, column]));
      const list = await all<{ name: string; unique: number; partial: number }>(memory.db, `PRAGMA index_list(${index.table})`);
      expect(list.find(entry => entry.name === index.name)).toMatchObject({ unique: 0, partial: 0 });
    }
  } finally { memory.close(); baseline.close(); }
});

test('0015 is add-only: rows, schema, and existing indexes survive, and re-application is a no-op', async () => {
  const memory = memoryD1();
  try {
    const db = memory.db;
    await migrate(db, '0014');
    await seedReviewRows(db, 'queue', 12);
    await seedReviewRows(db, 'candidates', 12);
    await insertReviewRow(db, 'queue', 'excluded-approved');
    await db.prepare("UPDATE ingested_items SET status = 'approved' WHERE id = 'excluded-approved'").run();
    await insertReviewRow(db, 'candidates', 'excluded-dismissed');
    await db.prepare("UPDATE external_candidates SET status = 'dismissed' WHERE id = 'excluded-dismissed'").run();
    await legacy(db, 'legacy-deal', '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z');
    const rows = async () => ({
      ingested: await all(db, 'SELECT * FROM ingested_items ORDER BY id'),
      candidates: await all(db, 'SELECT * FROM external_candidates ORDER BY id'),
      deals: await all(db, 'SELECT * FROM deals ORDER BY id'),
    });
    const schema = () => all(db, "SELECT type, name, tbl_name FROM sqlite_master WHERE type != 'index' ORDER BY type, name");
    const before = await rows(), beforeSchema = await schema();
    const beforeIndexes = (await indexNames(db)).map(row => row.name);
    // Regression witness: 0013 dropped these and nothing before 0015 recreates them.
    for (const name of restoredNames) expect(beforeIndexes).not.toContain(name);
    const sql = await readFile(migration0015, 'utf8');
    const afterIndexes = [...beforeIndexes, ...restoredNames].sort();
    await execute(db, sql);
    expect((await indexNames(db)).map(row => row.name)).toEqual(afterIndexes);
    expect(await schema()).toEqual(beforeSchema);
    expect(await rows()).toEqual(before);
    expect(await all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    await execute(db, sql);
    expect((await indexNames(db)).map(row => row.name)).toEqual(afterIndexes);
    expect(await schema()).toEqual(beforeSchema);
    expect(await rows()).toEqual(before);
  } finally { memory.close(); }
});

const lists = ['queue', 'candidates'] as const;
test.each(lists)('%s keyset pages stay correct and seek the restored cursor index', async list => {
  const reads: { sql: string; values: SQLInputValue[] }[] = [];
  const memory = memoryD1({ onRead: (sql, values) => reads.push({ sql, values }) });
  try {
    const db = memory.db;
    await migrate(db);
    await seedReviewRows(db, list, 12);
    const excluded = list === 'queue' ? 'approved' : 'dismissed';
    await insertReviewRow(db, list, `excluded-${excluded}`);
    await db.prepare(`UPDATE ${reviewTables[list]} SET status = ? WHERE id = ?`).bind(excluded, `excluded-${excluded}`).run();
    const page = list === 'queue' ? adminQueuePage : adminCandidatesPage;
    const expected = (await orderedReviewRows(db, list)).map(row => row.id);
    const traverse = async (limit: number, cursor: string | null = null) => {
      const ids: string[] = [], sizes: number[] = [];
      do {
        const result = await page(db, { limit, cursor });
        ids.push(...result.data.map(row => row.id)); sizes.push(result.data.length);
        cursor = result.next_cursor;
        expect(sizes.length).toBeLessThan(500);
      } while (cursor);
      return { ids, sizes };
    };
    expect(await traverse(5)).toEqual({ ids: expected, sizes: [5, 5, 2] });
    expect(await traverse(1)).toEqual({ ids: expected, sizes: Array.from({ length: 12 }, () => 1) });
    // The boundary row may be reviewed away; continuation must still work (README contract).
    const first = await page(db, { limit: 5 });
    await db.prepare(`UPDATE ${reviewTables[list]} SET status = ? WHERE id = ?`).bind(excluded, first.data.at(-1)!.id).run();
    expect((await traverse(5, first.next_cursor)).ids).toEqual(expected.slice(5));
    // Snapshot pagination reads before EXPLAIN so its own reads cannot pollute the set.
    const keyset = [...new Map(reads.filter(read => read.sql.includes('(captured_at, id) > (?, ?)')).map(read => [read.sql, read])).values()];
    expect(keyset.length).toBeGreaterThan(0);
    const index = list === 'queue' ? 'review_status_cursor' : 'external_candidates_status_cursor';
    for (const read of keyset) {
      const plan = await all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${read.sql}`, ...read.values as (string | number)[]);
      const detail = plan.map(step => step.detail).join('\n');
      expect(detail).toContain(`SEARCH ${reviewTables[list]} USING INDEX ${index}`);
      expect(detail).not.toMatch(/TEMP B-TREE/);
    }
  } finally { memory.close(); }
});
