import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import Home from '../app/page';
import Layout, { metadata } from '../app/layout';
import Models from '../app/models/page';
import Detail from '../app/models/[id]/page';
import Calendar from '../app/calendar/page';
import { siteCopy } from '../lib/site-copy';
import { dealsCopy } from '../lib/deals-copy';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  usePathname: () => '/models',
  useSearchParams: () => new URLSearchParams(),
}));
const memory = memoryD1();
const note = 'Other retailer 123,456 KRW; overseas 234,567 KRW; used 98,765 KRW';
beforeAll(async () => {
  context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = await readFile(new URL(file, dir), 'utf8');
    for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
  }
  await memory.db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('model-1', 'Stokke', 'Example model', 'high_chair', 'Importer', 430000, 'https://example.com/model', '2026-10-18', 'manual', note).run();
  await memory.db.prepare("INSERT INTO sellers (id, name, source_url) VALUES ('seller-1', 'Seller', 'https://example.com/seller')").run();
  await memory.db.prepare("INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at) VALUES ('deal-1', 'https://example.com/deal', 'example', 'Example', 'post', '2026-10-20')").run();
  await memory.db.prepare("INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at) VALUES ('deal-1', 'model-1', 'seller-1', 'Example deal', 390000, 'https://example.com/deal', 'manual', '2026-10-20', '2026-10-21', '2026-10-22')").run();
});
afterAll(() => memory.close());

test('model list, detail and calendar show only supported prices with explicit labels', async () => {
  const list = renderToStaticMarkup(await Models({ searchParams: Promise.resolve({}) }));
  const detail = renderToStaticMarkup(await Detail({ params: Promise.resolve({ id: 'model-1' }) }));
  const calendar = renderToStaticMarkup(await Calendar());
  expect(list).toContain(siteCopy.officialLabel);
  expect(list).toContain('430,000');
  expect(detail.match(/<section>/g)).toHaveLength(2);
  expect(detail).toContain(siteCopy.officialPrice);
  expect(detail).toContain('430,000');
  for (const html of [detail, calendar]) {
    expect(html).toContain(dealsCopy.groupBuyPrice);
    expect(html).toContain('390,000');
    expect(html).toContain(dealsCopy.disclaimer);
  }
  for (const html of [list, detail, calendar]) {
    for (const forbidden of [note, '123,456', '234,567', '98,765', '해외가', '환율', '중고', '기준가']) expect(html).not.toContain(forbidden);
  }
});

test('home has the verified-products description and no deleted phrases or empty note block', async () => {
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain(siteCopy.heroLead);
  expect(html).toContain(siteCopy.pricePromise);
  expect(html).toContain('href="/deals"');
  for (const forbidden of ['모르', '모릅', '해외가', '중고', 'class="note"']) expect(html).not.toContain(forbidden);
});

test('layout, metadata and sharing use the spaced brand and new description, retaining wordmark and nav hrefs', () => {
  const html = renderToStaticMarkup(createElement(Layout, null, createElement('main')));
  expect(html).toContain(siteCopy.brand);
  expect(html).not.toContain('아가마중');
  expect(html).toContain('AGAMAJUNG');
  expect(html).toContain(`aria-label="${siteCopy.homeLabel}"`);
  expect(html).toContain(siteCopy.tagline);
  expect(html).toMatch(/<a(?=[^>]*href="\/models")(?=[^>]*aria-current="page")[^>]*>/);
  expect(html).toContain('href="/models?by=brand"');
  expect(html).toContain(siteCopy.modelsNav);
  expect(html).not.toContain('기준가');
  expect(metadata.title).toEqual({ default: siteCopy.title, template: siteCopy.titleTemplate });
  expect(metadata.description).toBe(siteCopy.description);
  expect(metadata.openGraph).toMatchObject({ title: siteCopy.title, siteName: siteCopy.brand, description: siteCopy.description });
  expect(metadata.twitter).toMatchObject({ title: siteCopy.title, description: siteCopy.description });
});
