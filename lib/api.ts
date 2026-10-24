import { normalizeTimestamp } from './deals';
import { receiveStatus, collectionStatus } from './collection-status';
import { isImageUrl } from './image-url';
import { all, type Env } from './db';
import { dealsCopy } from './deals-copy';
import { comparison, EXTERNAL_SOURCES, type ExternalSourceId, type Model, type Deal } from './data';
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
export const MIN_SERVICE_TOKEN_LENGTH = 24;
// Header values are trimmed in transit; surrounding whitespace usually means a paste error.
const strongToken = (value: unknown): value is string => typeof value === 'string' && value.length >= MIN_SERVICE_TOKEN_LENGTH && value.trim() === value;
export type ServiceTokens = { admin: string; ingest: string };
// Validate the privilege boundary as a pair, including collisions with the optional status token.
export function serviceTokens(env: Pick<Env, 'ADMIN_TOKEN' | 'INGEST_TOKEN' | 'COLLECTOR_STATUS_TOKEN'>): ServiceTokens | null {
  const { ADMIN_TOKEN: admin, INGEST_TOKEN: ingest, COLLECTOR_STATUS_TOKEN: status } = env;
  if (!strongToken(admin) || !strongToken(ingest) || admin === ingest) return null;
  if (status && (status === admin || status === ingest)) return null;
  return { admin, ingest };
}
export async function authorized(request: Request, token?: string) {
  if (!strongToken(token)) return false;
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
const date = (v: unknown) => normalizeTimestamp(v) !== null;

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
// ── 외부 공구 모음 사이트 후보(external_listing) ─────────────────────────────────
// ingested_items와 완전히 분리된 external_candidates에만 저장한다. 승인 API가 읽지 않으므로 공구가가 될 수 없다.
const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|igshid|ref|from|share)$/i;
const FORBIDDEN_EXTERNAL_PATH = /^\/(api|my|auth)(\/|$)/;
export function canonicalExternalUrl(value: unknown, source: ExternalSourceId): string | null {
  if (!safeUrl(value)) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.protocol !== 'https:' || u.hash || u.port || host !== EXTERNAL_SOURCES[source].host) return null;
  const kept = [...u.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(kept).toString();
  const path = u.pathname.replace(/\/{2,}/g, '/');
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* 디코딩 불가 경로는 원형으로만 검사한다. */ }
  if (FORBIDDEN_EXTERNAL_PATH.test(path.toLowerCase()) || FORBIDDEN_EXTERNAL_PATH.test(decoded.toLowerCase())) return null;
  return `https://${host}${path.length > 1 ? path.replace(/\/$/, '') : path}${query ? `?${query}` : ''}`;
}
const optText = (v: unknown, max: number) => v == null || text(v, max);
const iso = normalizeTimestamp;
function parseExternalListing(b: Record<string, unknown>) {
  const bad = (error = '외부 공구 후보 형식 확인 필요') => ({ error });
  if ('image_url' in b) return bad('외부 소스에서는 image_url을 받지 않습니다');
  const source = b.source;
  if (typeof source !== 'string' || !Object.hasOwn(EXTERNAL_SOURCES, source)) return bad('허용되지 않은 외부 소스');
  const id = source as ExternalSourceId;
  const sourceUrl = canonicalExternalUrl(b.source_url, id);
  if (!sourceUrl) return bad('source_url이 소스 호스트의 허용된 공개 https 경로가 아닙니다');
  if (!text(b.title, 200) || !text(b.text, 2000) || !date(b.captured_at)) return bad();
  if (!optText(b.price_raw, 100) || !optText(b.dates_raw, 100) || !optText(b.seller_name, 100) || !optText(b.category, 40)) return bad();
  if (b.price_basis != null && b.price_basis !== 'external_listing') return bad();
  if (b.price_hint != null && (!Number.isSafeInteger(b.price_hint) || (b.price_hint as number) < 0)) return bad();
  if (b.model_match != null && typeof b.model_match !== 'boolean') return bad();
  if ((b.starts_at != null && !date(b.starts_at)) || (b.ends_at != null && !date(b.ends_at))) return bad();
  const startsAt = iso(b.starts_at);
  const endsAt = iso(b.ends_at);
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) return bad();
  if (b.seller_handle != null && (typeof b.seller_handle !== 'string' || !/^[A-Za-z0-9._]{1,30}$/.test(b.seller_handle))) return bad();
  if (b.seller_url != null) {
    let ok = false;
    try { const u = new URL(b.seller_url as string); ok = safeUrl(b.seller_url) && u.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(u.hostname) && /^\/[A-Za-z0-9._]{1,30}\/?$/.test(u.pathname) && !u.search && !u.hash; } catch { /* invalid */ }
    if (!ok) return bad();
  }
  let suggestions: string | null = null;
  if (b.suggestions != null) {
    const parsed = parseSuggestions(b.suggestions);
    if (!parsed) return bad('suggestions 형식 확인 필요');
    suggestions = JSON.stringify(parsed);
  }
  return {
    value: {
      source: id, source_url: sourceUrl, title: b.title as string, text: b.text as string,
      seller_handle: (b.seller_handle as string | undefined) ?? null, seller_name: (b.seller_name as string | undefined) ?? null, seller_url: (b.seller_url as string | undefined) ?? null,
      price_hint: (b.price_hint as number | undefined) ?? null, price_raw: (b.price_raw as string | undefined) ?? null,
      starts_at: startsAt, ends_at: endsAt, dates_raw: (b.dates_raw as string | undefined) ?? null,
      category: (b.category as string | undefined) ?? null, model_match: b.model_match === true ? 1 : 0, suggestions,
      captured_at: iso(b.captured_at),
    },
  };
}
async function ingestExternal(b: Record<string, unknown>, env: Env) {
  const parsed = parseExternalListing(b);
  if ('error' in parsed) return json({ error: parsed.error }, 400);
  const v = parsed.value;
  // 이미 있는 URL은 candidate 상태일 때만 갱신한다. dismissed는 그대로 두고 같은 202로 응답한다.
  await env.DB.prepare(`INSERT INTO external_candidates (id,source,source_url,title,text,seller_handle,seller_name,seller_url,price_hint,price_raw,price_basis,starts_at,ends_at,dates_raw,category,model_match,suggestions,captured_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'external_listing',?,?,?,?,?,?,?,?)
    ON CONFLICT(source_url) DO UPDATE SET title=excluded.title, text=excluded.text, seller_handle=excluded.seller_handle, seller_name=excluded.seller_name, seller_url=excluded.seller_url,
      price_hint=excluded.price_hint, price_raw=excluded.price_raw, starts_at=excluded.starts_at, ends_at=excluded.ends_at, dates_raw=excluded.dates_raw,
      category=excluded.category, model_match=excluded.model_match, suggestions=excluded.suggestions, last_seen_at=excluded.last_seen_at
    WHERE external_candidates.status = 'candidate'`)
    .bind(crypto.randomUUID(), v.source, v.source_url, v.title, v.text, v.seller_handle, v.seller_name, v.seller_url, v.price_hint, v.price_raw, v.starts_at, v.ends_at, v.dates_raw, v.category, v.model_match, v.suggestions, v.captured_at, v.captured_at).run();
  return json({ data: await env.DB.prepare('SELECT id,status FROM external_candidates WHERE source_url = ?').bind(v.source_url).first() }, 202);
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
  if (path === 'collector/status') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!strongToken(env.COLLECTOR_STATUS_TOKEN) || env.COLLECTOR_STATUS_TOKEN === env.ADMIN_TOKEN || env.COLLECTOR_STATUS_TOKEN === env.INGEST_TOKEN) return json({ error: 'status_token_config' }, 503);
    if (!await authorized(request, env.COLLECTOR_STATUS_TOKEN)) return json({ error: 'unauthorized' }, 401);
    let value: unknown; try { value = await body(request); } catch { return json({ error: 'snapshot_body' }, 400); }
    const result = await receiveStatus(env.DB, value); return json(result.error ? { error: result.error } : { data: result.data }, result.status);
  }
  if (admin || path === 'ingest') {
    const tokens = serviceTokens(env);
    if (!tokens) return json({ error: '서비스 토큰 설정 확인 필요' }, 503);
    if (!await authorized(request, admin ? tokens.admin : tokens.ingest)) return json({ error: '인증 필요' }, 401);
  }
  if (path === 'admin/collection-status' && request.method === 'GET') return json({ data: await collectionStatus(env.DB) });
  if (request.method === 'GET') {
    if (path === 'brands') return json({ data: await all(env.DB, 'SELECT brand AS name, COUNT(*) AS model_count FROM models GROUP BY brand ORDER BY brand') });
    if (path === 'models') {
      const u = new URL(request.url); const brand = u.searchParams.get('brand'); const category = u.searchParams.get('category');
      return json({ data: await all(env.DB, `SELECT ${PUBLIC_MODEL_COLUMNS} FROM models WHERE (? = '' OR brand = ?) AND (? = '' OR category = ?) ORDER BY rowid`, brand ?? '', brand ?? '', category ?? '', category ?? '') });
    }
    if (parts[0] === 'models' && parts.length === 2) {
      const model = await env.DB.prepare(`SELECT ${PUBLIC_MODEL_COLUMNS} FROM models WHERE id = ?`).bind(parts[1]).first<Omit<Model, 'note'>>();
      if (!model) return json({ error: '모델을 찾을 수 없습니다' }, 404);
      const deals = await all<Deal>(env.DB, 'SELECT * FROM deals WHERE model_id = ? ORDER BY starts_at, id', model.id);
      return json({ data: { ...model, comparison: comparison(model, deals) } });
    }
    if (path === 'deals' || path === 'calendar') return json({ data: (await all<Deal>(env.DB, 'SELECT * FROM deals ORDER BY starts_at, id')).map(d => ({ ...d, advertisement: true, notice: dealsCopy.apiNotice })) });
    if (path === 'sellers') return json({ data: await all(env.DB, 'SELECT * FROM sellers ORDER BY name') });
    if (path === 'admin/candidates') return json({ data: await all(env.DB, "SELECT * FROM external_candidates WHERE status = 'candidate' ORDER BY captured_at LIMIT 200") });
    if (path === 'admin/queue') return json({ data: await all(env.DB, "SELECT * FROM ingested_items WHERE status = 'pending' ORDER BY captured_at LIMIT 100") });
  }
  if (request.method === 'POST' && admin && parts.length === 3 && parts[1] === 'candidates') {
    let b;
    try { b = await body(request); } catch { return json({ error: '32KB 이하 JSON 필요' }, 400); }
    if (!b || typeof b !== 'object' || b.action !== 'dismiss') return json({ error: 'dismiss 필요' }, 400);
    const candidate = await env.DB.prepare('SELECT status FROM external_candidates WHERE id = ?').bind(parts[2]).first<{ status: string }>();
    if (!candidate) return json({ error: '항목 없음' }, 404);
    if (candidate.status !== 'candidate') return json({ error: '이미 처리된 항목' }, 409);
    const result = await env.DB.prepare("UPDATE external_candidates SET status = 'dismissed', reviewed_at = ? WHERE id = ? AND status = 'candidate'").bind(new Date().toISOString(), parts[2]).run();
    return result.meta.changes ? json({ data: { status: 'dismissed' } }) : json({ error: '이미 처리된 항목' }, 409);
  }
  if (request.method === 'POST' && (path === 'ingest' || (admin && parts.length === 3 && parts[1] === 'review'))) {
    let b;
    try { b = await body(request); } catch { return json({ error: '32KB 이하 JSON 필요' }, 400); }
    if (!b || typeof b !== 'object') return json({ error: '잘못된 입력' }, 400);
    if (path === 'ingest' && b.kind === 'external_listing') return ingestExternal(b, env);
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
      await env.DB.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,suggestions,image_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_url) DO NOTHING').bind(id, canonical, b.account, b.text, b.kind, iso(b.captured_at), suggestions, b.image_url ?? null).run();
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
    const startsAt = normalizeTimestamp(b.starts_at);
    const endsAt = normalizeTimestamp(b.ends_at);
    if (!text(b.model_id) || !text(b.seller_id) || !text(b.title, 200) || !(b.price === null || (Number.isSafeInteger(b.price) && b.price >= 0)) || !startsAt || !endsAt || endsAt <= startsAt) return json({ error: '모델·판매자·제목·가격(null 허용)·ISO 시작/종료일 필요' }, 400);
    const model = await env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(b.model_id).first();
    const seller = await env.DB.prepare('SELECT id FROM sellers WHERE id = ?').bind(b.seller_id).first();
    if (!model || !seller) return json({ error: '등록된 모델·판매자만 게시할 수 있습니다' }, 400);
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url) SELECT id, ?, ?, ?, ?, source_url, 'manual', ?, ?, ?, CASE WHEN ? THEN image_url ELSE NULL END FROM ingested_items WHERE id = ? AND status = 'pending' ON CONFLICT(id) DO NOTHING").bind(b.model_id, b.seller_id, b.title, b.price, now, startsAt, endsAt, b.include_image === false ? 0 : 1, parts[2]),
      env.DB.prepare("UPDATE ingested_items SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'").bind(now, parts[2]),
    ]);
    return results[0].meta.changes ? json({ data: { status: 'approved' } }) : json({ error: '이미 검수된 항목' }, 409);
  }
  return json({ error: '지원하지 않는 경로 또는 메서드' }, request.method === 'GET' ? 404 : 405);
}
