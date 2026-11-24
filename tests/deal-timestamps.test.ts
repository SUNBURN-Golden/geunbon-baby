import { seedPublicPrice } from './helpers/public-deal-fixture';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Calendar from '../app/calendar/page';
import ModelDetail from '../app/models/[id]/page';
import DealDetail from '../app/deals/[id]/page';
import { normalizeTimestamp, parseTimestamp, parseDate, dealTiming, formatDealDate, sortDeals } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import type { Deal } from '../lib/data';
import { memoryD1 } from './helpers/sqlite';
import { api, approval, legacy, migrate, pending } from './helpers/deal-timestamps';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(), environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
let memory: ReturnType<typeof memoryD1>;
let call: ReturnType<typeof api>;
beforeEach(async () => {
  memory = memoryD1();
  context.db = memory.db;
  call = api(memory.db);
  await migrate(memory.db);
});
afterEach(() => memory.close());

const invalid = [
  '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z',
  '2026-13-01T00:00:00Z', '2026-10-00T00:00:00Z', '2026-04-31T00:00:00Z',
  '2026-10-23T24:00:00Z', '2026-10-23T00:60:00Z', '2026-10-23T00:00:60Z',
  '2026-10-23T00:00:00.1234Z', '2026-10-23T00:00:00.Z',
  '2026-10-23T00:00:00+24:00', '2026-10-23T00:00:00+09:60', '2026-10-23T00:00:00+0900',
  '2026-10-23T00:00:00', '2026-10-23', '2026-10-23T00:00:00Zextra',
  '0000-01-01T00:00:00+00:01', '9999-12-31T23:59:59-00:01',
];
const accepted = [
  ['2026-10-23T10:00:00+09:00', '2026-10-23T01:00:00.000Z'],
  ['2026-10-24T01:00:00+15:00', '2026-10-23T10:00:00.000Z'],
  ['2026-10-23T00:00:00-23:59', '2026-10-23T23:59:00.000Z'],
  ['2026-10-23T00:00:00.5Z', '2026-10-23T00:00:00.500Z'],
  ['2026-10-23T00:00:00.12+00:00', '2026-10-23T00:00:00.120Z'],
  ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
  ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
  ['0000-01-01T00:00:00Z', '0000-01-01T00:00:00.000Z'],
  ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
];
test.each(accepted)('normalizes and approves %s', async (input, expected) => {
  expect(parseTimestamp(input)).toBe(Date.parse(expected));
  expect(normalizeTimestamp(input)).toBe(expected);
  // Near the upper boundary, choose an earlier start and use the input as end.
  const start = expected.startsWith('9999') ? '9999-12-30T00:00:00Z' : input;
  const end = expected.startsWith('9999') ? input : `${expected.slice(0, 10)}T23:59:59.999Z`;
  await pending(memory.db, 'valid');
  expect((await call('admin/review/valid', approval(start, end))).status).toBe(200);
  expect(await memory.db.prepare('SELECT starts_at,ends_at FROM deals WHERE id = ?').bind('valid').first())
    .toEqual({ starts_at: normalizeTimestamp(start), ends_at: normalizeTimestamp(end) });
});

test('approves the mixed-offset acceptance pair and stores fixed-width UTC values', async () => {
  await pending(memory.db, 'mixed');
  expect((await call('admin/review/mixed', approval('2026-10-23T10:00:00+09:00', '2026-10-23T02:00:00Z'))).status).toBe(200);
  expect(await memory.db.prepare('SELECT starts_at,ends_at FROM deals').first()).toEqual({
    starts_at: '2026-10-23T01:00:00.000Z', ends_at: '2026-10-23T02:00:00.000Z',
  });
});

test.each(invalid)('rejects %s in both approval fields without changing pending state', async value => {
  expect(normalizeTimestamp(value)).toBeNull();
  await pending(memory.db, 'invalid');
  for (const body of [approval(value, '9999-12-31T23:59:59Z'), approval('0000-01-01T00:00:00Z', value)]) {
    expect((await call('admin/review/invalid', body)).status).toBe(400);
    expect(await memory.db.prepare("SELECT status FROM ingested_items WHERE id = 'invalid'").first()).toEqual({ status: 'pending' });
    expect((await memory.db.prepare('SELECT * FROM deals').all()).results).toEqual([]);
  }
});

