import { isImageUrl } from './image-url';
import { all, type Env } from './db';
import { dealsCopy } from './deals-copy';
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

// Seed notes can contain retailer, discount, overseas and used prices.
// Keep them out of every public model response, including comparisons.
const PUBLIC_MODEL_COLUMNS = 'id, brand, name, category, importer, official_price, source_url, checked, verify_level';

// ── 크롤러 자동 추출 제안(검수 보조용, 승인 전까지 게시 데이터와 무관) ─────────────
export type Suggestions = {
  models: { model_id: string; brand: string; name: string; matched: string[]; confidence: number }[];
  price: { value: number; raw: string; confidence: number } | null;
  dates: { starts_at: string | null; ends_at: string | null; raw: string; confidence: number } | null;
  links: { url: string; kind: 'url' | 'link_in_bio'; confidence: number }[];
  confidence: number;
};
const confidence = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function parseSuggestions(value: unknown): Suggestions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 8000) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.models) || v.models.length > 10 || !confidence(v.confidence)) return null;
  const models: Suggestions['models'] = [];
  for (const raw of v.models) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (!text(m.model_id, 120) || !text(m.brand, 120) || !text(m.name, 120) || !Array.isArray(m.matched) || m.matched.length > 8 || !m.matched.every((x: unknown) => text(x, 60)) || !confidence(m.confidence)) return null;
    models.push({ model_id: m.model_id as string, brand: m.brand as string, name: m.name as string, matched: m.matched as string[], confidence: m.confidence as number });
  }
  let price: Suggestions['price'] = null;
  if (v.price != null) {
    if (!v.price || typeof v.price !== 'object' || Array.isArray(v.price)) return null;
    const p = v.price as Record<string, unknown>;
    if (!Number.isSafeInteger(p.value) || (p.value as number) < 0 || (p.value as number) > 1e9 || !text(p.raw, 120) || !confidence(p.confidence)) return null;
    price = { value: p.value as number, raw: p.raw as string, confidence: p.confidence as number };
  }
  let dates: Suggestions['dates'] = null;
  if (v.dates != null) {
    if (!v.dates || typeof v.dates !== 'object' || Array.isArray(v.dates)) return null;
    const d = v.dates as Record<string, unknown>;
    if (!text(d.raw, 200) || !confidence(d.confidence) || (d.starts_at != null && !date(d.starts_at)) || (d.ends_at != null && !date(d.ends_at))) return null;
    dates = { starts_at: (d.starts_at as string) ?? null, ends_at: (d.ends_at as string) ?? null, raw: d.raw as string, confidence: d.confidence as number };
  }
  if (!Array.isArray(v.links) || v.links.length > 10) return null;
  const links: Suggestions['links'] = [];
  for (const raw of v.links) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const l = raw as Record<string, unknown>;
    if (l.kind !== 'url' && l.kind !== 'link_in_bio') return null;
    if (l.kind === 'url' ? !safeUrl(l.url) : l.url !== '') return null; // link_in_bio 는 빈 url(원문 프로필로 직접 확인)
    if (!confidence(l.confidence)) return null;
    links.push({ url: l.url as string, kind: l.kind, confidence: l.confidence as number });
  }
  return { models, price, dates, links, confidence: v.confidence as number };
}
export function parseStoredSuggestions(value: string | null): Suggestions | null {
  try { return value ? parseSuggestions(JSON.parse(value)) : null; }
  catch { return null; }
}
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
      return json({ data: await all(env.DB, `SELECT ${PUBLIC_MODEL_COLUMNS} FROM models WHERE (? = '' OR brand = ?) AND (? = '' OR category = ?) ORDER BY rowid`, brand ?? '', brand ?? '', category ?? '', category ?? '') });
    }
    if (parts[0] === 'models' && parts.length === 2) {
      const model = await env.DB.prepare(`SELECT ${PUBLIC_MODEL_COLUMNS} FROM models WHERE id = ?`).bind(parts[1]).first<Omit<Model, 'note'>>();
      if (!model) return json({ error: '모델을 찾을 수 없습니다' }, 404);
      const deals = await all<Deal>(env.DB, 'SELECT * FROM deals WHERE model_id = ? ORDER BY starts_at', model.id);
      return json({ data: { ...model, comparison: comparison(model, deals) } });
    }
    if (path === 'deals' || path === 'calendar') return json({ data: (await all<Deal>(env.DB, 'SELECT * FROM deals ORDER BY starts_at')).map(d => ({ ...d, advertisement: true, notice: dealsCopy.apiNotice })) });
    if (path === 'sellers') return json({ data: await all(env.DB, 'SELECT * FROM sellers ORDER BY name') });
    if (path === 'admin/queue') return json({ data: await all(env.DB, "SELECT * FROM ingested_items WHERE status = 'pending' ORDER BY captured_at LIMIT 100") });
  }
  if (request.method === 'POST' && (path === 'ingest' || (admin && parts.length === 3 && parts[1] === 'review'))) {
    let b;
    try { b = await body(request); } catch { return json({ error: '32KB 이하 JSON 필요' }, 400); }
    if (!b || typeof b !== 'object') return json({ error: '잘못된 입력' }, 400);
    if (path === 'ingest') {
      if (!safeUrl(b.source_url) || !text(b.account, 100) || !text(b.text, 20000) || !['post', 'story'].includes(b.kind) || !date(b.captured_at)) return json({ error: 'source_url, account, text, kind, captured_at 확인 필요' }, 400);
      if (b.image_url != null && !isImageUrl(b.image_url)) return json({ error: '잘못된 입력' }, 400);
      let suggestions: string | null = null;
      if (b.suggestions != null) {
        const parsed = parseSuggestions(b.suggestions);
        if (!parsed) return json({ error: 'suggestions 형식 확인 필요(모델·가격·일정·링크·신뢰도 스키마)' }, 400);
        suggestions = JSON.stringify(parsed);
      }
      const u = new URL(b.source_url);
      if (!['www.instagram.com', 'instagram.com'].includes(u.hostname) || u.protocol !== 'https:' || u.search || u.hash || !/^\/(p|reel)\/[A-Za-z0-9_-]+\/?$|^\/stories\/[A-Za-z0-9._]+\/[0-9]+\/?$/.test(u.pathname)) return json({ error: 'Instagram 원문 URL 필요' }, 400);
      const canonical = `https://www.instagram.com${u.pathname.replace(/\/$/, '')}/`;
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,suggestions,image_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_url) DO NOTHING').bind(id, canonical, b.account, b.text, b.kind, new Date(b.captured_at).toISOString(), suggestions, b.image_url ?? null).run();
      const item = await env.DB.prepare('SELECT id,status FROM ingested_items WHERE source_url = ?').bind(canonical).first();
      return json({ data: item }, 202);
    }
    if (!['approve', 'reject'].includes(b.action)) return json({ error: 'approve 또는 reject 필요' }, 400);
    if ((b.include_image !== undefined && typeof b.include_image !== 'boolean') || 'image_url' in b) return json({ error: '잘못된 입력' }, 400);
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
      env.DB.prepare("INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url) SELECT id, ?, ?, ?, ?, source_url, 'manual', ?, ?, ?, CASE WHEN ? THEN image_url ELSE NULL END FROM ingested_items WHERE id = ? AND status = 'pending' ON CONFLICT(id) DO NOTHING").bind(b.model_id, b.seller_id, b.title, b.price, now, b.starts_at, b.ends_at, b.include_image === false ? 0 : 1, parts[2]),
      env.DB.prepare("UPDATE ingested_items SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'").bind(now, parts[2]),
    ]);
    return results[0].meta.changes ? json({ data: { status: 'approved' } }) : json({ error: '이미 검수된 항목' }, 409);
  }
  return json({ error: '지원하지 않는 경로 또는 메서드' }, request.method === 'GET' ? 404 : 405);
}
