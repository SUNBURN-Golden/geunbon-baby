import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Home from '../app/page';
import Models from '../app/models/page';
import ModelDetail from '../app/models/[id]/page';
import Calendar from '../app/calendar/page';
import { NavLinks } from '../app/nav';
import { DealCard } from '../app/shared';
import { dealsCopy } from '../lib/deals-copy';
import { siteCopy } from '../lib/site-copy';
import type { Deal } from '../lib/data';
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
    .bind('model-1', 'Stokke', 'Test chair', 'high_chair', 'Importer', 430000, 'https://example.com/model', '2026-10-21', 'page_text', note).run();
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
  const card = renderToStaticMarkup(createElement(DealCard, { deal }));
  for (const html of [home, models, detail, calendar, card]) excludesOtherPrices(html);
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
  expect(detail).toContain('390,000원');
  expect(detail.match(/<section>/g)).toHaveLength(2);
  for (const html of [calendar, card]) {
    expect(html).toContain(dealsCopy.groupBuyPrice);
    expect(html).toContain('390,000원');
    expect(html).not.toContain('430,000원');
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

test('navigation preserves all four destinations and identifies the official-price tab', () => {
  const html = renderToStaticMarkup(createElement(NavLinks, { activeHref: '/models' }));
  expect([...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]))
    .toEqual(['/deals', '/models?by=brand', '/models', '/#letter']);
  expect(html).toContain(siteCopy.modelsNav);
  expect(html).toMatch(/<a(?=[^>]*href="\/models")(?=[^>]*aria-current="page")[^>]*>/);
  expect(html).not.toContain('기준가');
});

test('unavailable evidence has no empty official-source link and preserves importer recheck notice', async () => {
  await memory.db.prepare("UPDATE models SET source_url = '', official_price = NULL, verify_level = 'official_unpublished', importer = '기존 수입사 (기존 정보, 재확인 실패)' WHERE id = ?").bind('model-1').run();
  try {
    const html = renderToStaticMarkup(await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }));
    expect(html).toContain('정보 없음');
    expect(html).toContain('기존 정보, 재확인 실패');
    expect(html).not.toContain(`>${siteCopy.officialSource}</a>`);
    expect(html).not.toContain('href=""');
  } finally {
    await memory.db.prepare("UPDATE models SET source_url = 'https://example.com/model', official_price = 430000, verify_level = 'page_text', importer = 'Importer' WHERE id = ?").bind('model-1').run();
  }
});
