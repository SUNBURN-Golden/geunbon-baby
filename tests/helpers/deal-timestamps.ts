import { migrationStatements } from './migrations';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../../lib/api';
import type { Env } from '../../lib/db';

export async function execute(db: D1Database, sql: string) {
  for (const statement of migrationStatements(sql)) await db.prepare(statement).run();
}
export async function migrate(db: D1Database, through = '9999') {
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql') && f.slice(0, 4) <= through).sort()) {
    await execute(db, await readFile(new URL(file, dir), 'utf8'));
  }
  await db.prepare("INSERT INTO models VALUES ('model-1','Test brand','Test model','high_chair','Test importer',NULL,'https://example.com/model','2026-10-20','manual','')").run();
  await db.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','Test seller','https://example.com/seller')").run();
}
export function api(db: D1Database) {
  const env: Env = { DB: db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'timestamp-admin-test-only', INGEST_TOKEN: 'timestamp-ingest-test-only' };
  return (path: string, payload?: unknown) => handleApi(new Request(`http://localhost/api/v1/${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${path === 'ingest' ? env.INGEST_TOKEN : env.ADMIN_TOKEN}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), path.split('?')[0].split('/'), env);
}
export async function pending(db: D1Database, id: string) {
  await db.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES (?,?,?,?,?,?)')
    .bind(id, `https://www.instagram.com/p/${id}/`, 'offline-test', 'Synthetic timestamp fixture', 'post', '2026-10-20T00:00:00.000Z').run();
}
export const approval = (starts_at: string, ends_at: string, title = 'Timestamp fixture') => ({
  action: 'approve', attribution: 'explicit', attribution_note: 'Synthetic fixture attribution reviewed offline', model_id: 'model-1', seller_id: 'seller-1', title, price: null, starts_at, ends_at,
});
export async function legacy(db: D1Database, id: string, start: string, end: string) {
  await pending(db, id);
  await db.prepare("INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at) VALUES (?,'model-1','seller-1',?,NULL,?,'manual','2026-10-20',?,?)")
    .bind(id, `Fixture ${id}`, `https://www.instagram.com/p/${id}/`, start, end).run();
}
export async function publish(db: D1Database, id: string) {
  const call = api(db);
  const ingested = await call('ingest', {
    source_url: `https://www.instagram.com/p/${id}/`, account: 'offline-test', text: `Original evidence ${id}`,
    kind: 'post', captured_at: '2026-10-20T00:00:00Z', image_url: 'https://cdninstagram.com/original.jpg?sig=offline%2B',
  });
  const item = (await ingested.json<{ data: { id: string } }>()).data;
  const response = await call(`admin/review/${item.id}`, { ...approval('2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z', `Original ${id}`), price: 400000 });
  if (response.status !== 200) throw new Error(`Publish failed: ${response.status}`);
  return (await db.prepare('SELECT id,version FROM deals WHERE id = ?').bind(item.id).first<{ id: string; version: number }>())!;
}
