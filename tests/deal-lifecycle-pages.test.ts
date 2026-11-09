import { readdir, readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Home from '../app/page';
import DealsPage from '../app/deals/page';
import DealDetail from '../app/deals/[id]/page';
import Models from '../app/models/page';
import ModelDetail from '../app/models/[id]/page';
import Calendar from '../app/calendar/page';
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
  await memory.db.prepare('UPDATE deals SET price = 600000 WHERE id = ?').bind(otherId).run();
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
  pages = await surfaces(); counts(pages, 2);
  for (const html of [pages.home, pages.deals, pages.model, pages.calendar, await render(() => detail(id))]) {
    expect(html).toContain('Revised public title'); expect(html).toContain('234,567'); expect(html).not.toContain('Original public-first');
  }
  expect(pages.models).toContain('234,567'); expect(pages.models).not.toContain('400,000');
  for (const html of [pages.model, pages.calendar, await render(() => detail(id))]) {
    expect(html).toContain('2026-10-21T00:00:00.000Z'); expect(html).toContain('2026-10-29T00:00:00.000Z');
  }
  // Only the second deal still has an image, and the corrected detail has none.
  expect(await render(() => detail(id))).not.toContain('original.jpg');
  data = await publicData();
  for (const path of ['deals','calendar','models/model-1']) expect(data[path].find(d => d.id === id)).toMatchObject({ title: 'Revised public title', price: 234567, image_url: null, starts_at: '2026-10-21T00:00:00.000Z', ends_at: '2026-10-29T00:00:00.000Z' });
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

test('model moves, image restoration and changed schedules reach all applicable surfaces', async () => {
  expect((await call(`admin/deals/${id}`, edit({ model_id: 'model-2', include_image: true }))).status).toBe(200);
  let data = await publicData();
  expect(data['models/model-1'].map(d => d.id)).not.toContain(id);
  expect(data['models/model-2'].map(d => d.id)).toContain(id);
  for (const path of ['deals','calendar','models/model-2']) expect(data[path].find(d => d.id === id)?.image_url).toBe('https://cdninstagram.com/original.jpg?sig=offline%2B');
  expect(await render(() => model())).not.toContain('Revised public title');
  expect(await render(() => model('model-2'))).toContain('Revised public title');
  const page = await render(() => detail(id)); expect(page).toContain('Other model'); expect(page).toContain('/models/model-2'); expect(page).toContain('original.jpg');
  expect(await render(Home)).toContain('alt="Other model 상품 이미지"');
  expect(await render(DealsPage)).toContain('alt="Other model 상품 이미지"');
  // A corrected future schedule removes the deal from active-price cards and counts.
  expect((await call(`admin/deals/${id}`, edit({ expected_version: 2, model_id: 'model-2', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-02T00:00:00Z' }))).status).toBe(200);
  const pages = await surfaces(); counts(pages, 1); expect(pages.home).not.toContain('Revised public title');
  expect(pages.models).not.toContain('234,567'); expect(pages.deals).toContain('Revised public title'); expect(pages.calendar).toContain('2026-11-01T00:00:00.000Z');
  data = await publicData(); expect(data.deals.find(d => d.id === id)?.starts_at).toBe('2026-11-01T00:00:00.000Z');
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
    if (file.pathname.endsWith('/lib/promote-external.ts') || file.pathname.endsWith('/lib/deal-bundles.ts')) continue;
    let source = await readFile(file, 'utf8');
    if (file.pathname.endsWith('/lib/api.ts')) {
      source = source.replace(/\/\/ Admin lifecycle reads[\s\S]*?(?=\/\/ ── 크롤러)/, '');
      // Everything after this point is the authenticated review branch.
      source = source.slice(0, source.indexOf("    if (!['approve', 'reject']"));
    }
    if (file.pathname.endsWith('/lib/deals.ts')) {
      source = source.replace(/export const PUBLISHED_DEALS = `[\s\S]*?`;/, '').replace(/export const DEAL_SELECT = `[\s\S]*?`;/, '');
    }
    expect(source, file.pathname).not.toMatch(/\bFROM\s+deals\b/i);
  }
});
