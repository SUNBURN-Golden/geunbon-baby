import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Home from '../app/page';
import Models from '../app/models/page';
import ModelDetail from '../app/models/[id]/page';
import Calendar from '../app/calendar/page';
import { NavLinks } from '../app/nav';
import { DealCard, PriceLegend } from '../app/deals/_components';
import { DEAL_SELECT, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { siteCopy } from '../lib/site-copy';
import { verification, verificationLabel, type Deal } from '../lib/data';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

const memory = memoryD1();
const note = 'Retailer 123,456원; discount 234,567원; overseas $799; used 345,678원';
const deal: Deal = {
  id: 'deal-1', model_id: 'model-1', seller_id: 'seller-1', title: 'Reviewed group buy',
  image_url: null, price: 390000, source_url: 'https://example.com/deal', verify_level: 'manual',
  checked: '2026-10-21', starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-22T00:00:00Z',
};
beforeAll(async () => {
  context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = await readFile(new URL(file, dir), 'utf8');
    for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
  }
  await memory.db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('model-1', 'Stokke', 'Test chair', 'high_chair', 'Importer', 430000, 'https://example.com/model', '2026-10-21', 'page_body', note).run();
  await memory.db.prepare("INSERT INTO sellers (id, name, source_url) VALUES ('seller-1', 'Seller', 'https://example.com/seller')").run();
  await memory.db.prepare("INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at, status) VALUES ('deal-1', 'https://example.com/deal', 'example', 'Reviewed deal', 'post', '2026-10-21', 'approved')").run();
  await memory.db.prepare('INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(deal.id, deal.model_id, deal.seller_id, deal.title, deal.price, deal.source_url, deal.verify_level, deal.checked, deal.starts_at, deal.ends_at).run();
});
afterAll(() => memory.close());

function excludesOtherPrices(html: string) {
  for (const value of [note, '123,456', '234,567', '345,678', '$799', '해외가', '당근', '중고', '환율', '기준가', 'OVERSEAS', 'PRE-LOVED']) {
    expect(html).not.toContain(value);
  }
}

afterEach(() => { vi.useRealTimers(); });

test('home, models, model detail, calendar and shared cards expose only the allowed price sources', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-21T03:00:00Z');
  const home = renderToStaticMarkup(await Home());
  const models = renderToStaticMarkup(await Models({ searchParams: Promise.resolve({}) }));
  const detail = renderToStaticMarkup(await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }));
  const calendar = renderToStaticMarkup(await Calendar());
  const joinedDeal = (await memory.db.prepare(DEAL_SELECT).first<DealWithContext>())!;
  const card = renderToStaticMarkup(createElement(DealCard, { deal: joinedDeal, nowMs: Date.now() }));
  for (const html of [home, models, detail, calendar, card]) excludesOtherPrices(html);
  // The decorative discount stamp is allowed on shared deal lists but never on /models/* routes.
  for (const html of [home, calendar, card]) expect(html).toContain('class="ledger-discount"');
  for (const html of [models, detail]) expect(html).not.toContain('ledger-discount');
  expect(detail).toContain('class="deal-gap"');
  expect(home).toContain(siteCopy.pricePromise);
  expect(models).toContain(siteCopy.officialLabel);
  expect(models).toContain('430,000원');
  expect(models).toContain('390,000<span>원</span>');
  vi.setSystemTime('2026-10-23T00:00:00Z');
  const later = renderToStaticMarkup(await Models({ searchParams: Promise.resolve({}) }));
  excludesOtherPrices(later);
  expect(later).toContain('430,000원');
  expect(later).not.toContain('390,000');
  vi.setSystemTime('2026-10-21T03:00:00Z');
  expect(detail).toContain('430,000원');
  expect(detail).toContain('390,000<span>원</span>');
  expect(detail.match(/<section>/g)).toHaveLength(2);
  for (const html of [calendar, card]) {
    expect(html).toContain(dealsCopy.groupBuyPrice);
    expect(html).toContain('390,000<span>원</span>');
    expect(html).toContain('430,000원');
  }
});

test('missing official prices stay unknown even when seed notes contain other prices', async () => {
  await memory.db.prepare('UPDATE models SET official_price = NULL WHERE id = ?').bind('model-1').run();
  try {
    for (const html of [
      renderToStaticMarkup(await Models({ searchParams: Promise.resolve({}) })),
      renderToStaticMarkup(await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) })),
    ]) {
      excludesOtherPrices(html);
      expect(html).toContain('정보 없음');
      expect(html).not.toContain('430,000원');
    }
  } finally {
    await memory.db.prepare('UPDATE models SET official_price = 430000 WHERE id = ?').bind('model-1').run();
  }
});