test.each([
  ['2026-10-23T02:00:00Z', '2026-10-23T10:00:00+09:00'],
  ['2026-10-23T01:00:00Z', '2026-10-23T10:00:00+09:00'],
])('rejects end <= start by instant (%s, %s)', async (start, end) => {
  await pending(memory.db, 'reversed');
  expect((await call('admin/review/reversed', approval(start, end))).status).toBe(400);
  expect(await memory.db.prepare("SELECT status FROM ingested_items WHERE id = 'reversed'").first()).toEqual({ status: 'pending' });
});

test('non-string timestamps fail closed', () => {
  for (const value of [null, undefined, 0, {}, [], true]) expect(normalizeTimestamp(value)).toBeNull();
});

const ingest = { source_url: 'https://www.instagram.com/p/timestamp/', account: 'offline-test', text: 'Synthetic fixture', kind: 'post', captured_at: '2026-10-23T10:00:00+09:00' };
const external = { kind: 'external_listing', source: 'pangpang', source_url: 'https://09pangpang.com/deal/timestamp', title: 'Synthetic candidate', text: 'Synthetic fixture', captured_at: ingest.captured_at, starts_at: '2026-10-23T10:00:00+09:00', ends_at: '2026-10-23T02:00:00Z' };
test.each(invalid)('ingest, external dates and suggestion dates reject %s', async value => {
  expect((await call('ingest', { ...ingest, captured_at: value })).status).toBe(400);
  for (const field of ['captured_at', 'starts_at', 'ends_at']) {
    expect((await call('ingest', { ...external, [field]: value })).status).toBe(400);
  }
  for (const field of ['starts_at', 'ends_at']) {
    const dates = { starts_at: null, ends_at: null, raw: 'Synthetic dates', confidence: 1, [field]: value };
    expect((await call('ingest', { ...ingest, suggestions: { models: [], price: null, dates, links: [], confidence: 1 } })).status).toBe(400);
  }
  expect((await memory.db.prepare('SELECT * FROM ingested_items').all()).results).toEqual([]);
  expect((await memory.db.prepare('SELECT * FROM external_candidates').all()).results).toEqual([]);
});

test.each([
  ['2026-10-23T10:00:00+09:00', '2026-10-23T01:00:00.000Z'],
  ['2026-10-24T01:00:00+15:00', '2026-10-23T10:00:00.000Z'],
  ['2026-10-23T00:00:00-23:59', '2026-10-23T23:59:00.000Z'],
])('ingest and external dates normalize %s; suggestions preserve original strings', async (start, utc) => {
  const candidate = { ...external, starts_at: start, captured_at: start, ends_at: '2026-10-24T02:00:00Z' };
  const suggestions = { models: [], price: null, dates: { starts_at: candidate.starts_at, ends_at: candidate.ends_at, raw: 'Synthetic dates', confidence: 1 }, links: [], confidence: 1 };
  expect((await call('ingest', { ...ingest, captured_at: start, suggestions })).status).toBe(202);
  expect(await memory.db.prepare('SELECT captured_at,suggestions FROM ingested_items').first()).toEqual({ captured_at: utc, suggestions: JSON.stringify(suggestions) });
  expect((await call('ingest', candidate)).status).toBe(202);
  expect(await memory.db.prepare('SELECT starts_at,ends_at,captured_at FROM external_candidates').first()).toEqual({ starts_at: utc, ends_at: '2026-10-24T02:00:00.000Z', captured_at: utc });
  expect((await call('ingest', { ...external, starts_at: external.ends_at, ends_at: external.starts_at })).status).toBe(400);
});

