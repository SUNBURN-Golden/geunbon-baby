import { seedPublicPrice } from './helpers/public-deal-fixture';
import { readdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import ModelDetail from '../app/models/[id]/page';
import { DealCard, DealDetail } from '../app/deals/_components';
import { verification, verificationLabel, unknownVerification } from '../lib/data';
import { dealSelect, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

const nowMs = Date.parse('2026-10-21T03:00:00Z');
const note = 'Retailer 123,456원; older official 654,321원; parts 234,567원; overseas $799';
const levels = [
  ['page_body', verification.page_body],
  ['page_text', verification.page_text],
  ['search_summary', verification.search_summary],
  ['seed_unspecified', verification.seed_unspecified],
  ['manual', verification.manual],
  ['official_unpublished', verification.official_unpublished],
  ['legacy_x', unknownVerification],
  ['constructor', unknownVerification],
  ['toString', unknownVerification],
  ['', unknownVerification],
] as const;

test('uncertainty copy contains explicit missing information without claiming non-disclosure', () => {
  for (const value of [...Object.values(verification), ...Object.values(dealsCopy)]) {
    expect(value).not.toMatch(/미공개|비공개/);
  }
  for (const value of [verification.official_unpublished, dealsCopy.officialUnconfirmed,
    dealsCopy.unknownOfficial, dealsCopy.unknownPrice]) {
    expect(value).toContain('정보 없음');
  }
  for (const value of [dealsCopy.dealEvidence, dealsCopy.officialEvidence]) {
    expect(value).not.toContain('확인했어요');
  }
  expect(dealsCopy.unknownVerification).toBe(unknownVerification);
});

test.each([...levels, [null, unknownVerification], [undefined, unknownVerification]] as const)(
  'verificationLabel(%s) returns a bounded display label', (level, label) => {
    expect(verificationLabel(level)).toBe(label);
  },
);

describe('D1-backed price and evidence rendering', () => {
  const memory = memoryD1();
  beforeAll(async () => {
    context.db = memory.db;
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) {
      const schema = await readFile(new URL(file, dir), 'utf8');
      for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
    }
    await memory.db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('model-1', 'Cybex', 'Test stroller', 'stroller', 'Importer', 430000,
        'https://example.com/model', '2026-10-18', 'page_body', note).run();
    await memory.db.prepare("INSERT INTO sellers (id, name, source_url) VALUES ('seller-1', 'Seller', 'https://example.com/seller')").run();
    await memory.db.prepare("INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at, status) VALUES ('deal-1', 'https://example.com/deal', 'example', 'Reviewed deal', 'post', '2026-10-20', 'approved')").run();
    await memory.db.prepare('INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('deal-1', 'model-1', 'seller-1', 'Reviewed group buy', 390000, 'https://example.com/deal',
        'manual', '2026-10-20', '2026-10-20T00:00:00Z', '2026-10-22T00:00:00Z').run();
    await seedPublicPrice(memory.db, 'deal-1', 390000, 440000);
  });
  beforeEach(async () => {
    await memory.db.prepare("UPDATE models SET official_price = 430000, source_url = 'https://example.com/model', verify_level = 'page_body', importer = 'Importer'").run();
    await memory.db.prepare("UPDATE deals SET price = 390000, verify_level = 'manual'").run();
  });
  afterAll(() => memory.close());

  const modelPage = async () => renderToStaticMarkup(await ModelDetail({ params: Promise.resolve({ id: 'model-1' }) }));
  const joinedDeal = async () => (await memory.db.prepare(dealSelect()).first<DealWithContext>())!;
  const officialSection = (html: string) => html.match(/<section><p class="eyebrow">02 \/ OFFICIAL<\/p>[\s\S]*?<\/section>/)![0];
  const excludesPrivatePrices = (html: string) => {
    for (const text of [note, '123,456', '654,321', '234,567', '$799']) expect(html).not.toContain(text);
  };

  test.each(levels)('model and deal card render stored level "%s" safely', async (level, label) => {
    // NOT NULL columns accept strings, including unknown legacy codes and the empty string.
    await memory.db.prepare('UPDATE models SET verify_level = ?').bind(level).run();
    await memory.db.prepare('UPDATE deals SET verify_level = ?').bind(level).run();
    const deal = await joinedDeal();
    const modelHtml = await modelPage();
    expect(modelHtml).toContain(label);
    for (const html of [modelHtml, renderToStaticMarkup(createElement(DealCard, { deal, nowMs }))]) {
      if (level) expect(html).not.toContain(`>${level}<`);
      excludesPrivatePrices(html);
    }
  });

  test.each([
    ['page_body', 430000, '430,000원', verification.page_body],
    ['page_body', 0, '0원', verification.page_body],
    ['official_unpublished', null, '정보 없음', verification.official_unpublished],
  ] as const)('official section preserves %s price %s without substitution', async (level, price, amount, label) => {
    await memory.db.prepare('UPDATE models SET verify_level = ?, official_price = ?').bind(level, price).run();
    const html = await modelPage();
    const section = officialSection(html);
    expect(section).toContain(`<h3>${amount}</h3>`);
    expect(section).toContain(label);
    excludesPrivatePrices(html);
    if (price === null) expect(section).not.toMatch(/\d[\d,]*원/);
  });

  test('failed model official retrieval preserves importer uncertainty and verified deal evidence', async () => {
    // The public fields mirror migration 0008's failed-fetch rows, without importing seed investigations.
    await memory.db.prepare("UPDATE models SET source_url = '', official_price = NULL, verify_level = 'official_unpublished', importer = '기존 수입사 (기존 정보, 재확인 실패)'").run();
    const modelHtml = await modelPage();
    expect(modelHtml).toContain(verification.official_unpublished);
    expect(modelHtml).toContain('정보 없음');
    expect(modelHtml).toContain('기존 정보, 재확인 실패');
    expect(modelHtml).not.toContain('href=""');
    const dealHtml = renderToStaticMarkup(createElement(DealDetail, { deal: await joinedDeal(), nowMs }));
    expect(dealHtml).toContain('<del>440,000원</del>');
    expect(dealHtml).toContain('가격 확인 시각');
    expect(dealHtml).not.toContain(dealsCopy.officialUnconfirmed);
    for (const html of [modelHtml, dealHtml]) {
      expect(html).not.toMatch(/미공개|비공개|>official_unpublished</);
      expect(html).not.toContain('430,000');
      excludesPrivatePrices(html);
    }
  });

  test.each(levels)('verified deal detail is independent of legacy level "%s"', async level => {
    const deal = { ...await joinedDeal(), verify_level: level, model_verify_level: level, model_official_price: null };
    const html = renderToStaticMarkup(createElement(DealDetail, { deal, nowMs }));
    expect(html).toContain('<del>440,000원</del>');
    expect(html).toContain('정가보다 11% 싸요');
    if (level) expect(html).not.toContain(`>${level}<`);
  });
});

test('Workers presentation code keeps seed and investigation records outside its imports', async () => {
  async function checkDirectory(dir: URL): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(entry.name, dir);
      if (entry.isDirectory()) await checkDirectory(new URL(`${entry.name}/`, dir));
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(path, 'utf8');
        const imports = source.match(/\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"][^'"]+['"]|\b(?:import|require)\s*\(\s*['"][^'"]+['"]/g) ?? [];
        for (const statement of imports) expect(statement, path.pathname).not.toMatch(/seed\/|model-evidence/);
      }
    }
  }
  await checkDirectory(new URL('../app/', import.meta.url));
  await checkDirectory(new URL('../lib/', import.meta.url));
});
