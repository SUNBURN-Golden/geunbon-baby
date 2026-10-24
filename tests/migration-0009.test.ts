import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Calendar from '../app/calendar/page';
import ModelDetail from '../app/models/[id]/page';
import DealDetail from '../app/deals/[id]/page';
import { normalizeTimestamp } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import type { Deal } from '../lib/data';
import { memoryD1 } from './helpers/sqlite';
import { api, approval, execute, legacy, migrate, pending } from './helpers/deal-timestamps';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(), environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
let memory: ReturnType<typeof memoryD1>;
let migration: string;
beforeEach(async () => {
  memory = memoryD1();
  context.db = memory.db;
  await migrate(memory.db, '0008');
  migration = await readFile(new URL('../migrations/0009_normalize_deal_timestamps.sql', import.meta.url), 'utf8');
});
afterEach(() => memory.close());

// Every pair passes the old text CHECK. Fixtures exercise both fields and
// include UTC-year underflow, which SQLite formats as a negative year.
const fixtures: [string, string, string][] = [
  ['offset', '2026-10-23T10:00:00+09:00', '2026-10-23T11:00:00+09:00'],
  ['fraction', '2026-10-23T00:00:00.5Z', '2026-10-23T01:00:00.12Z'],
  ['plus15', '2026-10-24T01:00:00+15:00', '2026-10-24T02:00:00+15:00'],
  ['minus2359', '2026-10-23T00:00:00-23:59', '2026-10-24T00:00:00-23:59'],
  ['plus2359', '2026-10-23T00:00:00+23:59', '2026-10-24T00:00:00+23:59'],
  ['normalized', '2026-10-23T01:00:00.000Z', '2026-10-23T02:00:00.000Z'],
  ['leap', '2028-02-29T00:00:00Z', '2028-03-01T00:00:00Z'],
  ['year0000', '0000-01-01T00:00:00Z', '0000-01-02T00:00:00Z'],
  ['year9999', '9999-12-30T00:00:00Z', '9999-12-31T23:59:59.999Z'],
  ['feb30', '2026-02-30T00:00:00Z', '2026-03-03T00:00:00Z'],
  ['nonleap', '2026-02-29T00:00:00Z', '2026-03-03T00:00:00Z'],
  ['month13', '2026-13-01T00:00:00Z', '2027-01-03T00:00:00Z'],
  ['day00', '2026-10-00T00:00:00Z', '2026-10-03T00:00:00Z'],
  ['hour24', '2026-10-23T24:00:00Z', '2026-10-25T00:00:00Z'],
  ['minute60', '2026-10-23T00:60:00Z', '2026-10-25T00:00:00Z'],
  ['second60', '2026-10-23T00:00:60Z', '2026-10-25T00:00:00Z'],
  ['longfraction', '2026-10-23T00:00:00.1234Z', '2026-10-25T00:00:00Z'],
  ['emptyfraction', '2026-10-23T00:00:00.Z', '2026-10-25T00:00:00Z'],
  ['badfraction', '2026-10-23T00:00:00.1xZ', '2026-10-25T00:00:00Z'],
  ['zone0900', '2026-10-23T00:00:00+0900', '2026-10-25T00:00:00Z'],
  ['zone24', '2026-10-23T00:00:00+24:00', '2026-10-25T00:00:00Z'],
  ['zoneminute60', '2026-10-23T00:00:00+09:60', '2026-10-25T00:00:00Z'],
  ['nozone', '2026-10-23T00:00:00', '2026-10-25T00:00:00Z'],
  ['dateonly', '2026-10-23', '2026-10-25'],
  ['suffix', '2026-10-23T00:00:00Zextra', '2026-10-25T00:00:00Z'],
  ['underflow', '0000-01-01T00:00:00+00:01', '0000-01-02T00:00:00Z'],
  ['overflow', '9999-12-30T00:00:00Z', '9999-12-31T23:59:59-00:01'],
  ['reversed', '2026-10-23T02:00:00Z', '2026-10-23T10:00:00+09:00'],
  ['equal', '2026-10-23T01:00:00Z', '2026-10-23T10:00:00+09:00'],
  ['invalidend', '2026-02-01T00:00:00Z', '2026-02-30T00:00:00Z'],
];

