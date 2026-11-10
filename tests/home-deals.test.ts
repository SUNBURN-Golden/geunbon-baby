import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Home, { dynamic } from '../app/page';
import DealsPage from '../app/deals/page';
import Calendar from '../app/calendar/page';
import ModelDetail from '../app/models/[id]/page';
import { ActiveDeals } from '../app/_active-deals';
import { DEAL_SELECT, formatGap, priceGap, type DealWithContext } from '../lib/deals';
import { all } from '../lib/db';
import { dealsCopy } from '../lib/deals-copy';
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

test('dynamic home queries D1 and renders only active deals before the hero, soonest ending first, with a count', async () => {
  expect(dynamic).toBe('force-dynamic');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const html = renderToStaticMarkup(await Home());
  expect(clock).toHaveBeenCalledTimes(1);
  expect(html).toMatch(/^<main><section class="active-deals"/);
  expect(html.indexOf('class="active-deals"')).toBeLessThan(html.indexOf('class="hero"'));
  expect(detailLinks(html)).toEqual(['today', 'soon', 'later']);
  for (const inactive of ['upcoming deal', 'ended deal', 'unknown deal']) expect(html).not.toContain(inactive);
  expect(html).toContain(dealsCopy.activeHeading);
  expect(html).toContain('class="active-deal-count" aria-label="3개 진행 중이에요">3</span>');
  const cards = [...html.matchAll(/<article class="deal-card">([\s\S]*?)<\/article>/g)].map(match => match[1]);
  expect(cards).toHaveLength(3);
  for (const card of cards) {
    expect(card).toContain('<h2><a class="deal-title-link"');
    expect(card).toContain('400,000<span>원</span>');
    expect(card).toContain('500,000원');
    expect(card.replace(/<[^>]*>/g, '')).toContain(formatGap(priceGap(400000, 500000)!));
    expect(card).toContain('rel="sponsored noopener noreferrer"');
    expect(card).not.toContain('/sellers#');
    expect(card.match(/class="deal-disclaimer"/g)).toHaveLength(1);
    // An opening anchor must be closed before another one opens.
    const anchors = card.match(/<a\b[^>]*>|<\/a>/g);
    expect(anchors).toHaveLength(4);
    expect(anchors?.map(anchor => anchor === '</a>' ? 'close' : 'open')).toEqual(['open', 'close', 'open', 'close']);
    expect(card).toContain(dealsCopy.ad);
  }
  expect(cards[0]).toContain('<img');
  expect(cards[0]).toContain('src="https://cdninstagram.com/chair.jpg?sig=synthetic%2B&amp;x=1"');
  expect(cards[0]).toContain('alt="Chair 상품 이미지"');
  expect(cards[0]).toContain('referrerPolicy="no-referrer"');
  expect(cards[0]).not.toContain('class="active-deal-mark"');
  for (const card of cards.slice(1)) {
    expect(card).not.toContain('class="active-deal-mark"');
    expect(card).not.toContain('<img');
  }
  expect(cards[0]).toContain(dealsCopy.endsToday);
  expect(cards[1]).toContain(dealsCopy.remaining.replace('{n}', '1'));
  expect(cards[2]).toContain(dealsCopy.remaining.replace('{n}', '4'));
});

test('home image alt prefers the joined model name and falls back to the deal title', async () => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'today')!;
  for (const [patch, name] of [
    [{}, 'Chair'],
    [{ model_joined_id: null }, 'today deal'],
    [{ model_name: null }, 'today deal'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(ActiveDeals, { deals: [{ ...base, ...patch }], totalCount: 1, nowMs }));
    expect(html).toContain(`alt="${name} 상품 이미지"`);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).not.toContain('/_next/image');
  }
});

