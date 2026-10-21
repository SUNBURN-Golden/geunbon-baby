import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import Home, { dynamic } from '../app/page';
import DealsPage from '../app/deals/page';
import { ActiveDeals } from '../app/_active-deals';
import { DEAL_SELECT, type DealWithContext } from '../lib/deals';
import { all } from '../lib/db';
import { dealsCopy } from '../lib/deals-copy';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));

const nowMs = Date.parse('2026-10-21T03:00:00Z');
const memory = memoryD1();
beforeAll(async () => {
  context.db = memory.db;
  const schema = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
  await memory.db.prepare('PRAGMA foreign_keys = OFF').run();
  await memory.db.prepare("INSERT INTO models VALUES ('model', 'Brand', 'Chair', 'high_chair', 'Importer', 500000, 'https://example.com/model', '2026-10-20', 'manual', '')").run();
  // Deliberately insert in an order different from the required closing order.
  for (const [id, start, end] of [
    ['later', '2026-10-20', '2026-10-25'],
    ['upcoming', '2026-10-22', '2026-10-23'],
    ['ended', '2026-10-19', '2026-10-20'],
    ['soon', '2026-10-20', '2026-10-22'],
    ['unknown', 'invalid-start', 'invalid-stop'],
    ['today', '2026-10-20', '2026-10-21T03:00:00Z'],
  ]) {
    await memory.db.prepare('INSERT INTO deals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, 'model', 'seller', `${id} deal`, 400000, 'https://example.com/deal', 'manual', '2026-10-20', start, end).run();
  }
});
afterAll(() => memory.close());

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
  expect(html.match(/class="active-deal-card"/g)).toHaveLength(3);
  // Each card has just one link, encompassing the title, price and comparison.
  const cards = [...html.matchAll(/<a class="active-deal-card"[^>]*>([\s\S]*?)<\/a>/g)].map(match => match[1]);
  expect(cards).toHaveLength(3);
  for (const card of cards) {
    expect(card).not.toContain('<a');
    expect(card).toContain('<h3>');
    expect(card).toContain('400,000');
    expect(card).toContain('500,000원');
    expect(card).toContain('20.0% 낮아요');
    expect(card).toContain(dealsCopy.ad);
    expect(card).toContain('aria-hidden="true"');
    expect(card).not.toContain('<img');
  }
  expect(cards[0]).toContain(dealsCopy.endsToday);
  expect(cards[1]).toContain(dealsCopy.remaining.replace('{n}', '1'));
  expect(cards[2]).toContain(dealsCopy.remaining.replace('{n}', '4'));
});

test('no active deals renders a zero count and one short empty line without cards', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T00:00:00Z'));
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain('class="active-deal-count" aria-label="0개 진행 중이에요">0</span>');
  expect(html).toContain(`<p class="active-deal-empty">${dealsCopy.activeEmpty}</p></section>`);
  expect(detailLinks(html)).toEqual([]);
  expect(html).not.toContain('class="active-deal-row"');
  const empty = renderToStaticMarkup(createElement(ActiveDeals, { deals: [], nowMs }));
  expect(empty).toContain(dealsCopy.activeEmpty);
  expect(empty).not.toContain('<ul');
});

test('active cards preserve unknown prices, zero prices and comparison direction', async () => {
  const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
  const base = rows.find(deal => deal.id === 'soon')!;
  const render = (patch: Partial<DealWithContext>) => renderToStaticMarkup(createElement(ActiveDeals, { deals: [{ ...base, ...patch }], nowMs }));
  expect(render({ price: 600000 })).toContain('20.0% 높아요');
  expect(render({ price: 500000 })).toContain(dealsCopy.compactEqual);
  expect(render({ price: 499999 })).toContain('&lt;0.1% 낮아요');
  expect(render({ price: 0 })).toContain(`>0<span>${dealsCopy.won}</span>`);
  const unknown = render({ price: null });
  expect(unknown).toContain(dealsCopy.unknownPrice);
  expect(unknown).toContain('500,000원');
  expect(unknown).not.toContain('class="active-deal-gap"');
  const zeroOfficial = render({ model_official_price: 0 });
  expect(zeroOfficial).toContain(`${dealsCopy.officialPrice} · 0원`);
  expect(zeroOfficial).not.toContain('class="active-deal-gap"');
  for (const patch of [{ model_official_price: null }, { model_joined_id: null }]) {
    const html = render(patch);
    expect(html).toContain('400,000');
    expect(html).toContain(dealsCopy.unknownOfficial);
    expect(html).not.toContain('class="active-deal-gap"');
  }
});

test('/deals keeps active deals first and displays their count near the h1', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const html = renderToStaticMarkup(await DealsPage());
  expect(detailLinks(html)).toEqual(['today', 'soon', 'later', 'upcoming', 'ended', 'unknown']);
  expect(html).toMatch(/<h1>[^<]+<\/h1><p>지금 진행 중 <span class="active-deal-count" aria-label="3개 진행 중이에요">3<\/span><\/p>/);
});