test('0009 exactly matches API normalization, preserves rejected pairs and CHECK, and is safe to rerun', async () => {
  // Exercise each malformed start as an end too, ensuring neither field is
  // partially rewritten when its partner cannot be normalized.
  const cases = [...fixtures, ...fixtures.filter(([id]) => ['feb30', 'hour24', 'minute60', 'second60', 'longfraction', 'zone0900', 'zone24', 'zoneminute60', 'nozone', 'dateonly', 'suffix'].includes(id))
    .map(([id, start]): [string, string, string] => [`end-${id}`, '0000-01-01T00:00:00Z', start])];
  for (const row of cases) await legacy(memory.db, ...row);
  const snapshot = () => memory.db.prepare('SELECT * FROM deals ORDER BY id').all<Deal>();
  const before = (await snapshot()).results;
  await execute(memory.db, migration);
  const after = (await snapshot()).results;
  expect(after).toEqual(before.map(row => {
    const start = normalizeTimestamp(row.starts_at);
    const end = normalizeTimestamp(row.ends_at);
    return start !== null && end !== null && end > start ? { ...row, starts_at: start, ends_at: end } : row;
  }));
  expect(after.find(d => d.id === 'plus15')?.starts_at).toBe('2026-10-23T10:00:00.000Z');
  expect(after.find(d => d.id === 'fraction')?.starts_at).toBe('2026-10-23T00:00:00.500Z');
  expect((await memory.db.prepare('PRAGMA integrity_check').first())).toEqual({ integrity_check: 'ok' });
  expect((await memory.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await execute(memory.db, migration);
  expect((await snapshot()).results).toEqual(after);
  expect(await memory.db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'deal_timestamps_0009'").first()).toBeNull();
});

test('migrated extreme offsets and newly approved rows sort together in API and rendered pages', async () => {
  const start = '2026-10-24T01:00:00+15:00';
  await legacy(memory.db, 'migrated', start, '2026-10-24T02:00:00+15:00');
  await execute(memory.db, migration);
  // Current approval code also needs the additive seller review schema.
  await execute(memory.db, await readFile(new URL('../migrations/0010_seller_onboarding.sql', import.meta.url), 'utf8'));
  await pending(memory.db, 'new');
  const call = api(memory.db);
  expect((await call('admin/review/new', approval('2026-10-23T20:00:00Z', '2026-10-24T00:00:00Z', 'New fixture'))).status).toBe(200);
  for (const path of ['calendar', 'deals', 'models/model-1']) {
    const response = await call(path);
    const deals = path.startsWith('models')
      ? (await response.json<{ data: { comparison: { gonggu: Deal[] } } }>()).data.comparison.gonggu
      : (await response.json<{ data: Deal[] }>()).data;
    expect(deals.map(d => d.id)).toEqual(['migrated', 'new']);
  }
  for (const node of [await Calendar(), await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) })]) {
    const visible = renderToStaticMarkup(node).replace(/<[^>]*>/g, '');
    expect(visible.indexOf('Fixture migrated')).toBeGreaterThanOrEqual(0);
    expect(visible.indexOf('Fixture migrated')).toBeLessThan(visible.indexOf('New fixture'));
  }
});

test.each(['dateonly', 'feb30', 'reversed'])('unchanged %s schedules remain unknown on all three pages while date-only checked dates display', async id => {
  const fixture = fixtures.find(([key]) => key === id)!;
  await legacy(memory.db, ...fixture);
  await execute(memory.db, migration);
  for (const node of [await Calendar(), await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }), await DealDetail({ params: Promise.resolve({ id }) })]) {
    const html = renderToStaticMarkup(node);
    expect(html).toContain(dealsCopy.unknownSchedule);
    expect(html).not.toContain('09:00');
    expect(html).toContain('2026.10.20');
    expect(html.toLowerCase()).not.toContain(`datetime="${fixture[1]}"`.toLowerCase());
  }
});
