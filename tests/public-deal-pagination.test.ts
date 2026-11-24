import { fixtureProofBody, seedFixtureAuthority } from './helpers/public-deal-fixture';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import {
  activeDealCount, activeDealPreview, chronologicalDeals, lifecycleDeals, modelDealSummaries,
  normalizeTimestamp, publicDealOptions, sortDeals, dealTimingFor, publicPageParams,
  type PublicDealSurface,
} from '../lib/deals';
import { publicDealMigration, timestampSql } from '../lib/deal-query-sql';
import type { Deal } from '../lib/data';
import { all } from '../lib/db';
import { memoryD1 } from './helpers/sqlite';
import { api, migrate, legacy } from './helpers/deal-timestamps';
import Home from '../app/page';
import DealsPage from '../app/deals/page';
import Calendar from '../app/calendar/page';
import ModelDetail from '../app/models/[id]/page';
import { dealsCopy } from '../lib/deals-copy';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(), environment: () => ({ DB: context.db }) }));
const NOW = Date.parse('2026-10-21T14:59:59.999Z'); // immediately before KST midnight
const iso = (ms: number) => new Date(ms).toISOString();
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const opts = (surface: PublicDealSurface, limit = 20, cursor: string | null = null, model: string | null = null) => publicDealOptions(new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) }), surface, model);
const modelIds = ['model-1', ...Array.from({ length: 99 }, (_, i) => `m${i + 1}`)];
type Fixture = Deal & { status: string };
const fixture: Fixture[] = [];
function row(i: number, start: string | null, end: string | null, source_ended = 0): Fixture {
  return { id: `d${String(i).padStart(6, '0')}`, model_id: modelIds[i % 100], seller_id: 'seller-1', title: `Offline deal ${i}`, price: i % 4 ? i : null, source_url: `https://example.com/${i}`, verify_level: 'manual', checked: '2026-10-20', starts_at: start, ends_at: end, image_url: null, source_ended, status: i % 113 === 0 ? 'withdrawn' : 'published' };
}
const listPrice = 1_000_000;
const eligible = (d: Fixture) => d.status === 'published' && d.price !== null && normalizeTimestamp(d.ends_at) !== null;
function insert(memory: ReturnType<typeof memoryD1>, rows: Fixture[]) {
  memory.bulk("INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,status) VALUES (?,?,'offline','synthetic','post','2026-10-20','approved')", rows.map(d => [d.id, d.source_url]));
  const proofs = rows.filter(eligible);
  const checked = new Date(Date.now()).toISOString();
  memory.bulk(`INSERT INTO deal_price_evidence (id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
    VALUES (?,'deal',?,'1','verified',?,?,?)`, proofs.map(d => [d.id, d.id, fixtureProofBody(d.source_url, checked), checked, checked]));
  const insertSql = `INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at,image_url,source_ended,status,
    deal_price_krw,list_price_krw,price_source_url,list_price_source_url,price_checked_at,price_verification,price_evidence_id,price_evidence_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  memory.bulk(insertSql, rows.map(d => {
    const verified = eligible(d);
    if (verified) d.ends_at = normalizeTimestamp(d.ends_at);
    // The normalized deadline can sort before an offset-form start with the
    // same instant. Preserve an equivalent offset representation of the start.
    if (d.starts_at != null && d.ends_at != null && d.ends_at <= d.starts_at) {
      if (normalizeTimestamp(d.starts_at) === d.ends_at) d.starts_at = new Date(Date.parse(d.ends_at) - 9 * 3600000).toISOString().replace('Z', '-09:00');
      else d.starts_at = ' ';
    }
    return [d.id,d.model_id,d.seller_id,d.title,d.price,d.source_url,d.verify_level,d.checked,d.starts_at,d.ends_at,d.image_url,d.source_ended!,d.status,
      verified ? d.price : null, verified ? listPrice : null, verified ? d.source_url : null, verified ? 'https://fixture.example/official' : null,
      verified ? checked : null, verified ? 'verified' : 'unverified', verified ? d.id : null, verified ? 1 : null];
  }));
}
function reference(rows: Fixture[], now = NOW, discount = true) {
  const ranks = { active: 0, upcoming: 1, ended: 2, unknown: 3 };
  const key = (d: Fixture, phase: keyof typeof ranks) => phase === 'active' || phase === 'unknown' && discount ? normalizeTimestamp(d.ends_at)! : phase === 'upcoming' ? normalizeTimestamp(d.starts_at)! : phase === 'ended' ? normalizeTimestamp(d.ends_at) ?? '1970-01-01T00:00:00.000Z' : '';
  const savings = (d: Fixture) => Math.floor(100 * (listPrice - d.price!) / listPrice);
  return rows.filter(eligible).sort((a, b) => {
    const x = dealTimingFor(a, now).state, y = dealTimingFor(b, now).state;
    return ranks[x] - ranks[y] || (x === 'active' && discount ? savings(b) - savings(a) : 0) || (x === 'ended' ? -1 : 1) * cmp(key(a, x), key(b, y)) || cmp(a.id, b.id);
  });
}
function chronologicalReference(rows: Fixture[]) {
  return rows.filter(eligible).sort((a, b) => (a.starts_at === null ? b.starts_at === null ? 0 : -1 : b.starts_at === null ? 1 : cmp(a.starts_at, b.starts_at)) || cmp(a.id, b.id));
}

describe('large offline public D1 history', { timeout: 120000 }, () => {
  const reads: { sql: string; values: SQLInputValue[]; count: number }[] = [];
  const memory = memoryD1({ onRead: (sql, values, count) => reads.push({ sql, values, count }) });
  const db = memory.db;
  beforeAll(async () => {
    context.db = db;
    await migrate(db);
    await seedFixtureAuthority(db);
    memory.bulk("INSERT INTO models SELECT ?,brand,name,category,importer,official_price,source_url,checked,verify_level,note FROM models WHERE id='model-1'", modelIds.slice(1).map(id => [id]));
    // Represent legacy records, including reversed/equal intervals rejected by today's writer.
    for (let i = 0; i < 10000; i++) {
      // Ties larger than a page. 98% complete expired history, across 100 models.
      const end = iso(Date.UTC(2020, 0, 1) + Math.floor(i / 150) * 86400000);
      fixture.push(row(i, '2019-01-01T00:00:00Z', end));
    }
    for (let i = 100000; i < 100200; i++) {
      const k = i % 10;
      const start = k < 3 ? iso(NOW - 1000) : k === 3 ? iso(NOW + 1) : k === 4 ? null : k === 5 ? '' : k === 6 ? ' ' : k === 7 ? iso(NOW - 1000) : k === 8 ? '2027-02-30T00:00:00Z' : iso(NOW + 1000);
      const end = k < 3 ? iso(NOW + 1) : k === 3 ? iso(NOW + 2000) : k === 4 ? iso(NOW + 1000) : k === 5 ? iso(NOW - 1) : k === 7 ? null : k === 9 ? '2026-10-22T10:00:00+23:00' : 'bad';
      const d = row(i, start, end, i % 37 === 0 ? 1 : 0);
      if (i % 100 === 0) d.price = null; // all-null active model
      if (i % 100 === 1) d.price = 0;
      fixture.push(d);
    }
    fixture.push({ ...row(100800, iso(NOW - 1), iso(NOW + 1)), model_id: null, status: 'published' });
    insert(memory, fixture);
    // The fixture starts with no data in migrations and remains referentially valid.
    expect(await all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(await db.prepare('PRAGMA integrity_check').first()).toEqual({ integrity_check: 'ok' });
  }, 120000);
  beforeEach(() => { reads.length = 0; context.db = db; });
  afterAll(() => memory.close());

  test('complete chronological and lifecycle traversal matches independent order exactly once', async () => {
    for (const surface of ['api-deals', 'page-deals'] as const) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const options = opts(surface, 50, cursor);
        const page = surface === 'page-deals' ? await lifecycleDeals(db, options, NOW) : await chronologicalDeals(db, options);
        expect(page.data.length).toBeLessThanOrEqual(50);
        ids.push(...page.data.map(d => d.id)); cursor = page.next_cursor;
      } while (cursor);
      const expected = (surface === 'page-deals' ? reference(fixture) : chronologicalReference(fixture)).map(d => d.id);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // Every candidate transfer is bounded, including deep and mixed-stream pages.
    for (const read of reads) {
      if (read.sql.includes('LIMIT ?')) expect(read.count).toBeLessThanOrEqual(Number(read.values.at(-1)));
      if (read.sql.includes('id IN (')) expect(read.count).toBeLessThanOrEqual(50);
    }
    expect(sortDeals(fixture.filter(eligible), NOW).map(d => d.id)).toEqual(reference(fixture, NOW, false).map(d => d.id));
  });

  test('model histories at limits 1/20/50 retain ties, current price and zero-filled summaries', async () => {
    for (const limit of [1, 20, 50]) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: Deal[]; next_cursor: string | null } = await chronologicalDeals(db, opts('api-model', limit, cursor, 'm1'));
        ids.push(...page.data.map(d => d.id)); cursor = page.next_cursor;
      } while (cursor);
      expect(ids).toEqual(chronologicalReference(fixture.filter(d => d.model_id === 'm1')).map(d => d.id));
    }
    const summaries = await modelDealSummaries(db, [...modelIds, 'missing'], NOW);
    for (const id of [...modelIds, 'missing']) {
      const active = fixture.filter(d => eligible(d) && d.model_id === id && dealTimingFor(d, NOW).state === 'active');
      const prices = active.flatMap(d => d.price !== null && d.price >= 0 ? [d.price] : []);
      expect(summaries.get(id)).toEqual({ model_id: id, active_count: active.length, lowest_price: prices.length ? Math.min(...prices) : null });
    }
    expect(summaries.get('model-1')).toMatchObject({ active_count: expect.any(Number), lowest_price: null });
    expect(summaries.get('m1')?.lowest_price).toBe(0);
    expect(summaries.get('missing')).toMatchObject({ active_count: 0, lowest_price: null });
    expect(await activeDealCount(db, NOW)).toBe(fixture.filter(d => eligible(d) && dealTimingFor(d, NOW).state === 'active').length);
    const preview = await activeDealPreview(db, NOW);
    expect(preview.map(d => d.id)).toEqual(reference(fixture).filter(d => dealTimingFor(d, NOW).state === 'active').slice(0, 12).map(d => d.id));
    const summariesReads = reads.filter(r => r.sql.includes('GROUP BY model_id'));
    expect(summariesReads).toHaveLength(2);
    for (const r of summariesReads) { expect(r.values.length).toBeLessThanOrEqual(82); expect(r.count).toBeLessThanOrEqual(r.values.length - 2); }
    expect(reads.find(r => r.sql.includes('COUNT(*) AS count'))?.count).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const payload = await (await api(db)('models/m1?limit=1')).json<{ data: { comparison: { current: unknown; gonggu: Deal[] } }; next_cursor: string }>();
    expect(payload.data.comparison.gonggu).toHaveLength(1);
    expect(payload.data.comparison.current).toEqual({ active_count: summaries.get('m1')!.active_count, lowest_price: 0 });
    expect(payload.next_cursor).toBeTypeOf('string');
  });

  test('first and deep pages use the eligible query indexes without temporary sorts', async () => {
    await chronologicalDeals(db, opts('api-deals'));
    const first = await chronologicalDeals(db, opts('api-model', 20, null, 'm1'));
    await chronologicalDeals(db, opts('api-model', 20, first.next_cursor, 'm1'));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const [phase, key] of [['active', iso(NOW + 1)], ['upcoming', iso(NOW + 1)], ['ended', '2021-01-01T00:00:00.000Z'], ['unknown', iso(NOW + 1)]] as const) {
      for (const anchor of [null, encode([2, 'page-deals', 'discount', null, phase, key, 'd050000', iso(NOW), phase === 'active' ? -90 : null])]) await lifecycleDeals(db, opts('page-deals', 20, anchor), NOW);
    }
    const page = await chronologicalDeals(db, opts('api-deals', 20));
    await chronologicalDeals(db, opts('api-deals', 20, page.next_cursor));
    await modelDealSummaries(db, modelIds, NOW); await activeDealCount(db, NOW);
    expect(await activeDealPreview(db, Date.parse('2100-01-01T00:00:00Z'))).toEqual([]);
    const onePageStart = reads.length;
    await lifecycleDeals(db, opts('page-deals', 50, encode([2, 'page-deals', 'discount', null, 'ended', '1900-01-01T00:00:00.000Z', '!', iso(NOW), null])), NOW);
    expect(reads.slice(onePageStart).filter(r => r.sql.includes('LIMIT ?')).reduce((n, r) => n + r.count, 0)).toBeLessThanOrEqual(8 * 51);
    const queries = [...new Map(reads.filter(r => r.sql.includes('INDEXED BY')).map(r => [r.sql, r])).values()];
    const indexes = new Set<string>();
    for (const q of queries) {
      const plan = await all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${q.sql}`, ...q.values as (string | number)[]);
      const detail = plan.map(p => p.detail).join('\n');
      const name = /INDEXED BY (\w+)/.exec(q.sql)![1]; indexes.add(name);
      expect(detail).toContain(name);
      expect(detail).not.toMatch(/TEMP B-TREE/);
      if (q.sql.includes('id > ?') || q.sql.includes('COUNT(')) expect(detail).toMatch(/SEARCH/);
      if (name === 'verified_deal_discount') {
        expect(detail).toMatch(/SEARCH deals USING INDEX verified_deal_discount \(<expr>=\? AND (?:ends_at|\(ends_at,id\))>\?\)/);
      }
    }
    for (const name of ['chronology', 'model_chronology', 'discount', 'ending', 'model_active', 'upcoming', 'ended', 'end_only_ended', 'end_only_unknown', 'closed', 'unknown']) expect(indexes.has(`verified_deal_${name}`)).toBe(true);
  });

  test('actual next links retain their ranking clock and count', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const html = renderToStaticMarkup(await DealsPage({ searchParams: Promise.resolve({ limit: '1' }) }));
    const href = /href="(\/deals\?[^\"]*cursor=[^\"]+)"/.exec(html)![1].replaceAll('&amp;', '&');
    const params = Object.fromEntries(new URL(href, 'http://localhost').searchParams);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 2);
    const continued = renderToStaticMarkup(await DealsPage({ searchParams: Promise.resolve(params) }));
    expect(continued).toContain(`dateTime="${iso(NOW)}"`);
    expect(continued).toContain('2026.10.21 23:59');
    // The cursor keeps its ranking clock, but the header count and expiry timer
    // follow the current request instead of the cursor reference time.
    expect(continued).toContain(`aria-label="${await activeDealCount(db, NOW + 2)}개 진행 중이에요"`);
    expect(continued).toContain('/deals?limit=1');
    const restarted = renderToStaticMarkup(await DealsPage({ searchParams: Promise.resolve({ limit: '1' }) }));
    expect(restarted).toContain(`dateTime="${iso(NOW + 2)}"`);
    expect(restarted).toContain('2026.10.22 00:00');
    expect(restarted).toContain(`aria-label="${await activeDealCount(db, NOW + 2)}개 진행 중이에요"`);
    const home = renderToStaticMarkup(await Home());
    expect((home.match(/class="deal-card"/g) ?? []).length).toBeLessThanOrEqual(12);
    expect(home).toContain(`aria-label="${await activeDealCount(db, NOW + 2)}개 진행 중이에요"`);
    for (const render of [
      () => Calendar({ searchParams: Promise.resolve({ limit: '1' }) }),
      () => ModelDetail({ params: Promise.resolve({ id: 'm1' }), searchParams: Promise.resolve({ limit: '1' }) }),
    ]) {
      const first = renderToStaticMarkup(await render());
      expect(first).toContain('cursor='); expect(first).toContain('limit=1'); expect(first).toContain(dealsCopy.ad);
    }
  });

  test('withdrawn/deleted anchors survive; public projections and failures remain explicit', async () => {
    await db.prepare('SAVEPOINT changes').run();
    try {
      const page = await chronologicalDeals(db, opts('api-deals', 1));
      const anchor = page.data[0].id;
      const expectedNext = (await chronologicalDeals(db, opts('api-deals', 1, page.next_cursor))).data[0].id;
      await db.prepare("UPDATE deals SET status = 'withdrawn' WHERE id = ?").bind(anchor).run();
      expect((await chronologicalDeals(db, opts('api-deals', 1, page.next_cursor))).data[0].id).toBe(expectedNext);
      await db.prepare('DELETE FROM deals WHERE id = ?').bind(anchor).run();
      expect((await chronologicalDeals(db, opts('api-deals', 1, page.next_cursor))).data[0].id).toBe(expectedNext);
      const expectedKeys = ['id','model_id','seller_id','title','price','source_url','image_url','verify_level','checked','starts_at','ends_at','origin','source_host','source_ended','brand_label','category_label','deal_price_krw','list_price_krw','discount_pct','price_source_url','list_price_source_url','price_checked_at','advertisement','notice','orders_open'].sort();
      const response = await api(db)('deals?limit=1');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const payload = await response.json<{ data: Deal[]; next_cursor: string }>();
      expect(Object.keys(payload.data[0]).sort()).toEqual(expectedKeys);
      const calendar = await (await api(db)('calendar?limit=1')).json<{ data: Deal[] }>();
      expect(Object.keys(calendar.data[0]).sort()).toEqual(expectedKeys);
      const model = await (await api(db)('models/m1?limit=1')).json<{ data: { comparison: { gonggu: Deal[] } } }>();
      expect(Object.keys(model.data.comparison.gonggu[0]).sort()).toEqual(expectedKeys.filter(k => k !== 'notice'));
      // Corrections/inserts may change later traversal, but the encoded boundary
      // still works without consulting its deleted anchor.
      await db.prepare("UPDATE deals SET starts_at = NULL WHERE id = ?").bind(expectedNext).run();
      expect((await chronologicalDeals(db, opts('api-deals', 1, page.next_cursor))).data[0].id).not.toBe(anchor);
      const extra = { ...row(900000, '2028-01-01T00:00:00Z', '2028-02-01T00:00:00Z'), price: 300000, model_id: 'model-1', status: 'published' };
      insert(memory, [extra]);
      const nearEnd = Buffer.from(JSON.stringify([1, 'api-deals', 'chronological', null, 'start', '2027-12-31', '!', null])).toString('base64url');
      expect((await chronologicalDeals(db, opts('api-deals', 20, nearEnd))).data.map(d => d.id)).toContain(extra.id);
      const failing = { prepare: () => { throw new Error('D1 unavailable'); } } as unknown as D1Database;
      for (const fn of [() => chronologicalDeals(failing, opts('api-deals')), () => lifecycleDeals(failing, opts('page-deals'), NOW), () => activeDealCount(failing, NOW), () => modelDealSummaries(failing, ['m1'], NOW), () => activeDealPreview(failing, NOW)]) await expect(fn()).rejects.toThrow('D1 unavailable');
      const last = Buffer.from(JSON.stringify([1, 'page-calendar', 'chronological', null, 'start', 'zzzz', 'zzzz', null])).toString('base64url');
      const empty = renderToStaticMarkup(await Calendar({ searchParams: Promise.resolve({ cursor: last }) }));
      expect(empty).toContain(dealsCopy.emptyPosition); expect(empty).toContain(dealsCopy.restart);
    } finally { await db.prepare('ROLLBACK TO changes').run(); await db.prepare('RELEASE changes').run(); }
  });
});

