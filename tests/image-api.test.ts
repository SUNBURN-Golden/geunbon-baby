import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { handleApi } from '../lib/api';
import { isImageUrl } from '../lib/image-url';
import type { Env } from '../lib/db';
import { memoryD1 } from './helpers/sqlite';

const image = 'https://scontent.cdninstagram.com/product.jpg?sig=synthetic%2B%2F&x=1&x=2';
const ingest = { source_url: 'https://www.instagram.com/p/image/', account: 'fixture', kind: 'post', text: 'fixture caption', captured_at: '2026-10-21T00:00:00Z' };
const approval = { action: 'approve', model_id: 'model-1', seller_id: 'seller-1', title: '검증 전용', price: 123, starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-22T00:00:00Z' };
let memory: ReturnType<typeof memoryD1>;
let env: Env;
const call = (path: string, body?: unknown) => handleApi(new Request(`https://local.invalid/${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${path === 'ingest' ? env.INGEST_TOKEN : env.ADMIN_TOKEN}` },
  body: body === undefined ? undefined : JSON.stringify(body),
}), path.split('/'), env);
async function migrate(files?: string[]) {
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of files ?? (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    for (const statement of sql.split(';').filter(s => s.trim())) await env.DB.prepare(statement).run();
  }
}
beforeEach(async () => {
  memory = memoryD1();
  env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'fixture-admin', INGEST_TOKEN: 'fixture-ingest' };
  await migrate();
  await env.DB.prepare("INSERT INTO models VALUES ('model-1','Stokke','fixture','high_chair','fixture',100,'https://example.com/','2026-10-20','manual','')").run();
  await env.DB.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','fixture','https://example.com/')").run();
});
afterEach(() => memory.close());
async function create(patch: Record<string, unknown> = {}) {
  const response = await call('ingest', { ...ingest, image_url: image, ...patch });
  expect(response.status).toBe(202);
  return (await response.json<{ data: { id: string; status: string } }>()).data;
}
async function publicDeals(path: string) {
  const response = await (await call(path)).json<{ data: { image_url: string | null; comparison?: { gonggu: { image_url: string | null }[] } } | { image_url: string | null }[] }>();
  return Array.isArray(response.data) ? response.data : response.data.comparison!.gonggu;
}
const publicPaths = ['deals', 'calendar', 'models/model-1'];

const invalidImages: unknown[] = [false, 1, {}, [], '', 'http://cdninstagram.com/a.jpg', '//cdninstagram.com/a.jpg',
  'https://cdninstagram.com.evil.example/a.jpg', 'https://evilcdninstagram.com/a.jpg', 'https://fbcdn.net.evil.example/a.jpg',
  'https://example.com/a.jpg', 'https://@cdninstagram.com/a.jpg', 'https://user:password@cdninstagram.com/a.jpg', 'https://cdninstagram.com:8443/a.jpg',
  'https://cdninstagram.com/a.jpg#fragment', 'https://cdninstagram.com/a.jpg#', 'https://cdninstagram.com/a.jpg\n',
  'https://cdninstagram.com\\@evil.example/a.jpg', 'blob:https://cdninstagram.com/id', '/local/story.png',
  'https://cdninstagram.com/' + 'a'.repeat(4096),
];
test('URL validation rejects malformed URLs with generic responses and no echoed URL', async () => {
  for (const image_url of invalidImages) {
    expect(isImageUrl(image_url)).toBe(false);
    const response = await call('ingest', { ...ingest, image_url });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '잘못된 입력' });
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM ingested_items').first()).toEqual({ n: 0 });
});

test('valid CDN host boundaries, standard ports and maximum URL length are accepted unchanged', async () => {
  const prefix = 'https://cdninstagram.com/';
  for (const [n, image_url] of [image, 'https://cdninstagram.com/a.jpg', 'https://fbcdn.net/a.jpg', 'https://a.b.fbcdn.net:443/a.jpg?x=%2b&x=%2F', prefix + 'a'.repeat(4096 - prefix.length)].entries()) {
    expect(isImageUrl(image_url)).toBe(true);
    const item = await create({ source_url: `https://instagram.com/p/valid-${n}/`, image_url });
    expect(await env.DB.prepare('SELECT image_url FROM ingested_items WHERE id = ?').bind(item.id).first()).toEqual({ image_url });
  }
});

test.each([undefined, null])('legacy payload with image %s stays accepted and publishes NULL', async image_url => {
  const item = await create({ image_url });
  expect(await env.DB.prepare('SELECT image_url FROM ingested_items WHERE id = ?').bind(item.id).first()).toEqual({ image_url: null });
  expect((await call(`admin/review/${item.id}`, approval)).status).toBe(200);
  for (const path of publicPaths) expect(await publicDeals(path)).toMatchObject([{ image_url: null }]);
});

