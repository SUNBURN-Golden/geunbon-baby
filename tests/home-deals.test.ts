import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Home from '../app/page';
import DealsPage from '../app/deals/page';
import Calendar from '../app/calendar/page';
import ModelDetail from '../app/models/[id]/page';
import { DealCard } from '../app/deals/_components';
import { homeCopy } from '../lib/copy/home.ko';
import { dealSelect, type DealWithContext } from '../lib/deals';
import { homeDeals } from '../lib/home-deals';
import { memoryD1 } from './helpers/sqlite';
import { api, legacy, migrate } from './helpers/deal-timestamps';
import { fixtureScope, seedPublicPrice } from './helpers/public-deal-fixture';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async original => ({
  ...await original<typeof import('../lib/db')>(), environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

const now = Date.parse('2026-10-21T03:00:00.000Z');
const midnight = Date.parse('2026-10-21T15:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const day = 86_400_000;
const noFilters = { category: null, brand: null };
const memory = memoryD1();
const db = memory.db;

async function deal(id: string, end: number, price: number, start: number | null = now - day, model = 'model-1') {
  await legacy(db, id, start === null ? '' : iso(start), iso(end));
  await db.prepare('UPDATE deals SET starts_at=?,model_id=? WHERE id=?').bind(start === null ? null : iso(start), model, id).run();
  await seedPublicPrice(db, id, price, 500_000);
}
function ids(inventory: Awaited<ReturnType<typeof homeDeals>>) {
  return inventory.sections.map(section => section.deals.map(offer => offer.id));
}

beforeAll(async () => {
  context.db = db;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await migrate(db);
  await db.prepare("INSERT INTO models VALUES ('stroller','Roll','Stroller','stroller','Importer',NULL,'https://fixture.example','2026-01-01','manual','')").run();
  await deal('deadline', now, 390_000);
  await deal('tie-a', now + 60_000, 350_000);
  await deal('tie-b', now + 60_000, 350_000);
  await deal('midnight', midnight, 350_000);
  await deal('zero', midnight + 1_000, 0);
  await deal('open-no-start', midnight + 2_000, 400_000, null);
  await db.prepare("UPDATE deals SET orders_open=1 WHERE id='open-no-start'").run();
  await deal('unknown-start', midnight + 2_000, 100, null);
  await deal('sub-percent', midnight + 2_000, 499_999);
  await deal('stale-proof', midnight + 2_000, 100);
  await db.prepare("UPDATE deals SET price_checked_at=? WHERE id='stale-proof'").bind(iso(now - day)).run();
  await db.prepare("UPDATE deal_price_evidence SET body=json_set(body,'$.official.source.observed_at',?) WHERE id='fixture-stale-proof'").bind(iso(now - day)).run();
  await legacy(db, 'missing-price', iso(now - day), iso(midnight));
  await legacy(db, 'missing-deadline', iso(now - day), 'invalid');
  await db.prepare("UPDATE deals SET image_url='https://cdninstagram.com/chair.jpg?sig=synthetic%2B&x=1' WHERE id='deadline'").run();
});
afterAll(() => memory.close());
afterEach(() => { vi.restoreAllMocks(); context.db = db; });

test('counts the full verified inventory, ranks ties, and keeps deadlines inclusive at KST midnight', async () => {
  const inventory = await homeDeals(db, now, noFilters);
  expect(inventory).toMatchObject({ count: 6, maximum: 100, nextRefreshAt: iso(now + 1) });
  expect(ids(inventory)).toEqual([['deadline', 'tie-a', 'tie-b'], [], ['zero', 'tie-a', 'tie-b'], []]);
  expect((await homeDeals(db, now + 1, noFilters)).count).toBe(5);
  expect(ids(await homeDeals(db, midnight - 1, noFilters))[0]).toEqual([]);
  expect(ids(await homeDeals(db, midnight, noFilters))[0]).toEqual(['midnight', 'zero', 'open-no-start']);
  expect((await homeDeals(db, midnight + 1, noFilters)).count).toBe(2);
  expect((await homeDeals(db, now, noFilters)).categories.map(facet => facet.value)).toEqual(Object.keys(homeCopy.categories));
});

test('filters match one bundle component and count distinct deals behind other chips', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await db.prepare('SAVEPOINT bundles').run();
  try {
    await deal('bundle', now + 750, 300_000);
    await db.prepare(`INSERT INTO deal_bundle_items(id,deal_id,position,brand,product_name,model_id) VALUES
      ('b1','bundle',0,NULL,'Chair','model-1'),('b2','bundle',1,NULL,'Stroller','stroller'),
      ('b3','bundle',2,NULL,'Second stroller','stroller'),('b4','bundle',3,'Independent','Unmatched',NULL)`).run();
    const mismatch = await homeDeals(db, now, { category: 'high_chair', brand: 'Roll' });
    expect(mismatch.count).toBe(0);
    expect(mismatch.categories.find(f => f.value === 'stroller')?.count).toBe(1);
    expect(mismatch.brands.find(f => f.value === 'Test brand')?.count).toBe(7);
    expect((await homeDeals(db, now, { category: null, brand: 'Independent' })).count).toBe(1);
    expect((await homeDeals(db, now, { category: 'high_chair', brand: 'Independent' })).count).toBe(0);
    expect((await homeDeals(db, now + 1, { category: 'play_gym', brand: null })).nextRefreshAt).toBe(iso(now + 751));
  } finally { await db.prepare('ROLLBACK TO bundles').run(); await db.prepare('RELEASE bundles').run(); }
});

test('withdrawn and unapproved deals never reach the home snapshot or rendered page', async () => {
  await db.prepare('SAVEPOINT lifecycle').run();
  try {
    const before = await homeDeals(db, now, noFilters);
    await db.prepare("UPDATE deals SET status = 'withdrawn' WHERE id = 'tie-a'").run();
    await db.prepare("UPDATE ingested_items SET status = 'rejected' WHERE id = 'tie-b'").run();
    const after = await homeDeals(db, now, noFilters);
    expect(after.count).toBe(before.count - 2);
    expect(ids(after).flat()).not.toContain('tie-a');
    expect(ids(after).flat()).not.toContain('tie-b');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(await Home());
    expect(html).not.toContain('/deals/tie-a');
    expect(html).not.toContain('/deals/tie-b');
  } finally { await db.prepare('ROLLBACK TO lifecycle').run(); await db.prepare('RELEASE lifecycle').run(); }
});

test('placeholder sellers keep the listing label and trust anchor without shared evidence or rounds', async () => {
  await db.prepare('SAVEPOINT placeholder').run();
  try {
    await db.prepare(`INSERT INTO sellers (id,name,source_url,registration_source)
      VALUES ('ext-fixture-unknown','Shared seller','https://fixture.example/shared','https://fixture.example/registration')`).run();
    await deal('placeholder', now + 500, 300_000);
    await db.prepare("UPDATE deals SET seller_id='ext-fixture-unknown',published_seller_label='Listing seller' WHERE id='placeholder'").run();
    const row = (await db.prepare(dealSelect(now) + " AND d.id = 'placeholder'").first<DealWithContext>())!;
    expect(row).toMatchObject({
      seller_joined_id: 'ext-fixture-unknown',
      seller_name: 'Listing seller',
      seller_registration_source: null,
      seller_withdrawal_source: null,
      seller_official_import_source: null,
      seller_round_number: null,
    });
    const html = renderToStaticMarkup(createElement(DealCard, { deal: row, nowMs: now }));
    expect(html).toContain('Listing seller');
    expect(html).toContain('href="/sellers#trust-ext-fixture-unknown"');
    expect(html).not.toContain('Shared seller');
    expect(html).not.toContain('공구 1회째');
    const regular = (await db.prepare(dealSelect(now) + " AND d.id = 'deadline'").first<DealWithContext>())!;
    expect(regular).toMatchObject({ seller_joined_id: 'seller-1', seller_name: 'Test seller' });
  } finally { await db.prepare('ROLLBACK TO placeholder').run(); await db.prepare('RELEASE placeholder').run(); }
});

test('approval and proof expiries are absolute boundaries, including behind alternate filters', async () => {
  await db.prepare('SAVEPOINT expiries').run();
  try {
    await db.prepare('UPDATE official_price_approvals SET scopes=?').bind(JSON.stringify([{ ...fixtureScope, expires_at: iso(now + 3) }])).run();
    expect((await homeDeals(db, now + 1, { category: 'play_gym', brand: null })).nextRefreshAt).toBe(iso(now + 3));
    expect((await homeDeals(db, now + 3, noFilters)).count).toBe(0);
    await db.prepare('UPDATE official_price_approvals SET scopes=?').bind(JSON.stringify([fixtureScope])).run();
    await db.prepare("UPDATE deals SET price_checked_at=? WHERE id='zero'").bind(iso(now - day + 10)).run();
    await db.prepare("UPDATE deal_price_evidence SET body=json_set(body,'$.official.source.observed_at',?) WHERE id='fixture-zero'").bind(iso(now - day + 10)).run();
    expect((await homeDeals(db, now + 1, noFilters)).nextRefreshAt).toBe(iso(now + 10));
    expect((await homeDeals(db, now + 10, noFilters)).maximum).toBe(30);
  } finally { await db.prepare('ROLLBACK TO expiries').run(); await db.prepare('RELEASE expiries').run(); }
});

test('home, deal list, calendar and model detail use identical shared cards', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const pages = [await Home(), await DealsPage(), await Calendar(), await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) })];
  const cards = pages.map(page => (renderToStaticMarkup(page).match(/<article class="deal-card">[\s\S]*?<\/article>/g) ?? []).find(card => card.includes('href="/deals/deadline"')));
  expect(cards.every(Boolean)).toBe(true);
  expect(new Set(cards).size).toBe(1);
  expect(cards[0]).toContain('<del>500,000원</del>');
  expect(cards[0]).toContain('정가보다 22% 싸요');
  expect(cards[0]).toContain('공구 바로가기');
  expect(cards[0]).toContain('referrerPolicy="no-referrer"');
  const home = renderToStaticMarkup(pages[0]);
  expect(home).toContain(homeCopy.active(6));
  expect(home).toContain(homeCopy.maxSaving(100));
  expect(home).toContain('0<span>원</span>');
  expect(home.indexOf('data-home-section="discount"')).toBeLessThan(home.indexOf('data-home-section="low"'));
});

