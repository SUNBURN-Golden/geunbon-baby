import { readdir, readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Models from '../app/models/page';
import { verification } from '../lib/data';
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
const note = 'Retailer 123,456원; overseas $799; used 345,678원';
const names = { 'model-1': '트립트랩 하이체어(너도밤나무)', 'model-20': '손그림 없는 모델', 'model-3': '공식가 모름 모델' };
const insertDeal = async (id: string, model: string, price: number | null, starts: string, ends: string) => {
  await memory.db.prepare("INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at, status) VALUES (?, ?, 'example', 'Deal', 'post', '2026-10-20', 'approved')").bind(id, `https://example.com/${id}`).run();
  await memory.db.prepare('INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, model, 'seller-1', `${id} title`, price, `https://example.com/${id}`, 'manual', '2026-10-20', starts, ends).run();
};

beforeAll(async () => {
  context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const schema = await readFile(new URL(file, dir), 'utf8');
    for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
  }
  const insertModel = (id: string, price: number | null) => memory.db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'Stokke', names[id as keyof typeof names], 'high_chair', 'Importer', price, 'https://example.com/model', '2026-10-18', 'page_text', note).run();
  await insertModel('model-1', 430000);
  await insertModel('model-20', 430000);
  await insertModel('model-3', null);
  await memory.db.prepare("INSERT INTO sellers (id, name, source_url) VALUES ('seller-1', 'Seller', 'https://example.com/seller')").run();
  await insertDeal('d-active-1', 'model-1', 390000, '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z');
  await insertDeal('d-active-2', 'model-1', 410000, '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z');
  await insertDeal('d-ended', 'model-1', 300000, '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
  await insertDeal('d-upcoming', 'model-1', 350000, '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z');
  await insertDeal('d-model-3', 'model-3', 380000, '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z');
});
afterAll(() => memory.close());
afterEach(() => { vi.useRealTimers(); });

async function render(now: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  return renderToStaticMarkup(await Models({ searchParams: Promise.resolve({}) }));
}
const cardOf = (html: string, id: string) => {
  const match = new RegExp(`<a class="model-card" href="/models/${id}">.*?</a>`).exec(html);
  expect(match, id).not.toBeNull();
  return match![0];
};

test('cards show name, art or placeholder, official price and the lowest active deal only', async () => {
  const html = await render('2026-10-21T03:00:00Z');
  expect(html.match(/<a class="model-card"/g)).toHaveLength(3);
  for (const id of Object.keys(names)) {
    const card = cardOf(html, id);
    for (const tag of ['<a ', '<time', '<button']) expect(card.slice(1)).not.toContain(tag);
    expect(card).not.toContain('class="eyebrow"');
  }

  const one = cardOf(html, 'model-1');
  expect(one).toContain(`alt="${names['model-1']}"`);
  expect(one).toContain('-540x675.png');
  expect(one).toContain('model-deal-price');
  expect(one).toContain('390,000');
  expect(one).toContain('-9%');
  expect(one).toContain('<s>430,000원</s>');
  expect(one).not.toContain('410,000');
  expect(one).not.toContain('300,000');
  expect(one).not.toContain('350,000');

  const two = cardOf(html, 'model-20');
  expect(two).not.toContain('<img');
  expect(two).toContain('model-art-mark');
  expect(two).toContain('진행 중인 공구 없음');
  expect(two).toContain('model-official-solo');
  expect(two).toContain('430,000원');
  expect(two).not.toContain('<s>');

  const three = cardOf(html, 'model-3');
  expect(three).toContain('정보 없음');
  expect(three).toContain('380,000');
  expect(three).not.toContain('model-discount');
  expect(three).not.toContain('<s>');

  const hrefs = [...html.matchAll(/class="model-card" href="([^"]+)"/g)].map(m => m[1]);
  expect(hrefs).toEqual(['/models/model-1', '/models/model-3', '/models/model-20']);
});

test('the page carries no check dates, sources, ads, other prices or verification levels', async () => {
  const html = await render('2026-10-21T03:00:00Z');
  const forbidden = ['확인', '출처', 'ESSENTIAL', '광고', '해외가', '중고', '환율', 'class="eyebrow"', '123,456', '$799', '345,678', '2026-10-18',
    ...Object.keys(verification), ...Object.values(verification)];
  for (const value of forbidden) expect(html, value).not.toContain(value);
});

test('after every deal ends all cards say there is no active deal', async () => {
  const html = await render('2026-10-23T00:00:00Z');
  expect(html.match(/진행 중인 공구 없음/g)).toHaveLength(3);
  expect(html).not.toContain('<s>');
  expect(html).not.toContain('model-discount');
  expect(html).not.toContain('390,000');
  expect([...html.matchAll(/class="model-card" href="([^"]+)"/g)].map(m => m[1])).toEqual(['/models/model-1', '/models/model-20', '/models/model-3']);
});