test('pending images are private; duplicate ingestion never overwrites stored text or image', async () => {
  const item = await create();
  expect(await create({ image_url: 'https://fbcdn.net/other.jpg', text: 'replacement' })).toEqual(item);
  expect(await create({ image_url: null })).toEqual(item);
  expect(await env.DB.prepare('SELECT image_url,text FROM ingested_items WHERE id = ?').bind(item.id).first()).toEqual({ image_url: image, text: ingest.text });
  const queue = await (await call('admin/queue')).json<{ data: { image_url: string }[] }>();
  expect(queue.data).toMatchObject([{ image_url: image }]);
  for (const path of publicPaths) expect(await publicDeals(path)).toEqual([]);
  const unauthorized = await handleApi(new Request('https://local.invalid/admin/queue'), ['admin', 'queue'], env);
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.text()).not.toContain(image);
});

test.each([undefined, true, false])('approval include_image=%s publishes only the stored choice through every public path', async include_image => {
  const item = await create();
  const response = await call(`admin/review/${item.id}`, { ...approval, include_image });
  expect(response.status).toBe(200);
  for (const path of publicPaths) expect(await publicDeals(path)).toMatchObject([{ image_url: include_image === false ? null : image }]);
  expect(await env.DB.prepare('SELECT status,image_url FROM ingested_items WHERE id = ?').bind(item.id).first()).toEqual({ status: 'approved', image_url: image });
  expect(await create({ image_url: 'https://fbcdn.net/other.jpg' })).toEqual({ id: item.id, status: 'approved' });
  expect((await call(`admin/review/${item.id}`, approval)).status).toBe(409);
});

test('malformed include_image and replacement URLs cannot publish an image', async () => {
  const item = await create();
  for (const include_image of [null, 'true', 'false', 0, 1, [], {}]) {
    expect((await call(`admin/review/${item.id}`, { ...approval, include_image })).status).toBe(400);
  }
  for (const image_url of [null, image, 'https://fbcdn.net/replacement.jpg']) {
    expect((await call(`admin/review/${item.id}`, { ...approval, image_url })).status).toBe(400);
  }
  expect(await env.DB.prepare('SELECT status FROM ingested_items WHERE id = ?').bind(item.id).first()).toEqual({ status: 'pending' });
  expect(await publicDeals('deals')).toEqual([]);
});

test('rejection keeps stored images private across every public path and subsequent duplicates', async () => {
  const item = await create();
  expect((await call(`admin/review/${item.id}`, { action: 'reject' })).status).toBe(200);
  for (const path of publicPaths) expect(await publicDeals(path)).toEqual([]);
  expect(await create({ image_url: null })).toEqual({ id: item.id, status: 'rejected' });
  expect((await call(`admin/review/${item.id}`, approval)).status).toBe(409);
});

test('approval rolls back deal/image insertion when the review-state update fails', async () => {
  const item = await create();
  await env.DB.prepare("CREATE TRIGGER fail_review BEFORE UPDATE ON ingested_items WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
  await expect(call(`admin/review/${item.id}`, approval)).rejects.toThrow('fixture failure');
  expect(await env.DB.prepare('SELECT status,image_url FROM ingested_items WHERE id = ?').bind(item.id).first()).toEqual({ status: 'pending', image_url: image });
  for (const path of publicPaths) expect(await publicDeals(path)).toEqual([]);
  await env.DB.prepare('DROP TRIGGER fail_review').run();
  expect((await call(`admin/review/${item.id}`, approval)).status).toBe(200);
});

test('add-only image migration preserves populated pre-change rows with NULL images', async () => {
  memory.close(); memory = memoryD1(); env.DB = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  const previous = (await readdir(dir)).filter(f => f.endsWith('.sql') && f < '0003').sort();
  await migrate(previous);
  await env.DB.prepare("INSERT INTO models VALUES ('model-1','Stokke','fixture','high_chair','fixture',100,'https://example.com/','2026-10-20','manual','')").run();
  await env.DB.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','fixture','https://example.com/')").run();
  for (const status of ['pending', 'rejected', 'approved']) {
    await env.DB.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,status,suggestions) VALUES (?,?,?,?,?,?,?,?)')
      .bind(status, `https://instagram.com/p/${status}/`, 'fixture', 'preserved', 'post', ingest.captured_at, status, '{}').run();
  }
  await env.DB.prepare("INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at) VALUES ('approved','model-1','seller-1','preserved',123,'https://instagram.com/p/approved/','manual',?,?,?)")
    .bind(ingest.captured_at, approval.starts_at, approval.ends_at).run();
  await migrate(['0003_image_url.sql']);
  const rows = await env.DB.prepare('SELECT id,text,status,suggestions,image_url FROM ingested_items ORDER BY id').all();
  expect(rows.results).toEqual(['approved', 'pending', 'rejected'].map(id => ({ id, status: id, text: 'preserved', suggestions: '{}', image_url: null })));
  expect(await env.DB.prepare('SELECT title,price,image_url FROM deals').first()).toEqual({ title: 'preserved', price: 123, image_url: null });
});