test.each([null, '', 'http://cdninstagram.com/chair.jpg', 'https://example.com/chair.jpg', 'javascript:alert(1)'])
('reserves the shared media slot with missing or disallowed image %s', async image_url => {
  const base = (await db.prepare(dealSelect(now) + " AND d.id='deadline'").first<DealWithContext>())!;
  const html = renderToStaticMarkup(createElement(DealCard, { deal: { ...base, image_url }, nowMs: now }));
  expect(html).toContain('class="deal-card-media"');
  expect(html).not.toContain('<img');
});

test('successful empty home has four sections and a catalog link; D1 failure propagates', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now + 10 * day);
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain(homeCopy.active(0));
  expect(html).toContain('class="home-catalog" href="/models"');
  expect(html).not.toContain('home-saving');
  expect(html.match(/data-home-section=/g)).toHaveLength(4);
  context.db = { prepare: () => ({ bind: () => ({ all: async () => ({ success: false, results: [] }) }) }) } as unknown as D1Database;
  await expect(Home()).rejects.toThrow('Home deal query failed');
});


test('a discount beyond the earliest twelve still leads the full snapshot and survives a title correction consistently', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now + 1);
  try {
    for (let i = 0; i < 14; i++) await deal(`snapshot-${i}`, now + 20 + i, 490_000, now - day, 'stroller');
    await deal('snapshot-best', now + 90_000, 17_000, now - day, 'stroller');
    const filters = { category: 'stroller', brand: 'Roll' };
    const before = await homeDeals(db, now + 1, filters);
    expect(before).toMatchObject({ count: 15, maximum: 96, nextRefreshAt: iso(now + 21) });
    expect(ids(before)[0]).toEqual(['snapshot-0', 'snapshot-1', 'snapshot-2']);
    expect(ids(before)[2]).toEqual(['snapshot-best', 'snapshot-0', 'snapshot-1']);
    const correction = await api(db)('admin/deals/snapshot-best', { action: 'correct', expected_version: 1,
      request_id: 'qa-snapshot-correction', reason: 'Confirmed source title correction', model_id: 'stroller',
      title: 'Corrected best price', price: 17000, starts_at: iso(now - day), ends_at: iso(now + 90_000), include_image: false });
    expect(correction.status).toBe(200);
    const after = await homeDeals(db, now + 1, filters);
    expect(after).toMatchObject({ count: 15, maximum: 96 });
    expect(after.sections[2].deals[0]).toMatchObject({ id: 'snapshot-best', discount_pct: 96, title: 'Corrected best price' });
    expect(before.sections[2].deals[0].title).toBe('Fixture snapshot-best');
  } finally {
    vi.useRealTimers();
  }
});
