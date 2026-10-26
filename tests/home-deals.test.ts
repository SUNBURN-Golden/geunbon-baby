import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Home, { dynamic } from '../app/page';
import DealsPage from '../app/deals/page';
import Calendar from '../app/calendar/page';
import ModelDetail from '../app/models/[id]/page';
import { ActiveDeals } from '../app/_active-deals';
import { LedgerCard } from '../app/_ledger-card';
import { DEAL_SELECT, type DealWithContext } from '../lib/deals';
import { all } from '../lib/db';
import { dealsCopy } from '../lib/deals-copy';
import { categories } from '../lib/data';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

const nowMs = Date.parse('2026-10-21T03:00:00Z');
const memory = memoryD1();
beforeAll(async () => {
  context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = await readFile(new URL(file, dir), 'utf8');
    for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
  }
  await memory.db.prepare('PRAGMA foreign_keys = OFF').run();
  await memory.db.prepare("INSERT INTO models VALUES ('model', 'Brand', 'Chair', 'high_chair', 'Importer', 500000, 'https://example.com/model', '2026-10-20', 'page_body', '')").run();
  // Deliberately insert in an order different from the required closing order.
  for (const [id, start, end] of [
    ['later', '2026-10-20T00:00:00Z', '2026-10-25T00:00:00Z'],
    ['upcoming', '2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z'],
    ['ended', '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z'],
    ['soon', '2026-10-20T00:00:00Z', '2026-10-22T00:00:00Z'],
    ['unknown', 'invalid-start', 'invalid-stop'],
    ['today', '2026-10-20T00:00:00Z', '2026-10-21T03:00:00Z'],
  ]) {
    await memory.db.prepare('INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, 'model', 'seller', `${id} deal`, 400000, 'https://example.com/deal', 'manual', '2026-10-20', start, end,
        id === 'today' ? 'https://cdninstagram.com/chair.jpg?sig=synthetic%2B&x=1' : null).run();
  }
});
afterAll(() => memory.close());
afterEach(() => vi.restoreAllMocks());

function detailLinks(html: string) {
  return [...html.matchAll(/href="\/deals\/([^"]+)"/g)].map(match => match[1]);
}

test('dynamic home queries D1 and renders hero then category tabs then active deals soonest ending first, with matching counts', async () => {
  expect(dynamic).toBe('force-dynamic');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const html = renderToStaticMarkup(await Home());
  expect(clock).toHaveBeenCalledTimes(1);
  expect(html).toMatch(/^<main><section class="hero"/);
  expect(html).toMatch(/<\/section><nav class="category-tabs" id="categories"[\s\S]*?<\/nav><section class="active-deals"/);
  expect(html).not.toContain('entry-grid');
  expect(html).toContain('class="active-deals" id="ledger"');
  expect(detailLinks(html)).toEqual(['today', 'soon', 'later']);
  for (const inactive of ['upcoming deal', 'ended deal', 'unknown deal']) expect(html).not.toContain(inactive);
  expect(html).toContain(dealsCopy.activeHeading);
  expect(html).toContain('class="active-deal-count" aria-label="3개 진행 중이에요">3</span>');
  const cards = [...html.matchAll(/<a class="ledger-card"[^>]*>([\s\S]*?)<\/a>/g)].map(match => match[1]);
  expect(cards).toHaveLength(3);
  for (const card of cards) {
    expect(card).toContain('class="ledger-name">Brand Chair</span>');
    expect(card).toContain('400,000원');
    expect(card).toContain('500,000원');
    expect(card).toContain('class="ledger-discount">-20%</span>');
    expect(card.match(/class="ledger-value"/g)).toHaveLength(2);
    expect(card).not.toContain('<a');
    expect(card).not.toContain('class="deal-card"');
    expect(card).not.toContain('<time');
    expect(card).not.toContain('cdninstagram.com');
  }
  expect(html).toContain(dealsCopy.legendOfficial);
  expect(html).toContain(dealsCopy.legendGroup);
  expect(html.indexOf('class="ledger-legend"')).toBeLessThan(html.indexOf('class="active-deal-row"'));
});

test('home category navigation has all categories from the map and the all-models link', async () => {
  const html = renderToStaticMarkup(await Home());
  const nav = html.match(/<nav class="category-tabs" id="categories" aria-label="품목">([\s\S]*?)<\/nav>/)?.[1];
  expect(nav).toBeDefined();
  const links = [...nav!.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => ({ href, label }));
  expect(links).toHaveLength(Object.keys(categories).length + 1);
  expect(links[0]).toEqual({ href: '/models', label: '전체' });
  for (const [key, label] of Object.entries(categories)) {
    expect(links.filter(link => link.href === `/models?category=${encodeURIComponent(key)}`)).toEqual([
      { href: `/models?category=${encodeURIComponent(key)}`, label },
    ]);
  }
  expect(links.slice(1).map(link => new URL(link.href, 'https://example.com').searchParams.get('category')))
    .toEqual(['stroller', 'high_chair', 'car_seat', 'carrier', 'bouncer']);
  expect(nav).not.toContain('aria-current');
});

test.each([
  [nowMs, 3],
  [Date.parse('2026-11-01T00:00:00Z'), 0],
])('hero counter uses the real active count at %s, including zero (%s)', async (requestTime, count) => {
  vi.spyOn(Date, 'now').mockReturnValue(requestTime);
  const html = renderToStaticMarkup(await Home());
  const counter = html.match(/<div class="hero-counter"[\s\S]*?<\/section>/)?.[0];
  expect(counter).toContain(`<span class="visually-hidden">오늘 열려 있는 공구 ${count}건</span>`);
  expect(counter).toContain('<span aria-hidden="true">오늘 열려 있는 공구</span>');
  expect(counter).toContain('<div class="hero-counter-total" aria-hidden="true">');
  expect(counter).not.toContain('role="img"');
  expect(counter).toContain(`<strong>${count}</strong>`);
});