test('API and rendered lists order normalized instants and break ties by ID despite reverse insertion', async () => {
  for (const [id, start] of [['B', '2026-10-23T20:00:00Z'], ['A-tie', '2026-10-24T01:00:00+09:00'], ['A', '2026-10-24T01:00:00+09:00']]) {
    await pending(memory.db, id);
    expect((await call(`admin/review/${id}`, approval(start, '2026-10-25T00:00:00Z', `Title ${id}`))).status).toBe(200);
    await seedPublicPrice(memory.db, id, 390000);
  }
  for (const path of ['calendar', 'deals', 'models/model-1']) {
    const response = await call(path);
    const deals = path.startsWith('models')
      ? (await response.json<{ data: { comparison: { gonggu: Deal[] } } }>()).data.comparison.gonggu
      : (await response.json<{ data: Deal[] }>()).data;
    expect(deals.map((d: Deal) => d.id)).toEqual(['A', 'A-tie', 'B']);
  }
  for (const node of [await Calendar(), await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) })]) {
    const html = renderToStaticMarkup(node);
    expect([...html.matchAll(/<a class="deal-title-link"[^>]*>(Title [^<]+)<\/a>/g)].map(m => m[1])).toEqual(['Title A', 'Title A-tie', 'Title B']);
  }
});

test('only checked dates accept date-only values; strict schedule sorting leaves them unknown', () => {
  expect(parseDate('2026-10-23')).toBe(Date.parse('2026-10-23T00:00:00Z'));
  expect(Number.isNaN(parseTimestamp('2026-10-23'))).toBe(true);
  expect(formatDealDate('2026-10-23')).toBe('2026.10.23');
  expect(dealTiming('2026-10-23', '2026-10-24', Date.parse('2026-10-23T01:00:00Z'))).toEqual({ state: 'unknown', days: null });
  const unknown = { id: 'unknown', starts_at: '2026-10-23', ends_at: '2026-10-24' } as Deal;
  const valid = { id: 'valid', starts_at: '2026-10-24T01:00:00+09:00', ends_at: '2026-10-25T00:00:00Z' } as Deal;
  expect(sortDeals([unknown, valid], Date.parse('2026-10-23T00:00:00Z')).map(d => d.id)).toEqual(['valid', 'unknown']);
});

test('KST midnight changes day counts and every page agrees on visible dates and instant attributes', async () => {
  const start = '2026-10-22T15:00:00.000Z';
  const end = '2026-10-23T15:00:00.000Z';
  const midnight = Date.parse(start);
  expect(formatDealDate(start, true)).toBe('2026.10.23 00:00');
  expect(formatDealDate('2026-10-22T14:59:59.999Z', true)).toBe('2026.10.22 23:59');
  expect(dealTiming(start, end, midnight - 1)).toEqual({ state: 'upcoming', days: 1 });
  expect(dealTiming(start, end, midnight)).toEqual({ state: 'active', days: 1 });
  expect(dealTiming(end, '2026-10-24T15:00:00Z', midnight - 1).days).toBe(2);
  expect(dealTiming(end, '2026-10-24T15:00:00Z', midnight).days).toBe(1);
  expect(dealTiming(start, end, Date.parse(end) - 1).days).toBe(1);
  expect(dealTiming(start, end, Date.parse(end)).days).toBe(0);
  await legacy(memory.db, 'midnight', start, end);
  await seedPublicPrice(memory.db, 'midnight', 390000);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(midnight);
  for (const render of [() => Calendar(), () => ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }), () => DealDetail({ params: Promise.resolve({ id: 'midnight' }) })]) {
    clock.mockClear();
    const html = renderToStaticMarkup(await render());
    expect(clock).toHaveBeenCalledTimes(1);
    const visible = html.replace(/<[^>]*>/g, '');
    expect(visible).toContain('2026.10.23 00:00');
    expect(visible).not.toContain('2026.10.22');
    expect(visible).not.toContain('2026-10-22');
    expect(html.toLowerCase()).toContain('datetime="2026-10-22T15:00:00.000Z"'.toLowerCase());
    expect(html).not.toContain(dealsCopy.unknownSchedule);
  }
});
