import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Layout from '../app/layout';
import Sellers from '../app/sellers/page';
import DealDetailPage from '../app/deals/[id]/page';
import Calendar from '../app/calendar/page';
import { sellerAnchor, sellerTrustHref } from '../lib/data';
import { dealsCopy } from '../lib/deals-copy';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  usePathname: () => '/calendar',
  useSearchParams: () => new URLSearchParams(),
}));

let memory: ReturnType<typeof memoryD1>;
const secondId = 'seller-8d0ce30a-5806-4bcb-a890-fc1405095ed0';
const secondHref = `/sellers#trust-${secondId}`;
beforeEach(async () => {
  memory = memoryD1();
  context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = await readFile(new URL(file, dir), 'utf8');
    for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
  }
});
afterEach(() => memory.close());

function expectNavigation(children: React.ReactNode) {
  const html = renderToStaticMarkup(createElement(Layout, null, children));
  expect(html.match(/<nav[^>]*aria-label="주요 메뉴"[\s\S]*?<\/nav>/)?.[0]).toContain('href="/calendar"');
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
  expect(footer).toContain('href="/calendar"');
  expect(footer).toContain('href="/sellers"');
}

test('deal and calendar target the same seller evidence across a rename and reorder', async () => {
  for (const [id, name, host] of [['seller-1', '가나다', 'a'], [secondId, '라마바', 'b']]) {
    await memory.db.prepare('INSERT INTO sellers (id, name, source_url, registration_source, withdrawal_source, official_import_source) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, name, `https://${host}.example/shop`, `https://${host}.example/reg`, `https://${host}.example/withdrawal`, `https://${host}.example/import`).run();
  }
  await memory.db.prepare("INSERT INTO models VALUES ('model-1', 'Stokke', 'Test model', 'high_chair', 'Importer', NULL, 'https://example.com/model', '2026-10-18', 'official_unpublished', '')").run();
  await memory.db.prepare("INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at) VALUES ('deal-1', 'https://example.com/deal', 'example', 'Test fixture', 'post', '2026-10-20')").run();
  await memory.db.prepare("INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at) VALUES ('deal-1', 'model-1', ?, 'Test deal', NULL, 'https://example.com/deal', 'manual', '2026-10-20', '2026-10-20T00:00:00Z', '2026-10-22T14:59:59Z')").bind(secondId).run();

  async function checkTarget(name: string, first: boolean) {
    const detail = renderToStaticMarkup(await DealDetailPage({ params: Promise.resolve({ id: 'deal-1' }) }));
    const trustHref = detail.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${dealsCopy.sellerTrust}<\\/a>`))?.[1];
    expect(trustHref).toBe(secondHref);
    const calendar = renderToStaticMarkup(await Calendar());
    expect(calendar).toContain(`href="${secondHref}"`);
    const sellers = renderToStaticMarkup(await Sellers());
    const article = sellers.match(new RegExp(`<article[^>]*id="trust-${secondId}"[\\s\\S]*?<\\/article>`))?.[0];
    expect(article).toBeDefined();
    expect(article).toContain('tabindex="-1"');
    expect(article).toContain(`aria-labelledby="trust-${secondId}-name"`);
    expect(article).toContain(`<h2 id="trust-${secondId}-name">${name}</h2>`);
    for (const path of ['shop', 'reg', 'withdrawal', 'import']) expect(article).toContain(`https://b.example/${path}`);
    expect(article).not.toContain('https://a.example/');
    expect(sellers.indexOf(`id="trust-${secondId}"`) < sellers.indexOf('id="trust-seller-1"')).toBe(first);
  }
  await checkTarget('라마바', false);
  await memory.db.prepare("UPDATE sellers SET name = '가가가' WHERE id = ?").bind(secondId).run();
  await checkTarget('가가가', true);
});

test('empty sellers and calendar retain the public navigation and explicit empty states', async () => {
  const sellers = await Sellers();
  expect(renderToStaticMarkup(sellers)).toContain('등록된 판매자가 없습니다.');
  expectNavigation(sellers);
  const calendar = await Calendar();
  expect(renderToStaticMarkup(calendar)).toContain('등록된 일정이 없습니다.');
  expectNavigation(calendar);
});

test('sellers without evidence retain unconfirmed badges and a focusable source link', async () => {
  await memory.db.prepare("INSERT INTO sellers (id, name, source_url) VALUES ('seller-1', 'Seller', 'https://a.example/shop')").run();
  const html = renderToStaticMarkup(await Sellers());
  expect(html).toContain('id="trust-seller-1" tabindex="-1"');
  expect(html.match(/· 미확인/g)).toHaveLength(3);
  expect(html).not.toContain('badge verified');
  expect(html).toContain('href="https://a.example/shop"');
});

test('seller href encodes the fragment while preserving the stable raw article id', () => {
  expect(sellerAnchor('seller-1')).toBe('trust-seller-1');
  expect(sellerTrustHref('seller-1')).toBe('/sellers#trust-seller-1');
  expect(sellerTrustHref('seller/#한')).toBe('/sellers#trust-seller%2F%23%ED%95%9C');
});

test.each([0, 1, 2, 3, 4, 5, 6, 7])('seller badges preserve evidence mapping and order for mask %s', async mask => {
  const evidence = [
    ['통신판매업 신고', 'https://a.example/reg'],
    ['청약철회 7일', 'https://a.example/withdrawal'],
    ['정식수입', 'https://a.example/import'],
  ];
  await memory.db.prepare('INSERT INTO sellers (id, name, source_url, registration_source, withdrawal_source, official_import_source) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('seller-1', 'Seller', 'https://a.example/shop', ...evidence.map(([, url], index) => mask & (1 << index) ? url : ['', ' ', null][index])).run();
  const html = renderToStaticMarkup(await Sellers());
  const badges = html.match(/<div class="badges">([\s\S]*?)<\/div>/)![1];
  expect(badges.match(/class="badge(?: verified)?"/g)).toHaveLength(3);
  evidence.forEach(([label, url], index) => {
    expect(badges).toContain(mask & (1 << index)
      ? `<a class="badge verified" href="${url}" target="_blank" rel="noopener noreferrer">${label} · 근거 확인 ↗</a>`
      : `<span class="badge">${label} · 미확인</span>`);
  });
  expect(badges.indexOf(evidence[0][0])).toBeLessThan(badges.indexOf(evidence[1][0]));
  expect(badges.indexOf(evidence[1][0])).toBeLessThan(badges.indexOf(evidence[2][0]));
  expect(html).toContain('id="trust-seller-1" tabindex="-1"');
  expect(html).toContain('href="https://a.example/shop" target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('아가마중에 소개된 판매처예요. 여기에 있다고 해서 입점이나 추천, 보증을 뜻하지는 않아요. 따로 확인된 자료가 없으면 미확인으로 보여요.');
});