test.each(['page_text', 'search_summary'])('models and model detail hide a stored %s price and retain evidence', async level => {
  await memory.db.prepare('UPDATE models SET official_price = 430000, verify_level = ? WHERE id = ?').bind(level, 'model-1').run();
  try {
    const models = renderToStaticMarkup(await Models({ searchParams: Promise.resolve({}) }));
    const detail = renderToStaticMarkup(await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }));
    for (const html of [models, detail]) {
      expect(html).toContain('정보 없음');
      expect(html).not.toContain('430,000');
      excludesOtherPrices(html);
    }
    expect(detail).toContain(verificationLabel(level));
    expect(detail).toContain('2026-10-21');
    expect(detail).toContain('Importer');
    expect(detail).toContain('href="https://example.com/model"');
  } finally {
    await memory.db.prepare("UPDATE models SET official_price = 430000, verify_level = 'page_body' WHERE id = ?").bind('model-1').run();
  }
});

test('navigation includes the calendar and identifies the official-price tab', () => {
  const html = renderToStaticMarkup(createElement(NavLinks, { activeHref: '/models' }));
  expect([...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]))
    .toEqual(['/deals', '/calendar', '/models?by=brand', '/models', '/#letter']);
  expect(html).toContain(siteCopy.modelsNav);
  expect(html).toMatch(/<a(?=[^>]*href="\/models")(?=[^>]*aria-current="page")[^>]*>/);
  expect(html).not.toContain('기준가');
});

test.each(['기존 수입사 (기존 정보, 재확인 실패)', '미확인'])('unavailable evidence has neutral labels and preserves importer %s', async importer => {
  await memory.db.prepare("UPDATE models SET source_url = '', official_price = NULL, verify_level = 'official_unpublished', importer = ? WHERE id = ?").bind(importer, 'model-1').run();
  try {
    const html = renderToStaticMarkup(await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }));
    expect(html).toContain('정보 없음');
    expect(html).toContain(verification.official_unpublished);
    expect(html).toContain(importer);
    for (const text of ['미공개', '비공개', '>official_unpublished<', '430,000원']) expect(html).not.toContain(text);
    expect(html).not.toContain(`>${siteCopy.officialSource}</a>`);
    expect(html).not.toContain('href=""');
  } finally {
    await memory.db.prepare("UPDATE models SET source_url = 'https://example.com/model', official_price = 430000, verify_level = 'page_body', importer = 'Importer' WHERE id = ?").bind('model-1').run();
  }
});


test('ledger orders official/group-buy cells and derives badges only for verified live reductions', async () => {
  const joined = (await memory.db.prepare(DEAL_SELECT).first<DealWithContext>())!;
  const nowMs = Date.parse('2026-10-21T03:00:00Z');
  const variants: Partial<DealWithContext>[] = [
    {}, { price: null }, { price: 0 }, { model_official_price: null },
    { model_verify_level: 'page_text' }, { price: 500000 },
    { ends_at: '2026-10-20T00:00:00Z' }, { model_id: 'unillustrated', model_joined_id: null },
  ];
  const cards = variants.map(patch => renderToStaticMarkup(createElement(DealCard, { deal: { ...joined, ...patch }, nowMs })));
  expect(cards[0].indexOf('ledger-official')).toBeLessThan(cards[0].indexOf('ledger-group'));
  expect(cards[0]).toContain('<span class="sr-only">공식가격이에요 · </span>430,000원');
  expect(cards[0]).toContain('390,000<span>원</span>');
  expect(cards[0]).toContain('class="ledger-discount" aria-hidden="true">−9%');
  expect(cards[0]).toContain('src="/img/models/model-1-540x540.png"');
  for (const index of [1, 2, 3, 4, 5, 6, 7]) expect(cards[index]).not.toContain('ledger-discount');
  expect(cards[1]).toContain(dealsCopy.unknownPrice);
  expect(cards[2]).toContain('>0<span>원</span>');
  expect(cards[2]).not.toContain('−100%');
  expect(cards[4]).not.toContain('430,000');
  if (process.env.REDESIGN_SCREENSHOTS === '1') {
    await mkdir('.local/redesign-html', { recursive: true });
    await writeFile('.local/redesign-html/ledger-fixtures.html', `<main><section class="active-deals"><h1>Ledger regression fixtures</h1>${renderToStaticMarkup(createElement(PriceLegend))}<div class="deal-list">${cards.join('')}</div></section></main>`);
  }
});

test('model detail keeps its half-width deal column to a single card at every width', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.comparison \.deal-list\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);\s*\}/);
});
