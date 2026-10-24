import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, authenticated: true }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'fixture-admin-token-separation-0001', INGEST_TOKEN: 'fixture-ingest-token-separation-0002' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => context.authenticated ? { value: 'fixture-admin-token-separation-0001' } : undefined }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT'); } }));
const image = 'https://cdninstagram.com/review.jpg?sig=synthetic%2B';
let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  context.authenticated = true;
  memory = memoryD1(); context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    for (const statement of sql.split(';').filter(s => s.trim())) await memory.db.prepare(statement).run();
  }
  await memory.db.prepare("INSERT INTO models (id,brand,name,category,importer,official_price,source_url,checked,verify_level,note) VALUES ('model-1','Stokke','fixture','high_chair','fixture',100,'https://example.com/','2026-10-20','manual','')").run();
  await memory.db.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','fixture','https://example.com/')").run();
  await memory.db.prepare("INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,image_url) VALUES ('fixture','https://instagram.com/p/fixture/','fixture','fixture caption','post','2026-10-21T00:00:00Z',?)").bind(image).run();
});
afterEach(() => memory.close());
function reviewAction(node: ReactNode): (form: FormData) => Promise<void> {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; type?: string; name?: string; action?: (form: FormData) => Promise<void> }>(child)) continue;
    if (child.type === 'form' && Children.toArray(child.props.children).some(input => isValidElement<{ name?: string }>(input) && input.props.name === 'id')) return child.props.action!;
    if (child.props.children) {
      try { return reviewAction(child.props.children); } catch { /* Continue looking in siblings. */ }
    }
  }
  throw new Error('Review form not found');
}

test('preview and checked include-image control are restricted to the authenticated review page', async () => {
  const html = renderToStaticMarkup(await Admin({ searchParams: Promise.resolve({}) }));
  expect(html).toContain(`src="${image}"`);
  expect(html).toMatch(/type="checkbox"[^>]*name="include_image"[^>]*checked=""/);
  expect(html).toContain('이미지 포함');
  expect(html).toContain('referrerPolicy="no-referrer"');
  context.authenticated = false;
  const login = renderToStaticMarkup(await Admin({ searchParams: Promise.resolve({}) }));
  expect(login).not.toContain(image);
  expect(login).not.toContain('include_image');
});

test.each([true, false])('review form submits explicit include_image=%s from checkbox state', async include => {
  const page = await Admin({ searchParams: Promise.resolve({}) });
  const action = reviewAction(page);
  const form = new FormData();
  const values = { id: 'fixture', action: 'approve', attribution: 'explicit', attribution_note: 'Synthetic fixture attribution reviewed offline', model_id: 'model-1', seller_id: 'seller-1', title: 'fixture', price: '', starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-22T00:00:00Z' };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  if (include) form.set('include_image', 'on');
  await expect(action(form)).rejects.toThrow('NEXT_REDIRECT');
  expect(await memory.db.prepare('SELECT image_url FROM deals WHERE id = ?').bind('fixture').first()).toEqual({ image_url: include ? image : null });
});