describe('public page boundary and cursor contracts', () => {
  test('SQL timestamp normalization matches strict JavaScript calendar/offset/fraction rules', async () => {
    const memory = memoryD1();
    try {
      const timestamps = [null, '', ' ', '\n', 'bad',
        '2026-10-21T15:00:00Z', '2026-10-22T00:00:00+09:00', '2026-10-21T15:00:00Z\u0000tail',
        '2024-02-29T00:00:00Z', '2023-02-29T00:00:00Z', '2024-02-30T00:00:00Z',
        '2000-02-29T00:00:00.1Z', '1900-02-29T00:00:00Z',
        '0000-02-29T00:00:00Z', '0000-01-01T00:00:00+00:01', '9999-12-31T23:59:59-00:01',
        '2026-01-01T23:59:59.12-23:59', '2026-01-01T23:59:59.123+23:59',
        '2026-01-01T24:00:00Z', '2026-01-01T12:60:00Z', '2026-01-01T12:00:60Z',
        '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+01:60',
        '2026-01-01T00:00:00.Z', '2026-01-01T00:00:00.1234Z', '2026-01-01 00:00:00Z',
        '2026-01-01T00:00:00Ztail', '2026-13-01T00:00:00Z', '2026-00-01T00:00:00Z',
        '2026-01-00T00:00:00Z', '2026-04-31T00:00:00Z', '2026-01-01T00:00:00',
      ];
      await memory.db.prepare('CREATE TABLE times (raw TEXT)').run();
      memory.bulk('INSERT INTO times VALUES (?)', timestamps.map(t => [t]));
      const normalized = await all<{ raw: string | null; normalized: string | null }>(memory.db, `SELECT raw, ${timestampSql('raw')} AS normalized FROM times`);
      for (const [i, result] of normalized.entries()) expect(result.normalized, JSON.stringify(timestamps[i])).toBe(normalizeTimestamp(timestamps[i]));
    } finally { memory.close(); }
  });

  test('timing aggregation/lifecycle parity at ±1ms, equal instants, KST midnight and incomplete schedules', async () => {
    const memory = memoryD1();
    try {
      await migrate(memory.db);
      await seedFixtureAuthority(memory.db);
      const start = '2024-02-29T23:59:59.999+09:00', end = '2024-03-01T00:00:00.001+09:00';
      const rows = [
        row(1, start, end), row(2, start, '2024-02-29T14:59:59.999Z'), // equal instant, stored end > start
        row(3, '', end), row(4, null, end), row(5, ' ', end),
        row(6, start, null), row(7, start, 'z-invalid'), row(8, null, 'bad'), row(9, 'bad', 'z-bad'),
        row(10, start, '2024-03-01T00:00:00+23:00'), // reversed instants
        row(11, 'bad', 'z-bad', 1), row(12, null, null, 1), row(13, start, end, 1),
      ].map(d => ({ ...d, model_id: 'model-1', status: 'published' }));
      // Equal UTC instants use two offset forms whose stored strings still satisfy the legacy CHECK.
      rows[1].starts_at = '2024-02-29T14:59:59.999Z'; rows[1].ends_at = start;
      insert(memory, rows);
      const s = Date.parse(start), e = Date.parse(end);
      for (const now of [s - 1, s, s + 1, e - 1, e, e + 1]) {
        const ids: string[] = []; let cursor: string | null = null;
        do { const p: Awaited<ReturnType<typeof lifecycleDeals>> = await lifecycleDeals(memory.db, opts('page-deals', 1, cursor), now); ids.push(...p.data.map(d => d.id)); cursor = p.next_cursor; } while (cursor);
        expect(ids).toEqual(reference(rows, now).map(d => d.id));
        const active = rows.filter(d => eligible(d) && dealTimingFor(d, now).state === 'active');
        expect(await activeDealCount(memory.db, now)).toBe(active.length);
        expect((await modelDealSummaries(memory.db, ['model-1'], now)).get('model-1')?.active_count).toBe(active.length);
      }
    } finally { memory.close(); }
  });

  test('null partition fills the same page; empty/malformed stored timestamps survive cursors and ties', async () => {
    const memory = memoryD1();
    try {
      await migrate(memory.db);
      await seedFixtureAuthority(memory.db);
      const rows = [null, null, null, '', '', ' ', 'bad', 'bad', '2026-10-20T00:00:00Z'].map((s, i) => ({ ...row(i + 1, s, '2026-10-25T00:00:00Z'), price: 100000, model_id: 'model-1', status: 'published' }));
      insert(memory, rows);
      for (const surface of ['api-deals', 'api-calendar', 'api-model', 'page-calendar', 'page-model'] as const) {
        const ids: string[] = []; let cursor: string | null = null;
        do {
          const p: { data: Deal[]; next_cursor: string | null } = await chronologicalDeals(memory.db, opts(surface, 2, cursor, surface.endsWith('model') ? 'model-1' : null));
          ids.push(...p.data.map(d => d.id)); cursor = p.next_cursor;
        } while (cursor);
        expect(ids).toEqual(chronologicalReference(rows).map(d => d.id));
      }
    } finally { memory.close(); }
  });

  test('empty, singleton, exact multiples and partial finals at limits 1/20/50', async () => {
    const memory = memoryD1();
    try {
      await migrate(memory.db);
      await seedFixtureAuthority(memory.db);
      for (const size of [0, 1, 20, 40, 50, 51, 100]) {
        await memory.db.prepare('SAVEPOINT boundary').run();
        try {
          insert(memory, Array.from({ length: size }, (_, i) => ({ ...row(i + 1, '2026-10-20T00:00:00Z', '2026-10-23T00:00:00Z'), price: 100000, model_id: 'model-1', status: 'published' })));
          for (const limit of [1, 20, 50]) for (const surface of ['api-calendar', 'page-deals'] as const) {
            const ids: string[] = []; let cursor: string | null = null;
            do {
              const p: { data: Deal[]; next_cursor: string | null } = surface === 'page-deals' ? await lifecycleDeals(memory.db, opts(surface, limit, cursor), NOW) : await chronologicalDeals(memory.db, opts(surface, limit, cursor));
              const expectedSize = Math.min(limit, size - ids.length);
              expect(p.data).toHaveLength(expectedSize); ids.push(...p.data.map(d => d.id)); cursor = p.next_cursor;
              expect(cursor === null).toBe(ids.length === size);
            } while (cursor);
            expect(new Set(ids).size).toBe(size);
          }
        } finally { await memory.db.prepare('ROLLBACK TO boundary').run(); await memory.db.prepare('RELEASE boundary').run(); }
      }
    } finally { memory.close(); }
  });

  test('invalid/duplicate/empty/out-of-range cursors and limits are rejected before D1 on every endpoint', async () => {
    const db = { prepare: vi.fn(() => { throw new Error('unexpected D1'); }) } as unknown as D1Database;
    const call = api(db);
    const token = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const good = [1, 'api-deals', 'chronological', null, 'start', '', 'anchor', null];
    const badTokens = [
      '', '!', 'a'.repeat(2049), token({}), token([...good, null]), token([2, ...good.slice(1)]),
      token([1, 'page-calendar', ...good.slice(2)]), token([1, 'api-deals', 'lifecycle', null, 'active', iso(NOW), 'anchor', iso(NOW)]),
      token([1, 'api-deals', 'chronological', 'wrong-model', 'start', '', 'anchor', null]),
      token([1, 'api-deals', 'chronological', null, 'null', '', 'anchor', null]),
      token([1, 'api-deals', 'chronological', null, 'start', 'x'.repeat(257), 'anchor', null]),
      token([1, 'api-deals', 'chronological', null, 'start', '', '', null]),
      token([1, 'api-deals', 'chronological', null, 'start', '', 'anchor', iso(NOW)]),
      token(good) + '=', Buffer.from(JSON.stringify(good) + ' ').toString('base64url'), Buffer.from([0xff]).toString('base64url'),
    ];
    for (const path of ['deals', 'calendar', 'models/model-1']) {
      for (const limit of ['', '0', '51', '-1', '1.0', '01', 'NaN', 'Infinity', '1&limit=2']) {
        const r = await call(`${path}?limit=${limit}`); expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'invalid_limit' }); expect(r.headers.get('cache-control')).toBe('no-store');
      }
      for (const cursor of badTokens) { const r = await call(`${path}?cursor=${encodeURIComponent(cursor)}`); expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'invalid_cursor' }); }
      expect((await call(`${path}?cursor=x&cursor=x`)).status).toBe(400);
    }
    for (const cursor of [
      [1, 'page-deals', 'lifecycle', null, 'active', null, 'id', iso(NOW)],
      [1, 'page-deals', 'lifecycle', null, 'unknown', iso(NOW), 'id', iso(NOW)],
      [1, 'page-deals', 'lifecycle', null, 'active', iso(NOW), 'id', '2026-10-21T00:00:00Z'],
      [1, 'page-deals', 'lifecycle', null, 'null', null, 'id', iso(NOW)],
    ]) expect(() => publicDealOptions(new URLSearchParams({ cursor: token(cursor) }), 'page-deals')).toThrow('invalid_cursor');
    expect(() => publicDealOptions(publicPageParams({ limit: ['1', '2'] }), 'page-calendar')).toThrow('invalid_limit');
    expect(publicDealOptions(new URLSearchParams(), 'api-deals').limit).toBe(20);
    const unicode = [1, 'api-deals', 'chronological', null, 'start', '잘못된 시각', '공구-1', null];
    expect(publicDealOptions(new URLSearchParams({ cursor: token(unicode) }), 'api-deals').cursor).toEqual(unicode);
    expect(db.prepare).not.toHaveBeenCalled();
    context.db = db;
    for (const render of [() => DealsPage({ searchParams: Promise.resolve({ limit: '0' }) }), () => Calendar({ searchParams: Promise.resolve({ cursor: '' }) }), () => ModelDetail({ params: Promise.resolve({ id: 'model-1' }), searchParams: Promise.resolve({ limit: ['1', '2'] }) })]) {
      const html = renderToStaticMarkup(await render()); expect(html).toContain(dealsCopy.invalidPage); expect(html).toContain(dealsCopy.restart);
    }
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('unsuccessful D1 results cannot become empty histories or zero summaries', async () => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ success: false, results: [] }), first: async () => null }) }) } as unknown as D1Database;
    for (const read of [
      () => chronologicalDeals(db, opts('api-deals')),
      () => lifecycleDeals(db, opts('page-deals'), NOW),
      () => modelDealSummaries(db, ['model-1'], NOW),
      () => activeDealPreview(db, NOW),
    ]) await expect(read()).rejects.toThrow('Public deal query failed');
    await expect(activeDealCount(db, NOW)).rejects.toThrow('active count unavailable');
  });

  test('migration is expression-identical, additive and preserves records and existing indexes', async () => {
    expect(await readFile(new URL('../migrations/0014_public_deal_queries.sql', import.meta.url), 'utf8')).toBe(publicDealMigration);
    for (const [, pattern] of publicDealMigration.matchAll(/GLOB '([^']*)'/g)) expect(pattern.length).toBeLessThanOrEqual(50);
    const memory = memoryD1();
    try {
      await migrate(memory.db, '0013');
      await legacy(memory.db, 'migration-fixture', '2019-01-01T00:00:00Z', 'malformed');
      const before = await all(memory.db, 'SELECT * FROM deals');
      const indexes = await all<{ name: string }>(memory.db, "SELECT name FROM sqlite_master WHERE type = 'index'");
      for (const statement of publicDealMigration.split(';').filter(s => s.trim())) await memory.db.prepare(statement).run();
      expect(await all(memory.db, 'SELECT * FROM deals')).toEqual(before);
      const after = await all<{ name: string }>(memory.db, "SELECT name FROM sqlite_master WHERE type = 'index'");
      for (const index of indexes) expect(after).toContainEqual(index);
      expect(await all(memory.db, 'PRAGMA foreign_key_check')).toEqual([]);
    } finally { memory.close(); }
  });
});

