import { seedPublicPrice } from './helpers/public-deal-fixture';
import { readdir, readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Home from '../app/page';
import DealsPage from '../app/deals/page';
import DealDetail from '../app/deals/[id]/page';
import Models from '../app/models/page';
import ModelDetail from '../app/models/[id]/page';
import Calendar from '../app/calendar/page';
import { GET as rss } from '../app/rss.xml/route';
import type { Deal } from '../lib/data';
import { memoryD1 } from './helpers/sqlite';
import { api, migrate, publish } from './helpers/deal-timestamps';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({ ...await importOriginal<typeof import('../lib/db')>(), environment: () => ({ DB: context.db }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
let memory: ReturnType<typeof memoryD1>, call: ReturnType<typeof api>, id: string, otherId: string;
const detail = (dealId: string) => DealDetail({ params: Promise.resolve({ id: dealId }) });
const model = (modelId = 'model-1') => ModelDetail({ params: Promise.resolve({ id: modelId }) });
const models = () => Models({ searchParams: Promise.resolve({}) });
const render = async (fn: () => Promise<React.ReactNode>) => renderToStaticMarkup(await fn());
const edit = (fields: Record<string, unknown> = {}) => ({ action: 'correct', expected_version: 1, request_id: crypto.randomUUID(), reason: 'Private correction reason reviewed offline', model_id: 'model-1', title: 'Revised public title', price: 234567, starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-29T00:00:00Z', include_image: false, ...fields });
const withdraw = (version: number) => ({ action: 'withdraw', expected_version: version, request_id: crypto.randomUUID(), reason: 'Private withdrawal reason reviewed offline' });
async function publicData() {
  const result: Record<string, Deal[]> = {};
  for (const path of ['deals', 'calendar', 'models/model-1', 'models/model-2']) {
    const response = await call(path); expect(response.status).toBe(200);
    const payload = await response.json<{ data: Deal[] | { comparison: { gonggu: Deal[] } } }>();
    const assertNoPrivate = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(['status','version','updated_at','withdrawn_at','reason','request_id','request_hash','revisions','evidence']).not.toContain(key);
        assertNoPrivate(child);
      }
    };
    assertNoPrivate(payload);
    result[path] = Array.isArray(payload.data) ? payload.data : payload.data.comparison.gonggu;
  }
  return result;
}
async function surfaces() {
  return { home: await render(Home), deals: await render(DealsPage), models: await render(models), model: await render(() => model()), calendar: await render(Calendar) };
}
function counts(pages: { home: string; deals: string }, count: number) {
  for (const html of [pages.home, pages.deals]) expect(html).toContain(`aria-label="${count}개 진행 중이에요">${count}</span>`);
}
beforeEach(async () => {
  memory = memoryD1({ serialize: true }); context.db = memory.db; call = api(memory.db);
  await migrate(memory.db);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-24T00:00:00Z'));
  id = (await publish(memory.db, 'public-first')).id;
  otherId = (await publish(memory.db, 'public-second')).id;
  await seedPublicPrice(memory.db, id, 400000, 500000);
  await seedPublicPrice(memory.db, otherId, 600000, 700000);
  await memory.db.prepare("INSERT INTO models SELECT 'model-2',brand,'Other model',category,importer,official_price,source_url,checked,verify_level,note FROM models WHERE id = 'model-1'").run();
});
afterEach(() => memory.close());

test('every public surface follows corrections and withdrawals and public JSON stays private', async () => {
  let pages = await surfaces(); counts(pages, 2);
  for (const html of [pages.home, pages.deals, pages.model, pages.calendar, await render(() => detail(id))]) expect(html).toContain('Original public-first');
  expect(pages.models).toContain('400,000');
  let data = await publicData();
  for (const path of ['deals','calendar','models/model-1']) expect(data[path].map(d => d.id)).toContain(id);
  const correction = edit();
  expect((await call(`admin/deals/${id}`, correction)).status).toBe(200);
  pages = await surfaces(); counts(pages, 1);
  for (const html of Object.values(pages)) expect(html).not.toContain('Revised public title');
  await expect(detail(id)).rejects.toThrow('NEXT_NOT_FOUND');
  data = await publicData();
  for (const rows of Object.values(data)) expect(rows.map(row => row.id)).not.toContain(id);
  const admin = await (await call(`admin/deals/${id}`)).json<{ data: Deal }>();
  expect(admin.data).toMatchObject({ title: 'Revised public title', price: 234567, image_url: null, starts_at: '2026-10-21T00:00:00.000Z', ends_at: '2026-10-29T00:00:00.000Z' });
  expect((await call(`admin/deals/${id}`, withdraw(2))).status).toBe(200);
  pages = await surfaces(); counts(pages, 1);
  for (const html of Object.values(pages)) { expect(html).not.toContain('Revised public title'); expect(html).not.toContain('234,567'); }
  for (const html of [pages.home, pages.deals, pages.model, pages.calendar]) expect(html).toContain('Original public-second');
  expect(pages.models).toContain('600,000');
  await expect(detail(id)).rejects.toThrow('NEXT_NOT_FOUND'); await expect(detail('unknown')).rejects.toThrow('NEXT_NOT_FOUND');
  data = await publicData();
  for (const rows of Object.values(data)) expect(rows.map(d => d.id)).not.toContain(id);
  expect((await call(`admin/deals/${otherId}`, withdraw(1))).status).toBe(200);
  pages = await surfaces(); counts(pages, 0);
  expect(pages.models).toContain('진행 중인 공구 없음'); expect(pages.models).not.toContain('600,000');
  for (const html of Object.values(pages)) expect(html).not.toContain('Original public-second');
  for (const rows of Object.values(await publicData())) expect(rows).toEqual([]);
});

test('a model and schedule correction retains the original image for admin and awaits new evidence', async () => {
  expect((await call(`admin/deals/${id}`, edit({ model_id: 'model-2', include_image: true }))).status).toBe(200);
  const data = await publicData();
  for (const rows of Object.values(data)) expect(rows.map(row => row.id)).not.toContain(id);
  const admin = await (await call(`admin/deals/${id}`)).json<{ data: Deal }>();
  expect(admin.data).toMatchObject({ model_id: 'model-2', image_url: 'https://cdninstagram.com/original.jpg?sig=offline%2B', price: 234567 });
  await expect(detail(id)).rejects.toThrow('NEXT_NOT_FOUND');
});

test('public source reads use only the shared published projections', async () => {
  async function scan(dir: URL): Promise<URL[]> {
    const files: URL[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'admin') continue;
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) files.push(...await scan(path)); else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
    return files;
  }
  for (const file of [...await scan(new URL('../app/', import.meta.url)), ...await scan(new URL('../lib/', import.meta.url))]) {
    if (['promote-external', 'deal-bundles', 'deal-price-review', 'verified-offers'].some(name => file.pathname.endsWith(`/lib/${name}.ts`))) continue;
    let source = await readFile(file, 'utf8');
    if (file.pathname.endsWith('/lib/api.ts')) {
      source = source.replace(/\/\/ Admin lifecycle reads[\s\S]*?(?=\/\/ ── 크롤러)/, '');
      source = source.replace(/async function manageDeal[\s\S]*?(?=\nexport async function handleApi)/, '');
      // Everything after this point is the authenticated review branch.
      source = source.slice(0, source.indexOf("    if (!['approve', 'reject']"));
    }
    if (file.pathname.endsWith('/lib/deals.ts')) {
      // This is the sole designated implementation of public bounded reads.
      // Its helpers/projections/withdrawal behavior are exercised against real D1 SQL.
      source = source.slice(0, source.indexOf('// Public historical queries'));
      source = source.replace(/const publishedDeals = [^`]+`[\s\S]*?`;/, '').replace(/export const dealSelect = [^`]+`[\s\S]*?`;/, '');
    }
    expect(source, file.pathname).not.toMatch(/\bFROM\s+deals\b/i);
  }
});

test('24-hour official proof expiry during an outage hides public surfaces and a fresh check recovers them', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const T0 = Date.parse('2026-10-24T00:00:00.000Z');
    vi.setSystemTime(T0);
    // Re-seed under the fixed clock so price_checked_at is exactly T0.
    await seedPublicPrice(memory.db, id, 400000, 500000);
    await seedPublicPrice(memory.db, otherId, 600000, 700000);
    let pages = await surfaces();
    counts(pages, 2);
    expect((await (await rss()).text())).toContain(id);

    // The crawler is down: no revists, only wall-clock time advances past 24h.
    vi.setSystemTime(T0 + 86_400_000 + 1);
    pages = await surfaces();
    counts(pages, 0);
    await expect(detail(id)).rejects.toThrow('NEXT_NOT_FOUND');
    expect((await (await rss()).text())).not.toContain(id);
    expect(pages.models).toContain('진행 중인 공구 없음');

    // Recovery after restart: a successful official check refreshes the proof.
    vi.setSystemTime(T0 + 86_400_000 + 2000);
    await seedPublicPrice(memory.db, id, 400000, 500000);
    pages = await surfaces();
    counts(pages, 1);
    expect(await render(() => detail(id))).toContain('Original public-first');
    expect((await (await rss()).text())).toContain(id);
    expect(pages.models).toContain('400,000');
  } finally { vi.useRealTimers(); }
});

test('an orders-open end-only deal is active through its inclusive deadline on every surface', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const T0 = Date.parse('2026-10-24T00:00:00.000Z');
    vi.setSystemTime(T0);
    const end = new Date(T0 + 2 * 3_600_000).toISOString();
    await memory.db.prepare("UPDATE deals SET starts_at = NULL, ends_at = ?, orders_open = 1 WHERE id = ?").bind(end, id).run();
    await memory.db.prepare("UPDATE deals SET status = 'withdrawn' WHERE id = ?").bind(otherId).run();
    await memory.db.prepare("INSERT OR IGNORE INTO ingested_items (id,source_url,account,text,kind,captured_at,status) VALUES (?,?,?,?,?,?,'approved')")
      .bind(id, `https://fixture.example/offers/${encodeURIComponent(id)}`, 'fixture', 'fixture', 'post', '2026-10-20T16:00:00.000Z').run();
    await seedPublicPrice(memory.db, id, 400000, 500000);
    const snapshot = async () => ({
      home: await render(Home), deals: await render(DealsPage),
      discount: await render(() => DealsPage({ searchParams: Promise.resolve({ sort: 'discount' }) })),
      ending: await render(() => DealsPage({ searchParams: Promise.resolve({ sort: 'ending' }) })),
      calendar: await render(Calendar), model: await render(() => model()), models: await render(models),
      detail: await render(() => detail(id)), feed: await (await rss()).text(),
    });

    let pages = await snapshot();
    counts(pages, 1);
    for (const html of [pages.home, pages.deals, pages.calendar, pages.model, pages.detail]) expect(html).toContain('Original public-first');
    expect(pages.feed).toContain(id);
    expect(pages.models).toContain('400,000');
    for (const html of [pages.discount, pages.ending]) { expect(html).toContain('id="deals-active"'); expect(html).not.toContain('id="deals-ended"'); }

    // The deadline is inclusive: still active exactly at ends_at.
    vi.setSystemTime(Date.parse(end));
    pages = await snapshot();
    counts(pages, 1);
    expect(pages.feed).toContain(id);

    // One millisecond later it moves out of active everywhere, while an
    // eligible ended deal remains in history and on its detail page.
    vi.setSystemTime(Date.parse(end) + 1);
    pages = await snapshot();
    counts(pages, 0);
    expect(pages.feed).not.toContain(id);
    expect(pages.models).toContain('진행 중인 공구 없음');
    expect(pages.detail).toContain('종료');
    expect(pages.deals).toContain('id="deals-ended"');
    expect(pages.discount).toContain('id="deals-ended"');
    expect(pages.ending).toContain('id="deals-ended"');
  } finally { vi.useRealTimers(); }
});