test.each([null, '', 'http://cdninstagram.com/chair.jpg', 'https://example.com/chair.jpg', 'javascript:alert(1)'])(
  'home keeps text-only cards for missing or unsafe image %s', async image_url => {
    const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
    const base = rows.find(deal => deal.id === 'today')!;
    for (const patch of [{}, { model_joined_id: null }]) {
      const html = renderToStaticMarkup(createElement(ActiveDeals, { deals: [{ ...base, ...patch, image_url }], totalCount: 1, nowMs }));
      expect(html).not.toContain('class="active-deal-mark"');
      expect(html).not.toContain('<img');
      expect(html).toContain(base.title);
      expect(html).toContain('400,000');
    }
  },
);

test('no active deals renders a zero count and one short empty line without cards', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T00:00:00Z'));
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain('class="active-deal-count" aria-label="0개 진행 중이에요">0</span>');
  expect(html).toContain(`<p class="active-deal-empty">${dealsCopy.activeEmpty}</p></section>`);
  expect(detailLinks(html)).toEqual([]);
  expect(html).not.toContain('class="active-deal-row"');
  const empty = renderToStaticMarkup(createElement(ActiveDeals, { deals: [], totalCount: 1, nowMs }));
  expect(empty).toContain(dealsCopy.activeEmpty);
  expect(empty).not.toContain('<ul');
});

test('active cards preserve unknown prices, zero prices and comparison direction', async () => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'soon')!;
  const render = (patch: Partial<DealWithContext>) => renderToStaticMarkup(createElement(ActiveDeals, { deals: [{ ...base, ...patch }], totalCount: 1, nowMs }));
  expect(render({ price: 600000 })).toContain('높아요');
  expect(render({ price: 500000 })).toContain(formatGap(priceGap(500000, 500000)!));
  expect(render({ price: 499999 })).toContain('낮아요');
  expect(render({ price: 499999 }).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<')).toContain(formatGap(priceGap(499999, 500000)!));
  expect(render({ price: 0 })).toContain(`>0<span>${dealsCopy.won}</span>`);
  const unknown = render({ price: null });
  expect(unknown).toContain(dealsCopy.unknownPrice);
  expect(unknown).toContain('정보 없음');
  expect(unknown).toContain('500,000원');
  expect(unknown).not.toContain('class="deal-gap"');
  const zeroOfficial = render({ model_official_price: 0 });
  expect(zeroOfficial).toContain(`${dealsCopy.officialPrice} · 0원`);
  expect(zeroOfficial).not.toContain('class="deal-gap"');
  for (const patch of [{ model_official_price: null }, { model_joined_id: null }]) {
    const html = render(patch);
    expect(html).toContain('400,000');
    expect(html).toContain(dealsCopy.unknownOfficial);
    expect(html).toContain('정보 없음');
    expect(html).not.toContain('class="deal-gap"');
  }
});

test.each(['page_text', 'search_summary'])('home active cards hide %s prices and comparisons', async model_verify_level => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'soon')!;
  const html = renderToStaticMarkup(createElement(ActiveDeals, { deals: [{ ...base, model_verify_level }], totalCount: 1, nowMs }));
  expect(html).toContain(dealsCopy.unknownOfficial);
  expect(html).toContain('400,000');
  expect(html).not.toContain('500,000');
  expect(html).not.toContain('class="deal-gap"');
});

test('/deals keeps active deals first and displays their count near the h1', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const html = renderToStaticMarkup(await DealsPage());
  expect(detailLinks(html)).toEqual(['today', 'soon', 'later', 'upcoming', 'ended', 'unknown']);
  expect(html).toMatch(/<h1>[^<]+<\/h1><p>지금 진행 중 <span class="active-deal-count" aria-label="3개 진행 중이에요">3<\/span><\/p>/);
});

test('the same deal without a seller renders byte-identical cards on all four routes', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const cards = [];
  for (const page of [await Home(), await DealsPage(), await Calendar(), await ModelDetail({ params: Promise.resolve({ id: 'model' }) })]) {
    const html = renderToStaticMarkup(page);
    const card = [...html.matchAll(/<article class="deal-card">[\s\S]*?<\/article>/g)]
      .map(match => match[0]).find(article => article.includes('href="/deals/today"'));
    expect(card).toBeDefined();
    cards.push(card);
  }
  expect(new Set(cards).size).toBe(1);
});
