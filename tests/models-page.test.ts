import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import Models from '../app/models/page';
import { ModelCard } from '../app/models/_card';
import { verification } from '../lib/data';
import { buildModelCards } from '../lib/model-cards';
import seed from '../seed/models.json';
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
const names = { 'model-1': '트립트랩 하이체어(너도밤나무)', 'model-42': '손그림 없는 모델', 'model-20': '피파 넥스트(바구니 카시트)', 'model-3': '공식가 모름 모델' };
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
    .bind(id, 'Stokke', names[id as keyof typeof names], 'high_chair', 'Importer', price, 'https://example.com/model', '2026-10-18', 'page_body', note).run();
  await insertModel('model-1', 430000);
  await insertModel('model-42', 430000);
  await insertModel('model-20', 670000);
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

// Shared contract for priced, unknown-price and absent-deal cards.
function expectIllustratedCard(html: string, id: string, displayName: string) {
  expect(html).toContain(`<h2 class="model-name">${displayName}</h2>`);
  expect(html.match(/<h2 /g)).toHaveLength(1);
  expect(html.match(/<p /g)).toHaveLength(2);
  expect(html.match(/class="model-art model-art-line"/g)).toHaveLength(1);
  expect(html.match(/<div /g)).toHaveLength(2); // Illustration and price wrappers only.
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html.match(/<img /g)).toHaveLength(1);
  expect(html).toContain(`src="/img/models/${id}.svg"`);
  expect(html).toContain('width="1080" height="1080"');
  expect(html).toContain(`alt="${displayName}"`);
  expect(html).toContain('loading="lazy" decoding="async"');
  expect(html).not.toMatch(/srcSet|srcset|sizes=|\.png|\/_next\/image/);
  expect(html).not.toContain('model-art-mark');
  for (const forbidden of ['<time', '<button', 'badge', 'eyebrow', '광고', 'checked', 'page_body', 'https://']) {
    expect(html).not.toContain(forbidden);
  }
}