// Python's progress handler counts SQLite VM instructions. Node's SQLite API has
// no progress handler. Use a separate offline database to measure empty/sparse
// unknown probes as expired history grows, including expired end-only schedules.
test('unknown access work excludes 10k/100k complete and expired end-only history', { timeout: 120000 }, () => {
  const script = String.raw`
import json, sqlite3, sys
migration = sys.stdin.read()
results = []
for size in [10000, 100000]:
  db = sqlite3.connect(':memory:')
  db.executescript("CREATE TABLE deals (id TEXT PRIMARY KEY, model_id TEXT, price INTEGER, status TEXT, starts_at TEXT, ends_at TEXT, source_ended INTEGER);")
  db.executescript(migration)
  db.executemany("INSERT INTO deals VALUES (?, 'm', 1, 'published', ?, '2020-01-02T00:00:00Z', 0)", ((str(i), None if i % 2 else '2020-01-01T00:00:00Z') for i in range(size)))
  for sparse in [False, True]:
    if sparse: db.execute("INSERT INTO deals VALUES ('unknown', 'm', NULL, 'published', NULL, NULL, 0)")
    for deep in [False, True]:
      count = [0]
      db.set_progress_handler(lambda: count.__setitem__(0, count[0] + 1) or 0, 1)
      for name, pred, key, extra in json.loads(sys.argv[1]):
        query = 'SELECT id FROM deals INDEXED BY ' + name + ' WHERE ' + pred + ' AND ' + extra + (' AND id > ?' if deep else '') + ' ORDER BY id LIMIT 21'
        db.execute(query, (['a'] if deep else [])).fetchall()
      db.set_progress_handler(None, 0)
      results.append(count[0])
print(json.dumps(results))
`;
  // Same exact static predicates/expressions as production queries.
  const getPredicates = /CREATE INDEX public_deal_(permanent_unknown|start_only|end_only_unknown) ON deals \([\s\S]*?\) WHERE ([\s\S]*?);/g;
  const definitions = [...publicDealMigration.matchAll(getPredicates)].map(m => {
    const name = m[1];
    return [`public_deal_${name}`, m[2], '', name === 'permanent_unknown' ? '1' : `${timestampSql(name === 'start_only' ? 'starts_at' : 'ends_at')} ${name === 'start_only' ? '<=' : '>='} '2026-10-21T14:59:59.999Z'`];
  });
  expect(definitions).toHaveLength(3);
  const steps: number[] = JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(definitions)], { input: publicDealMigration, encoding: 'utf8', timeout: 110000 }));
  for (let i = 0; i < 4; i++) expect(steps[i + 4]).toBeLessThanOrEqual(steps[i] + 10);
});