test('ledger product names use joined brand and model, falling back to the deal title', async () => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'today')!;
  for (const [patch, name] of [
    [{}, 'Brand Chair'],
    [{ model_brand: null }, 'Chair'],
    [{ model_joined_id: null }, 'today deal'],
    [{ model_name: null }, 'today deal'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, ...patch } }));
    expect(html).toContain(`class="ledger-name">${name}</span>`);
    expect(html).toContain('href="/deals/today"');
  }
  const encoded = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, id: 'deal/with space' } }));
  expect(encoded).toContain('href="/deals/deal%2Fwith%20space"');
});

test('ledger uses decorative local model art and keeps an empty frame when art is unavailable', async () => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'today')!;
  const illustrated = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, model_id: 'model-1' } }));
  expect(illustrated).toContain('src="/img/models/model-1-540x540.png"');
  expect(illustrated).toContain('alt=""');
  expect(illustrated).toContain('class="ledger-name">Brand Chair</span>');
  expect(illustrated).not.toContain('cdninstagram.com');
  expect(illustrated).not.toContain('/_next/image');
  const empty = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, model_id: 'model-32' } }));
  expect(empty).toContain('<span class="ledger-stamp"></span>');
  expect(empty).not.toContain('<img');
  expect(empty).not.toContain('cdninstagram.com');
});

test('no active deals renders the zero state with an official-price link and no legend or cards', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T00:00:00Z'));
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain('class="active-deal-count" aria-label="0개 진행 중이에요">0</span>');
  expect(detailLinks(html)).toEqual([]);
  const empty = renderToStaticMarkup(createElement(ActiveDeals, { deals: [], nowMs }));
  for (const markup of [html, empty]) {
    expect(markup).toContain(`<h3>${dealsCopy.zeroTitle}</h3>`);
    expect(markup).toContain(`<p>${dealsCopy.zeroBody}</p>`);
    expect(markup).toContain(`<a class="ledger-zero-link" href="/models">${dealsCopy.zeroCta}</a>`);
    expect(markup).not.toContain('class="active-deal-row"');
    expect(markup).not.toContain('class="ledger-legend"');
    expect(markup).not.toContain('class="ledger-card"');
    expect(markup).not.toContain('class="ledger-discount"');
    expect(markup).not.toContain('class="ledger-group-price"');
  }
});

test('LedgerCard renders exactly two prices with hidden labels and a below-official badge', async () => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'soon')!;
  const html = renderToStaticMarkup(createElement(LedgerCard, { deal: base }));
  expect(html.match(/class="ledger-value"/g)).toHaveLength(2);
  expect(html).toContain('500,000원');
  expect(html).toContain('400,000원');
  expect(html).toContain(`<span class="visually-hidden">${dealsCopy.ledgerOfficial} </span>`);
  expect(html).toContain(`<span class="visually-hidden">${dealsCopy.ledgerGroup} </span>`);
  expect(html).toContain('class="ledger-discount">-20%</span>');
  const tinyGap = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, price: 499999 } }));
  expect(tinyGap).toContain('class="ledger-discount">-&lt;0.1%</span>');
  expect(tinyGap).not.toContain('>-0%');
  const zero = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, price: 0 } }));
  expect(zero).toContain('>0원</span>');
  expect(zero).toContain('>-100%</span>');
});

test.each([
  { price: 500000 },
  { price: 600000 },
  { price: null },
  { model_official_price: null },
  { model_official_price: 0 },
  { model_joined_id: null },
  { model_verify_level: 'page_text' },
  { model_verify_level: 'search_summary' },
])('LedgerCard omits the badge for equal, above or unknown official comparisons: %j', async patch => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'soon')!;
  const html = renderToStaticMarkup(createElement(LedgerCard, { deal: { ...base, ...patch } }));
  expect(html.match(/class="ledger-value"/g)).toHaveLength(2);
  expect(html).not.toContain('class="ledger-discount"');
  if (patch.price === null || patch.model_official_price === null || patch.model_joined_id === null || patch.model_verify_level) {
    expect(html).toContain(dealsCopy.unknownPrice);
  }
  if (patch.model_official_price === 0) expect(html).toContain('>0원</span>');
  if (patch.model_verify_level) expect(html).not.toContain('500,000');
});

test('/deals keeps active deals first and displays their count near the h1', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const html = renderToStaticMarkup(await DealsPage());
  expect(detailLinks(html)).toEqual(['today', 'soon', 'later', 'upcoming', 'ended', 'unknown']);
  expect(html).toMatch(/<h1>[^<]+<\/h1><p>지금 진행 중 <span class="active-deal-count" aria-label="3개 진행 중이에요">3<\/span><\/p>/);
});

test('the shared deal card remains byte-identical on deals, calendar and model detail', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const cards = [];
  for (const page of [await DealsPage(), await Calendar(), await ModelDetail({ params: Promise.resolve({ id: 'model' }) })]) {
    const html = renderToStaticMarkup(page);
    const card = [...html.matchAll(/<article class="deal-card">[\s\S]*?<\/article>/g)]
      .map(match => match[0]).find(article => article.includes('href="/deals/today"'));
    expect(card).toBeDefined();
    cards.push(card);
  }
  expect(new Set(cards).size).toBe(1);
});