test.each(['page_text', 'search_summary'])('%s prices do not appear on cards or produce strikethroughs', async level => {
  await memory.db.prepare('UPDATE models SET verify_level = ? WHERE id IN (?, ?)').bind(level, 'model-1', 'model-20').run();
  try {
    const html = await render('2026-10-21T03:00:00Z');
    expect(html.match(/<a class="model-card"/g)).toHaveLength(4);
    expect([...html.matchAll(/class="model-card" href="([^"]+)"/g)].map(m => m[1]))
      .toEqual(['/models/model-1', '/models/model-3', '/models/model-42', '/models/model-20']);
    for (const id of ['model-1', 'model-20']) {
      const card = cardOf(html, id);
      expect(card).toContain('정보 없음');
      expect(card).not.toContain('430,000');
      expect(card).not.toContain('670,000');
      expect(card).not.toContain('<s>');
      expect(card).not.toContain('%');
    }
    expect(cardOf(html, 'model-1')).toContain('390,000');
  } finally {
    await memory.db.prepare("UPDATE models SET verify_level = 'page_body' WHERE id IN (?, ?)").bind('model-1', 'model-20').run();
  }
});

test('cards show name, art or placeholder, official price and the lowest active deal only', async () => {
  const html = await render('2026-10-21T03:00:00Z');
  expect(html.match(/<a class="model-card"/g)).toHaveLength(4);
  for (const id of Object.keys(names)) {
    const card = cardOf(html, id);
    for (const tag of ['<a ', '<time', '<button']) expect(card.slice(1)).not.toContain(tag);
    expect(card).not.toContain('class="eyebrow"');
    expect(card).not.toContain('model-discount');
    expect(card).not.toContain('%');
    expect(card.match(/<h2 /g)).toHaveLength(1);
    expect(card).toContain(`<h2 class="model-name">Stokke ${names[id as keyof typeof names]}</h2>`);
    expect(card.match(/<p /g)).toHaveLength(2);
    expect(card.match(/class="model-art(?: model-art-line)?"/g)).toHaveLength(1);
    if (id !== 'model-42') expectIllustratedCard(card, id, `Stokke ${names[id as keyof typeof names]}`);
  }

  const one = cardOf(html, 'model-1');
  expect(one).toContain(`alt="Stokke ${names['model-1']}"`);
  expect(one).toContain('.svg');
  expect(one).toContain('model-deal-price');
  expect(one).toContain('model-art-line');
  expect(one).toContain('width="1080" height="1080"');
  expect(one).toContain('390,000');
  expect(one).not.toContain('%');
  expect(one).toContain('<s>430,000원</s>');
  expect(one).not.toContain('410,000');
  expect(one).not.toContain('300,000');
  expect(one).not.toContain('350,000');

  const two = cardOf(html, 'model-42');
  expect(two).not.toContain('<img');
  expect(two).toContain('model-art-mark');
  expect(two).toContain('진행 중인 공구 없음');
  expect(two).toContain('model-official-solo');
  expect(two).toContain('430,000원');
  expect(two).not.toContain('<s>');

  const three = cardOf(html, 'model-3');
  expect(three).toContain('정보 없음');
  expect(three).toContain('model-3.svg');
  expect(three).toContain(`alt="Stokke ${names['model-3']}"`);
  expect(three).toContain('380,000');
  expect(three).not.toContain('model-discount');
  expect(three).not.toContain('<s>');

  const twenty = cardOf(html, 'model-20');
  expect(twenty).toContain('model-art-line');
  expect(twenty).toContain('width="1080" height="1080"');
  expect(twenty).toContain('model-20.svg');
  expect(twenty).toContain(`alt="Stokke ${names['model-20']}"`);
  expect(twenty).toContain('670,000원');

  const hrefs = [...html.matchAll(/class="model-card" href="([^"]+)"/g)].map(m => m[1]);
  expect(hrefs).toEqual(['/models/model-1', '/models/model-3', '/models/model-42', '/models/model-20']);
});

test('an active deal with no price retains the official row and says information is unavailable', async () => {
  await insertDeal('d-null-price', 'model-20', null, '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z');
  try {
    const card = cardOf(await render('2026-10-21T03:00:00Z'), 'model-20');
    expectIllustratedCard(card, 'model-20', `Stokke ${names['model-20']}`);
    expect(card).toContain('<p class="model-deal"><span class="model-deal-unknown">정보 없음</span></p>');
    expect(card).toContain('<p class="model-official"><span>공식가</span> <span>670,000원</span></p>');
    expect(card).not.toContain('진행 중인 공구 없음');
    expect(card).not.toContain('model-official-solo');
    expect(card).not.toContain('<s>');
  } finally {
    await memory.db.prepare("DELETE FROM deals WHERE id = 'd-null-price'").run();
    await memory.db.prepare("DELETE FROM ingested_items WHERE id = 'd-null-price'").run();
  }
});

test.each(seed.models.map((model, index) => ({ ...model, id: `model-${index + 1}` })))('$id renders its seeded brand and model within the four card elements', model => {
  const [card] = buildModelCards([{
    id: model.id, brand: model.brand, name: model.model,
    official_price: model.kr_official_price_krw, verify_level: model.verify_level,
  }], [], Date.parse('2026-10-21T03:00:00Z'));
  const html = renderToStaticMarkup(createElement(ModelCard, { card }));
  const displayName = renderToStaticMarkup(`${model.brand} ${model.model}`);
  expectIllustratedCard(html, model.id, displayName);
  expect(html).toContain('진행 중인 공구 없음');
  expect(html).toContain('class="model-official model-official-solo"');
});

test('the page carries no check dates, sources, ads, other prices or verification levels', async () => {
  const html = await render('2026-10-21T03:00:00Z');
  const forbidden = ['확인', '출처', 'ESSENTIAL', '광고', '해외가', '중고', '환율', 'class="eyebrow"', '123,456', '$799', '345,678', '2026-10-18',
    ...Object.keys(verification), ...Object.values(verification)];
  for (const value of forbidden) expect(html, value).not.toContain(value);
});

test('after every deal ends all cards say there is no active deal', async () => {
  const html = await render('2026-10-23T00:00:00Z');
  expect(html.match(/진행 중인 공구 없음/g)).toHaveLength(4);
  expect(html).not.toContain('<s>');
  expect(html).not.toContain('model-discount');
  expect(html).not.toContain('390,000');
  expect([...html.matchAll(/class="model-card" href="([^"]+)"/g)].map(m => m[1])).toEqual(['/models/model-1', '/models/model-42', '/models/model-20', '/models/model-3']);
});

test('deal rows keep compact, unwrapped mobile pricing', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  expect(css.match(/\.model-deal \{([^}]+)\}/)?.[1]).toContain('flex-wrap: nowrap');
  expect(css.match(/\.model-deal-price \{([^}]+)\}/)?.[1]).toContain('clamp(20px, 5vw, 28px)');
});
