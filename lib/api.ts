import { all, type Env } from './db';
import { comparison, type Model, type Deal } from './data';
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
export async function authorized(request: Request, token?: string) {
  if (!token) return false;
  const supplied = request.headers.get('authorization') ?? '';
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(supplied), digest(`Bearer ${token}`)]);
  return a.reduce((n, v, i) => n | (v ^ b[i]), 0) === 0;
}
export const safeUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
};
const text = (v: unknown, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32768) { await reader.cancel(); throw new Error('body'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function handleApi(request: Request, parts: string[], env: Env): Promise<Response> {
  const path = parts.join('/');
  const admin = parts[0] === 'admin';
  if (admin || path === 'ingest') {
    const token = admin ? env.ADMIN_TOKEN : env.INGEST_TOKEN;
    if (!token) return json({ error: '서비스 토큰 미설정' }, 503);
    if (!await authorized(request, token)) return json({ error: '인증 필요' }, 401);
  }
  if (request.method === 'GET') {
    if (path === 'brands') return json({ data: await all(env.DB, 'SELECT brand AS name, COUNT(*) AS model_count FROM models GROUP BY brand ORDER BY brand') });
    if (path === 'models') {
      const u = new URL(request.url); const brand = u.searchParams.get('brand'); const category = u.searchParams.get('category');
      return json({ data: await all(env.DB, 'SELECT * FROM models WHERE (? = \'\' OR brand = ?) AND (? = \'\' OR category = ?) ORDER BY rowid', brand ?? '', brand ?? '', category ?? '', category ?? '') });
    }
    if (parts[0] === 'models' && parts.length === 2) {
      const model = await env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(parts[1]).first<Model>();
      if (!model) return json({ error: '모델을 찾을 수 없습니다' }, 404);
      const deals = await all<Deal>(env.DB, 'SELECT * FROM deals WHERE model_id = ? ORDER BY starts_at', model.id);
      return json({ data: { ...model, comparison: comparison(model, deals) } });
    }
    if (path === 'deals' || path === 'calendar') return json({ data: (await all<Deal>(env.DB, 'SELECT * FROM deals ORDER BY starts_at')).map(d => ({ ...d, advertisement: true, notice: '아가마중은 거래 당사자가 아닙니다.' })) });
    if (path === 'sellers') return json({ data: await all(env.DB, 'SELECT * FROM sellers ORDER BY name') });
    if (path === 'admin/queue') return json({ data: await all(env.DB, "SELECT * FROM ingested_items WHERE status = 'pending' ORDER BY captured_at LIMIT 100") });
  }
  if (request.method === 'POST' && (path === 'ingest' || (admin && parts.length === 3 && parts[1] === 'review'))) {
    let b;
    try { b = await body(request); } catch { return json({ error: '32KB 이하 JSON 필요' }, 400); }
    if (!b || typeof b !== 'object') return json({ error: '잘못된 입력' }, 400);
    if (path === 'ingest') {
      if (!safeUrl(b.source_url) || !text(b.account, 100) || !text(b.text, 20000) || !['post', 'story'].includes(b.kind) || !date(b.captured_at)) return json({ error: 'source_url, account, text, kind, captured_at 확인 필요' }, 400);
      const u = new URL(b.source_url);
      if (!['www.instagram.com', 'instagram.com'].includes(u.hostname) || u.protocol !== 'https:' || u.search || u.hash || !/^\/(p|reel)\/[A-Za-z0-9_-]+\/?$|^\/stories\/[A-Za-z0-9._]+\/[0-9]+\/?$/.test(u.pathname)) return json({ error: 'Instagram 원문 URL 필요' }, 400);
      const canonical = `https://www.instagram.com${u.pathname.replace(/\/$/, '')}/`;
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_url) DO NOTHING').bind(id, canonical, b.account, b.text, b.kind, new Date(b.captured_at).toISOString()).run();
      const item = await env.DB.prepare('SELECT id,status FROM ingested_items WHERE source_url = ?').bind(canonical).first();
      return json({ data: item }, 202);
    }
    if (!['approve', 'reject'].includes(b.action)) return json({ error: 'approve 또는 reject 필요' }, 400);
    const item = await env.DB.prepare('SELECT * FROM ingested_items WHERE id = ?').bind(parts[2]).first<{ status: string; source_url: string }>();
    if (!item) return json({ error: '항목 없음' }, 404);
    if (item.status !== 'pending') return json({ error: '이미 검수된 항목' }, 409);
    const now = new Date().toISOString();
    if (b.action === 'reject') {
      const result = await env.DB.prepare("UPDATE ingested_items SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'").bind(now, parts[2]).run();
      return json({ data: { changed: result.meta.changes } });
    }
    if (!text(b.model_id) || !text(b.seller_id) || !text(b.title, 200) || !(b.price === null || (Number.isSafeInteger(b.price) && b.price >= 0)) || !date(b.starts_at) || !date(b.ends_at) || Date.parse(b.ends_at) <= Date.parse(b.starts_at)) return json({ error: '모델·판매자·제목·가격(null 허용)·ISO 시작/종료일 필요' }, 400);
    const model = await env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(b.model_id).first();
    const seller = await env.DB.prepare('SELECT id FROM sellers WHERE id = ?').bind(b.seller_id).first();
    if (!model || !seller) return json({ error: '등록된 모델·판매자만 게시할 수 있습니다' }, 400);
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO deals SELECT id, ?, ?, ?, ?, source_url, 'manual', ?, ?, ? FROM ingested_items WHERE id = ? AND status = 'pending' ON CONFLICT(id) DO NOTHING").bind(b.model_id, b.seller_id, b.title, b.price, now, b.starts_at, b.ends_at, parts[2]),
      env.DB.prepare("UPDATE ingested_items SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'").bind(now, parts[2]),
    ]);
    return results[0].meta.changes ? json({ data: { status: 'approved' } }) : json({ error: '이미 검수된 항목' }, 409);
  }
  return json({ error: '지원하지 않는 경로 또는 메서드' }, request.method === 'GET' ? 404 : 405);
}
