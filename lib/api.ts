import { captureAlert } from './alerts';
import { dealRoundReview, updateDealRound } from './deal-reviews';
import { evidencedOpening, recordPublishedPrice } from './deal-publication';
import { jsonBody as body } from './request-body';
import { CLOSE_OFFER, INVALIDATE_OFFER, OFFER_KIND, PROMOTE_OFFER } from '../shared/verified-offer';
import { dismissVerifiedOffer, ingestVerifiedOffer, mutateVerifiedOffer, verifiedOfferReviewPage } from './verified-offers';
import { normalizeTimestamp, parseDate, publicDealOptions, chronologicalDeals, lifecycleDeals, activeDealCount, endedDealCount, modelDealSummaries, PublicDealPaginationError } from './deals';
import { receiveStatus, collectionStatus } from './collection-status';
import { digest, filterOfferCapture, httpsSource, PRICE_TEXT_LIMIT } from '../shared/deal-price-evidence';
import { threadsPost } from '../shared/threads-url';
import { officialPriceAllowed, officialPriceGuard, officialScopeReceipt, syncOfficialPriceScopes } from './official-price-sources';
import { bundleComponents, configurationMatches, currentReviewEvidence, externalPriceSource, nextExternalPriceTarget, pendingPriceObservation, reviewEvidenceGuard, priceBindings, priceCaptureSql, priceColumns, previousDealPrices, priceTarget, priceTargetTables, recordBackfill, reviewDealPrices, reviewPricesFor, stageIngestEvidence, validatedEvidence, type PriceObservationReceipt, type PriceTargetKind, type PriceReview } from './deal-price-review';
import { isImageUrl } from './image-url';
import { all, type Env } from './db';
import { dealsCopy } from './deals-copy';
import { comparison, displayableOfficialPrice, EXTERNAL_SOURCES, type ExternalSourceId, type ExternalCandidate, type Model, type Seller, type AdminDeal, type DealRevision, type Deal } from './data';
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
export const ADMIN_SESSION_SECONDS = 3600;
const SESSION_RE = /^v1\.(\d{10})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const sessionMessage = (expires: string, nonce: string) => new TextEncoder().encode(`agamajung-admin-session:v1:${expires}:${nonce}`);
const sessionBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sessionKey(token: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
export async function issueAdminSession(token: string, now = Date.now()): Promise<string> {
  if (!strongToken(token)) throw new Error('Invalid admin session configuration');
  const nonce = sessionBase64(crypto.getRandomValues(new Uint8Array(32)));
  const expires = String(Math.floor(now / 1000) + ADMIN_SESSION_SECONDS);
  const mac = await crypto.subtle.sign('HMAC', await sessionKey(token, 'sign'), sessionMessage(expires, nonce));
  return `v1.${expires}.${nonce}.${sessionBase64(new Uint8Array(mac))}`;
}
export async function verifyAdminSession(value: string | undefined, token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!strongToken(token) || !value || value.length > 128) return false;
  const match = SESSION_RE.exec(value);
  if (!match || match[0] !== value) return false;
  const [, expires, nonce, mac] = match;
  if (Number(expires) <= now / 1000 || Number(expires) > now / 1000 + ADMIN_SESSION_SECONDS + 60) return false;
  try {
    const signature = Uint8Array.from(atob(mac.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
    // Reject alternate base64 encodings with nonzero unused padding bits.
    if (sessionBase64(signature) !== mac) return false;
    // Web Crypto verifies the HMAC without a timing-sensitive string comparison.
    return await crypto.subtle.verify('HMAC', await sessionKey(token, 'verify'), signature, sessionMessage(expires, nonce));
  } catch { return false; }
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
const PUBLIC_SELLER_COLUMNS = 'id, name, source_url, registration_source, withdrawal_source, official_import_source';

export function normalizeAccount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const account = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(account) ? account : null;
}
function evidenceUrl(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (!safeUrl(value) || new URL(value).protocol !== 'https:') throw new Error('evidence');
  return value;
}
function accountLink(b: Record<string, unknown>): string | null {
  if (b.account === undefined || (typeof b.account === 'string' && !b.account.trim())) return null;
  const account = normalizeAccount(b.account);
  if (!account || b.account_reviewed !== true) throw new Error('account');
  return account;
}
export async function adminSellersData(db: D1Database) {
  const sellers = await all<Seller>(db, `SELECT ${PUBLIC_SELLER_COLUMNS} FROM sellers ORDER BY name`);
  const links = await all<{ account: string; seller_id: string }>(db, 'SELECT account, seller_id FROM seller_accounts ORDER BY account');
  const linked = new Set(links.map(link => link.account));
  const pending = await all<{ account: string; pending: number }>(db, "SELECT account, COUNT(*) AS pending FROM ingested_items WHERE status = 'pending' AND kind IN ('post','story') GROUP BY account ORDER BY account");
  return {
    sellers: sellers.map(seller => ({ ...seller, accounts: links.filter(link => link.seller_id === seller.id).map(link => link.account) })),
    unlinked_accounts: pending.map(row => ({ ...row, normalized: normalizeAccount(row.account) })).filter(row => !row.normalized || !linked.has(row.normalized)),
  };
}
async function manageSeller(request: Request, parts: string[], env: Env) {
  let b: Record<string, unknown>;
  try { b = await body(request); } catch { return json({ error: '32KB 이하 JSON 필요' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: '잘못된 입력' }, 400);
  const create = parts.length === 2;
  const id = create ? `seller-${crypto.randomUUID()}` : parts[2];
  if (!create && !await env.DB.prepare('SELECT id FROM sellers WHERE id = ?').bind(id).first()) return json({ error: '판매자 없음' }, 404);
  let account: string | null = null;
  if (create || b.action === 'link_account') {
    try { account = accountLink(b); } catch { return json({ error: '계정 연결은 Instagram handle 및 검수 확인 필요' }, 400); }
    if (!create && !account) return json({ error: '계정 연결은 Instagram handle 및 검수 확인 필요' }, 400);
  }
  if (create || b.action === 'update') {
    if (!text(b.name, 100) || !safeUrl(b.source_url) || new URL(b.source_url).protocol !== 'https:') return json({ error: '판매자 이름 및 HTTPS 출처 필요' }, 400);
    let evidence: (string | null)[];
    try { evidence = [evidenceUrl(b.registration_source), evidenceUrl(b.withdrawal_source), evidenceUrl(b.official_import_source)]; }
    catch { return json({ error: '증빙은 HTTPS URL 필요' }, 400); }
    if (!create) {
      await env.DB.prepare('UPDATE sellers SET name = ?, source_url = ?, registration_source = ?, withdrawal_source = ?, official_import_source = ? WHERE id = ?').bind(b.name, b.source_url, ...evidence, id).run();
      return json({ data: { id } });
    }
    const statements = [env.DB.prepare('INSERT INTO sellers (id,name,source_url,registration_source,withdrawal_source,official_import_source) VALUES (?,?,?,?,?,?)').bind(id, b.name, b.source_url, ...evidence)];
    if (account) {
      if (await env.DB.prepare('SELECT seller_id FROM seller_accounts WHERE account = ?').bind(account).first()) return json({ error: '이미 연결된 계정' }, 409);
      statements.push(env.DB.prepare('INSERT INTO seller_accounts (account,seller_id,reviewed_at) VALUES (?,?,?)').bind(account, id, new Date().toISOString()));
    }
    try { await env.DB.batch(statements); }
    catch (error) {
      // A concurrent link must roll back registration too. Never return database errors or input URLs.
      if (account && await env.DB.prepare('SELECT seller_id FROM seller_accounts WHERE account = ?').bind(account).first()) return json({ error: '이미 연결된 계정' }, 409);
      throw error;
    }
    return json({ data: { id } }, 201);
  }
  if (b.action === 'link_account' && account) {
    await env.DB.prepare('INSERT INTO seller_accounts (account,seller_id,reviewed_at) VALUES (?,?,?) ON CONFLICT(account) DO NOTHING').bind(account, id, new Date().toISOString()).run();
    const link = await env.DB.prepare('SELECT seller_id FROM seller_accounts WHERE account = ?').bind(account).first<{ seller_id: string }>();
    return link?.seller_id === id ? json({ data: { id } }) : json({ error: '이미 연결된 계정' }, 409);
  }
  if (b.action === 'unlink_account') {
    const normalized = normalizeAccount(b.account);
    if (!normalized) return json({ error: 'Instagram handle 필요' }, 400);
    await env.DB.prepare('DELETE FROM seller_accounts WHERE seller_id = ? AND account = ?').bind(id, normalized).run();
    return json({ data: { id } });
  }
  return json({ error: '지원하지 않는 판매자 작업' }, 400);
}

export class AdminPaginationError extends Error {
  constructor(public readonly code: 'invalid_cursor' | 'invalid_limit') { super(code); }
}
type ReviewList = 'queue' | 'candidates';
type ReviewPageOptions = { limit?: number; cursor?: string | null };
export type AdminQueueItem = {
  id: string; source_url: string; account: string; text: string; kind: 'post' | 'story' | 'threads_post';
  captured_at: string; status: 'pending'; reviewed_at: string | null;
  suggestions: string | null; image_url: string | null;
  attribution: string | null; attribution_note: string | null;
  price_review?: PriceReview | null;
  price_observation?: PriceReview | null;
};
const REVIEW_LISTS = {
  queue: { table: 'ingested_items', status: 'pending', maximum: 100 },
  candidates: { table: 'external_candidates', status: 'candidate', maximum: 200 },
} as const;
const REVIEW_CURSOR_MAX = 2048;
function encodeReviewCursor(list: ReviewList, capturedAt: string, id: string) {
  return sessionBase64(new TextEncoder().encode(JSON.stringify([1, list, capturedAt, id])));
}
function reviewTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  // Keep the original SQL text boundary, including legacy date-only/SQLite UTC
  // timestamps and ISO offsets. Normalizing it would change TEXT ordering.
  let timestamp = value.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(timestamp)) timestamp += 'Z';
  return Number.isFinite(parseDate(timestamp));
}
export function decodeAdminReviewCursor(list: ReviewList, cursor: string): [string, string] {
  try {
    if (typeof cursor !== 'string' || cursor.length > REVIEW_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Uint8Array.from(atob(cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - cursor.length % 4) % 4)), c => c.charCodeAt(0));
    const tuple: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== 1 || tuple[1] !== list ||
        !reviewTimestamp(tuple[2]) || typeof tuple[3] !== 'string' || !tuple[3].trim() || tuple[3].length > 256 ||
        [...tuple[3]].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        encodeReviewCursor(list, tuple[2], tuple[3]) !== cursor) throw new Error();
    return [tuple[2], tuple[3]];
  } catch { throw new AdminPaginationError('invalid_cursor'); }
}
async function adminReviewPage<T extends { id: string; captured_at: string }>(db: D1Database, list: ReviewList, options: ReviewPageOptions) {
  const { table, status, maximum } = REVIEW_LISTS[list];
  const { limit = maximum, cursor = null } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw new AdminPaginationError('invalid_limit');
  const boundary = cursor === null ? null : decodeAdminReviewCursor(list, cursor);
  // Only these internal table names are interpolated; all values remain bound.
  const rows = await all<T>(db, `SELECT * FROM ${table} WHERE status = ?
    ${boundary ? 'AND (captured_at, id) > (?, ?)' : ''}
    ORDER BY captured_at ASC, id ASC LIMIT ?`, status, ...(boundary ?? []), limit + 1);
  const data = rows.slice(0, limit), last = data.at(-1);
  return { data, next_cursor: rows.length > limit && last ? encodeReviewCursor(list, last.captured_at, last.id) : null };
}
// These shared reads are private: callers must authenticate before invoking them.
export async function adminQueuePage(db: D1Database, options: ReviewPageOptions = {}) {
  const page = await adminReviewPage<AdminQueueItem>(db, 'queue', options);
  const proofs = await reviewPricesFor(db, 'ingest', page.data.map(row => ({ id: row.id, revision: row.captured_at })));
  return { ...page, data: await Promise.all(page.data.map(async row => ({ ...row, price_review: proofs.get(row.id) ?? null,
    price_observation: await pendingPriceObservation(db, 'ingest', row.id, row.captured_at) }))) };
}
export async function adminCandidatesPage(db: D1Database, options: ReviewPageOptions = {}) {
  const page = await adminReviewPage<ExternalCandidate>(db, 'candidates', options);
  const proofs = await reviewPricesFor(db, 'candidate', page.data.map(row => ({ id: row.id, revision: row.price_revision ?? 'legacy' })));
  return { ...page, data: await Promise.all(page.data.map(async row => ({ ...row, price_review: proofs.get(row.id) ?? null,
    price_observation: await pendingPriceObservation(db, 'candidate', row.id, row.price_revision ?? 'legacy') }))) };
}
function reviewRequestOptions(params: URLSearchParams, list: ReviewList): ReviewPageOptions {
  if (params.getAll('cursor').length > 1) throw new AdminPaginationError('invalid_cursor');
  if (params.getAll('limit').length > 1) throw new AdminPaginationError('invalid_limit');
  const rawLimit = params.get('limit');
  if (rawLimit !== null && (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > REVIEW_LISTS[list].maximum)) throw new AdminPaginationError('invalid_limit');
  return { limit: rawLimit === null ? undefined : Number(rawLimit), cursor: params.get('cursor') };
}

// Admin lifecycle reads intentionally include private evidence and audit history.
const REVISION_COLUMNS = 'id,deal_id,version,action,request_id,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at';
type DealState = { verify_level?: string; id: string; status: 'published' | 'withdrawn'; version: number };
type DealPageOptions = { status?: string; limit?: number; cursor?: string | null };
function encodeCursor(checked: string, id: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(`${checked}|${id}`))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function validateAdminDealPage({ status = 'published', limit = 20, cursor = null }: DealPageOptions) {
  if (!['published', 'withdrawn', 'all'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('deal_page');
  let checked: string | null = null, id: string | null = null;
  if (cursor !== null) {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error('deal_cursor');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
    const separator = decoded.indexOf('|');
    checked = decoded.slice(0, separator); id = decoded.slice(separator + 1);
    if (separator < 1 || !id || !Number.isFinite(parseDate(checked)) || encodeCursor(checked, id) !== cursor) throw new Error('deal_cursor');
  }
  return { status, limit, checked, id };
}
async function hydrateAdminDeals(db: D1Database, rows: Omit<AdminDeal, 'evidence' | 'revisions'>[]): Promise<AdminDeal[]> {
  if (!rows.length) return [];
  const marks = rows.map(() => '?').join(',');
  const ids = rows.map(row => row.id);
  const revisions = await all<DealRevision>(db, `SELECT ${REVISION_COLUMNS} FROM deal_revisions WHERE deal_id IN (${marks}) ORDER BY version`, ...ids);
  const evidence = await all<NonNullable<AdminDeal['evidence']> & { id: string }>(db, `SELECT id,source_url,account,text,captured_at,image_url,attribution,attribution_note,reviewed_at FROM ingested_items WHERE id IN (${marks})`, ...ids);
  const proofs = await reviewDealPrices(db, ids);
  return rows.map(row => {
    const original = evidence.find(item => item.id === row.id);
    const preserved = original ? { source_url: original.source_url, account: original.account, text: original.text, captured_at: original.captured_at, image_url: original.image_url, attribution: original.attribution, attribution_note: original.attribution_note, reviewed_at: original.reviewed_at } : null;
    return { ...row, evidence: preserved, price_review: proofs.get(row.id) ?? null, revisions: revisions.filter(revision => revision.deal_id === row.id) };
  });
}
export async function adminDealsPage(db: D1Database, options: DealPageOptions = {}) {
  const { status, limit, checked, id } = validateAdminDealPage(options);
  const result = await db.prepare(`SELECT * FROM deals
    WHERE (? = 'all' OR status = ?) AND (? IS NULL OR checked < ? OR (checked = ? AND id < ?))
    ORDER BY checked DESC, id DESC LIMIT ?`).bind(status, status, checked, checked, checked, id, limit + 1).all<Omit<AdminDeal, 'evidence' | 'revisions'>>();
  const rows = result.results;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { data: await hydrateAdminDeals(db, page), next_cursor: rows.length > limit && last ? encodeCursor(last.checked, last.id) : null };
}
export async function adminDeal(db: D1Database, id: string): Promise<AdminDeal | null> {
  const row = await db.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first<Omit<AdminDeal, 'evidence' | 'revisions'>>();
  if (!row) return null;
  const [deal] = await hydrateAdminDeals(db, [row]);
  return { ...deal, previous_price_reviews: await previousDealPrices(db, id), current_review: await dealRoundReview(db, id, row.version) };
}
async function requestHash(tuple: unknown[]) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tuple)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function classifyReplay(db: D1Database, dealId: string, requestId: string, action: string, hash: string, expectedVersion: number) {
  const revision = await db.prepare('SELECT action,request_hash,version FROM deal_revisions WHERE deal_id = ? AND request_id = ?')
    .bind(dealId, requestId).first<{ action: string; request_hash: string; version: number }>();
  if (!revision) return 'none';
  return revision.action === action && revision.request_hash === hash && revision.version === expectedVersion + 1 ? 'replay' : 'conflict';
}
async function manageDeal(request: Request, id: string, env: Env) {
  let b: Record<string, unknown>;
  try { b = await body(request); } catch { return json({ error: 'invalid_deal' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'invalid_deal' }, 400);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  const action = b.action;
  const expected = b.expected_version as number;
  const key = b.request_id;
  if ((action !== 'correct' && action !== 'withdraw') || !Number.isSafeInteger(expected) || expected < 1 ||
      typeof key !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(key) || key.startsWith('review-') ||
      reason.length < 10 || reason.length > 300 ||
      ['discount_pct','source_url','verify_level','checked','image_url','seller_id','status','version','id'].some(field => field in b)) return json({ error: 'invalid_deal' }, 400);
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const starts = normalizeTimestamp(b.starts_at), ends = normalizeTimestamp(b.ends_at);
  if (action === 'correct') {
    if (typeof b.model_id !== 'string' || !title || title.length > 200 ||
        !(b.price === null || (Number.isSafeInteger(b.price) && (b.price as number) >= 0)) ||
        (b.starts_at !== null && !starts) || (b.ends_at !== null && !ends) || (starts && ends && ends <= starts) || typeof b.include_image !== 'boolean') return json({ error: 'invalid_deal' }, 400);
    if (!await env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(b.model_id).first()) return json({ error: 'invalid_model' }, 400);
  }
  if (b.price_evidence_id !== undefined && (action !== 'correct' || typeof b.price_evidence_id !== 'string' || !/^[a-f0-9]{64}$/.test(b.price_evidence_id))) return json({ error: 'invalid_evidence' }, 400);
  const hash = await requestHash(action === 'correct' ? [action, expected, b.model_id, title, b.price, starts, ends, b.include_image, reason, b.price_evidence_id ?? null] : [action, expected, reason]);
  const state = () => env.DB.prepare(`SELECT id,status,version,model_id,price,deal_price_krw,starts_at,ends_at,price_verification,price_evidence_version,verified_offer_id
    FROM deals WHERE id = ?`).bind(id).first<DealState & {
    model_id: string | null; price: number | null; deal_price_krw: number | null; starts_at: string | null; ends_at: string | null;
    price_verification: string; price_evidence_version: number | null; verified_offer_id: string | null;
  }>();
  const current = await state();
  if (!current) return json({ error: 'deal_not_found' }, 404);
  const replay = async () => {
    const classification = await classifyReplay(env.DB, id, key, action, hash, expected);
    if (classification === 'conflict') return json({ error: 'request_id_reused' }, 409);
    if (classification === 'replay') {
      const row = (await state())!;
      return json({ data: { id: row.id, status: row.status, version: row.version, replayed: true } });
    }
    return null;
  };
  const previous = await replay();
  if (previous) return previous;
  if (action === 'correct' && current.verified_offer_id !== null) return json({ error: 'verified_revision_required' }, 409);
  const conflict = (row: DealState) => json({ error: row.status === 'withdrawn' ? 'withdrawn' : 'stale_version', current_version: row.version }, 409);
  if (current.status === 'withdrawn' || current.version !== expected) return conflict(current);
  const now = new Date().toISOString();
  const correct = action === 'correct';
  let applied: PriceReview | null = null;
  if (correct && b.price_evidence_id) {
    applied = (await reviewDealPrices(env.DB, [id])).get(id) ?? null;
    const facts = applied?.result.facts;
    const bundles = await all<{ product_name: string }>(env.DB, 'SELECT product_name FROM deal_bundle_items WHERE deal_id = ? ORDER BY position', id);
    if (applied?.id !== b.price_evidence_id || !facts ||
        facts.deal_price_krw !== b.price || facts.ends_at !== ends || !await configurationMatches(env.DB, facts, b.model_id as string, bundles.map(row => row.product_name))) {
      return json({ error: 'evidence_configuration_or_fact_conflict' }, 409);
    }
  }
  const retainProof = correct && current.price_verification === 'verified' && current.price_evidence_version === expected &&
    b.model_id === current.model_id && (b.price === current.price || b.price === current.deal_price_krw) &&
    starts === normalizeTimestamp(current.starts_at) && ends === normalizeTimestamp(current.ends_at);
  const authority = officialPriceGuard(applied?.evidence ?? null);
  const values = correct ? '?,d.seller_id,?,?,?,?,CASE WHEN ? THEN i.image_url ELSE NULL END,?' : 'd.model_id,d.seller_id,d.title,d.price,d.starts_at,d.ends_at,d.image_url,d.checked';
  const snapshotBindings = [crypto.randomUUID(), action, key, hash, reason,
    ...(correct ? [b.model_id as string, title, b.price as number | null, starts, ends, b.include_image ? 1 : 0, now] : []),
    correct ? 'published' : 'withdrawn', now, applied?.id ?? null, id, expected, ...authority.values];
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at,price_evidence_id)
      SELECT ?,d.id,d.version + 1,?,?,?,?,${values},?,?,COALESCE(?,d.price_evidence_id) FROM deals AS d JOIN ingested_items AS i ON i.id = d.id
      WHERE d.id = ? AND d.version = ? AND d.status = 'published' AND ${authority.sql} ON CONFLICT DO NOTHING`).bind(...snapshotBindings),
    env.DB.prepare(`UPDATE deals SET (model_id,title,price,starts_at,ends_at,image_url,checked,status) =
      (SELECT model_id,title,price,starts_at,ends_at,image_url,checked,status FROM deal_revisions WHERE deal_id = deals.id AND request_id = ?),
      deal_price_krw = CASE WHEN ? THEN ? ELSE deal_price_krw END,
      list_price_krw = CASE WHEN ? THEN ? ELSE list_price_krw END,
      price_source_url = CASE WHEN ? THEN ? ELSE price_source_url END,
      list_price_source_url = CASE WHEN ? THEN ? ELSE list_price_source_url END,
      price_checked_at = CASE WHEN ? THEN ? ELSE price_checked_at END,
      price_evidence_id = COALESCE(?, price_evidence_id), orders_open = COALESCE(?, orders_open),
      price_verification = ?, price_evidence_version = CASE WHEN ? THEN version + 1 ELSE price_evidence_version END,
      version = version + 1, updated_at = ?, withdrawn_at = CASE WHEN ? = 'withdraw' THEN ? ELSE withdrawn_at END
      WHERE id = ? AND version = ? AND status = 'published'
      AND EXISTS (SELECT 1 FROM deal_revisions WHERE deal_id = ? AND request_id = ? AND request_hash = ? AND action = ? AND version = ? + 1)`)
      .bind(key, ...priceBindings(applied?.result ?? null, applied?.id ?? null, expected + 1).slice(0, 5).flatMap(value => [applied ? 1 : 0, value]),
        applied?.id ?? null, applied ? (applied.result.facts?.orders_open ? 1 : 0) : null,
        applied || retainProof ? 'verified' : 'unverified', applied || retainProof ? 1 : 0, now, action, now, id, expected, id, key, hash, action, expected),
    ...(applied || retainProof ? [recordPublishedPrice(env.DB, id, key, evidencedOpening(applied?.evidence, starts), applied?.result.facts?.configuration)] : []),
  ]);
  if (results[1].meta.changes === 1) return json({ data: { id, status: correct ? 'published' : 'withdrawn', version: expected + 1 } });
  if (applied && !await officialPriceAllowed(env.DB, applied.evidence)) return json({ error: 'official_source_not_approved' }, 409);
  return await replay() ?? conflict((await state())!);
}

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
  if (!text(b.title, 200) || !text(b.text, b.price_evidence == null ? 2000 : PRICE_TEXT_LIMIT) || !date(b.captured_at)) return bad();
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
async function applyLivePriceObservation(db: D1Database, id: string, evidence: NonNullable<Awaited<ReturnType<typeof validatedEvidence>>>): Promise<PriceObservationReceipt | null> {
  if (!evidence.offer) return null;
  const deal = await priceTarget(db, 'deal', id);
  if (!deal) return null;
  const duplicate = await db.prepare(`SELECT r.observation_id,r.revision,r.outcome FROM deal_price_backfill_receipts r
    JOIN deal_price_evidence p ON p.id = r.observation_id
    WHERE p.target_kind = 'deal' AND p.target_id = ? AND p.body = ?`).bind(id, JSON.stringify(evidence))
    .first<{ observation_id: string; revision: string; outcome: string }>();
  if (duplicate) return duplicate;
  if (deal.status !== 'published') return { outcome: 'withdrawn' };
  const key = await digest(JSON.stringify(['live', id, deal.revision, evidence]));
  return recordBackfill(db, 'deal', id, deal.revision, key, evidence, true);
}

async function ingestExternalObservation(b: Record<string, unknown>, db: D1Database) {
  if (!text(b.deal_id, 200) || !httpsSource(b.source_url) ||
      (b.request_id !== undefined || b.expected_revision !== undefined) &&
      (typeof b.request_id !== 'string' || !/^[0-9a-f]{64}$/.test(b.request_id) ||
        typeof b.expected_revision !== 'string' || !/^\d{1,16}$/.test(b.expected_revision))) return json({ error: 'invalid_target' }, 400);
  const deal = await externalPriceSource(db, b.deal_id as string);
  if (!deal) return json({ error: 'target_not_found' }, 404);
  const evidence = await validatedEvidence(b.price_evidence, deal.source_url);
  if (!evidence?.offer || evidence.offer_url !== b.source_url) return json({ error: 'invalid_evidence' }, 400);
  const result = typeof b.request_id === 'string' ?
    await recordBackfill(db, 'deal', b.deal_id as string, b.expected_revision as string, b.request_id, evidence, true) :
    await applyLivePriceObservation(db, b.deal_id as string, evidence);
  if (result?.error) return json({ error: result.error }, 409);
  return json({ data: { id: b.deal_id, status: 'observed', ...result } }, 202);
}

async function ingestExternal(b: Record<string, unknown>, env: Env) {
  const parsed = parseExternalListing(b);
  if ('error' in parsed) return json({ error: parsed.error }, 400);
  const v = parsed.value;
  const evidence = b.price_evidence == null ? null : await validatedEvidence(b.price_evidence, v.source_url);
  if (b.price_evidence != null && (!evidence || evidence.offer && evidence.offer.source.text !== filterOfferCapture(v.text))) {
    return json({ error: 'invalid_evidence' }, 400);
  }
  if (!await officialPriceAllowed(env.DB, evidence)) return json({ error: 'official_source_not_approved' }, 409);
  const { captured_at: captured, ...content } = v;
  const revision = await digest(JSON.stringify([captured, content]));
  await env.DB.prepare(`INSERT INTO external_candidates (id,source,source_url,title,text,seller_handle,seller_name,seller_url,price_hint,price_raw,price_basis,starts_at,ends_at,dates_raw,category,model_match,suggestions,captured_at,last_seen_at,price_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,'external_listing',?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_url) DO UPDATE SET title=excluded.title, text=excluded.text, seller_handle=excluded.seller_handle, seller_name=excluded.seller_name, seller_url=excluded.seller_url,
      price_hint=excluded.price_hint, price_raw=excluded.price_raw, starts_at=excluded.starts_at, ends_at=excluded.ends_at, dates_raw=excluded.dates_raw,
      category=excluded.category, model_match=excluded.model_match, suggestions=excluded.suggestions, last_seen_at=excluded.last_seen_at, price_revision=excluded.price_revision
    WHERE external_candidates.status = 'candidate' AND (julianday(external_candidates.last_seen_at) IS NULL
      OR julianday(excluded.last_seen_at) > julianday(external_candidates.last_seen_at))`)
    .bind(crypto.randomUUID(), v.source, v.source_url, v.title, v.text, v.seller_handle, v.seller_name, v.seller_url, v.price_hint, v.price_raw, v.starts_at, v.ends_at, v.dates_raw, v.category, v.model_match, v.suggestions, captured, captured, revision).run();
  const item = await env.DB.prepare('SELECT id,status,promoted_deal_id,price_revision FROM external_candidates WHERE source_url = ?').bind(v.source_url)
    .first<{ id: string; status: string; promoted_deal_id: string | null; price_revision: string }>();
  if (evidence && item?.promoted_deal_id && item.status === 'promoted') await applyLivePriceObservation(env.DB, item.promoted_deal_id, evidence);
  const staged = item && evidence ? await stageIngestEvidence(env.DB, 'candidate', item.id, evidence, revision) : null;
  return json({ data: item ? { id: item.id, status: item.status, ...(staged ? { price_evidence_id: staged.id } : {}), revision: item.price_revision } : null }, 202);
}
export async function handleApi(request: Request, parts: string[], env: Env): Promise<Response> {
  const path = parts.join('/');
  if (path === 'alerts') return captureAlert(request, env.DB);
  const admin = parts[0] === 'admin' || path === 'collector-status';
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
  if ((path === 'admin/collection-status' || path === 'collector-status') && request.method === 'GET') return json({ data: await collectionStatus(env.DB) });
  if (request.method === 'GET') {
    if (path === 'ingest') {
      const params = new URL(request.url).searchParams;
      if (params.get('kind') === 'external_price_observation') {
        const cursor = params.get('cursor') ?? '';
        const relatedTo = params.get('related_to');
        if (cursor.length > 200 || relatedTo && relatedTo.length > 200) return json({ error: 'invalid_cursor' }, 400);
        return json({ data: await nextExternalPriceTarget(env.DB, cursor, relatedTo) });
      }
    }
    if (admin && parts.length === 4 && parts[1] === 'candidates' && parts[3] === 'receipt') {
      const params = new URL(request.url).searchParams;
      const claim = Object.fromEntries(params);
      return mutateVerifiedOffer(env.DB, parts[2], { ...claim, revision: Number(claim.revision), expected_version: Number(claim.expected_version) }, true);
    }
    if (path === 'admin/candidates' && new URL(request.url).searchParams.get('kind') === OFFER_KIND) {
      const params = new URL(request.url).searchParams;
      const limit = params.has('limit') ? Number(params.get('limit')) : 20;
      if (params.get('state') !== 'review' || !Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: 'invalid_review_query' }, 400);
      const page = await verifiedOfferReviewPage(env.DB, limit, params.get('cursor'));
      return page ? json(page) : json({ error: 'invalid_cursor' }, 400);
    }
    if (path === 'brands') return json({ data: await all(env.DB, 'SELECT brand AS name, COUNT(*) AS model_count FROM models GROUP BY brand ORDER BY brand') });
    if (path === 'models') {
      const u = new URL(request.url); const brand = u.searchParams.get('brand'); const category = u.searchParams.get('category');
      const models = await all<Omit<Model, 'note'>>(env.DB, `SELECT ${PUBLIC_MODEL_COLUMNS} FROM models WHERE (? = '' OR brand = ?) AND (? = '' OR category = ?) ORDER BY rowid`, brand ?? '', brand ?? '', category ?? '', category ?? '');
      return json({ data: models.map(model => ({ ...model, official_price: displayableOfficialPrice(model) })) });
    }
    if ((parts[0] === 'models' && parts.length === 2) || path === 'deals' || path === 'calendar') {
      let options;
      const isModel = parts[0] === 'models';
      try { options = publicDealOptions(new URL(request.url).searchParams, isModel ? 'api-model' : path === 'deals' ? 'api-deals' : 'api-calendar', isModel ? parts[1] : null); }
      catch (error) { if (error instanceof PublicDealPaginationError) return json({ error: error.code }, 400); throw error; }
      const nowMs = Date.now();
      if (isModel) {
        const model = await env.DB.prepare(`SELECT ${PUBLIC_MODEL_COLUMNS} FROM models WHERE id = ?`).bind(parts[1]).first<Omit<Model, 'note'>>();
        if (!model) return json({ error: '모델을 찾을 수 없습니다' }, 404);
        const [page, summaries] = await Promise.all([chronologicalDeals(env.DB, options, false, nowMs), modelDealSummaries(env.DB, [model.id], nowMs)]);
        const { active_count, lowest_price } = summaries.get(model.id)!;
        return json({ data: { ...model, official_price: displayableOfficialPrice(model), comparison: { ...comparison(model, page.data), current: { active_count, lowest_price } } }, next_cursor: page.next_cursor });
      }
      const page = options.sort ? await lifecycleDeals<Deal>(env.DB, options, nowMs, false) : await chronologicalDeals(env.DB, options, false, nowMs);
      return json({ data: page.data.map(d => ({ ...d, advertisement: true, notice: dealsCopy.apiNotice })), next_cursor: page.next_cursor });
    }
    if (path === 'sellers') return json({ data: await all(env.DB, `SELECT ${PUBLIC_SELLER_COLUMNS} FROM sellers ORDER BY name`) });
    if (path === 'admin/price-backfill') {
      const params = new URL(request.url).searchParams;
      const kind = params.get('kind');
      if (kind === 'counts') {
        const now = Date.now();
        const [active, ended] = await Promise.all([activeDealCount(env.DB, now), endedDealCount(env.DB, now)]);
        return json({ data: { active, ended } });
      }
      if (!kind || !Object.hasOwn(priceTargetTables, kind)) return json({ error: 'invalid_target' }, 400);
      const targetKind = kind as PriceTargetKind;
      const { table, revision, status } = priceTargetTables[targetKind];
      const cursor = params.get('cursor') ?? '';
      if (cursor.length > 200) return json({ error: 'invalid_cursor' }, 400);
      const social = kind === 'deal'
        ? ", (SELECT json_object('kind',i.kind,'captured_at',i.captured_at,'text',i.text) FROM ingested_items AS i WHERE i.id = deals.id AND i.kind IN ('post','story')) AS original"
        : kind === 'ingest' ? ", CASE WHEN kind IN ('post','story') THEN json_object('kind',kind,'captured_at',captured_at,'text',text) END AS original" : '';
      const rows = await all<{ id: string; capture_text: string | null; hash_known: number; original?: string | null }>(env.DB, `SELECT id,source_url,${revision} AS revision,
        ${kind === 'deal' ? "origin != 'external_web' OR price_evidence_id IS NOT NULL" : kind === 'candidate' ? "price_revision != 'legacy'" : '1'} AS hash_known,
        ${priceCaptureSql(targetKind)} AS capture_text${social}
        FROM ${table} WHERE id > ? AND status = ? ORDER BY id LIMIT 51`, cursor, status);
      const data = await Promise.all(rows.slice(0, 50).map(async ({ capture_text, hash_known, ...row }) => {
        const capture = filterOfferCapture(capture_text ?? '');
        return { ...row, captureHash: capture && hash_known ? await digest(capture) : null, captureFormat: 'verified-offer-text@2' };
      }));
      return json({ data, next_cursor: rows.length > 50 ? rows[49].id : null });
    }
    if (path === 'admin/deals') {
      const params = new URL(request.url).searchParams;
      const options = { status: params.get('status') ?? 'published', limit: params.has('limit') ? Number(params.get('limit')) : 20, cursor: params.get('cursor') };
      try { validateAdminDealPage(options); } catch { return json({ error: 'invalid_deal_page' }, 400); }
      return json(await adminDealsPage(env.DB, options));
    }
    if (admin && parts[1] === 'deals' && parts.length === 3) {
      const deal = await adminDeal(env.DB, parts[2]);
      return deal ? json({ data: deal }) : json({ error: 'deal_not_found' }, 404);
    }
    if (path === 'admin/sellers') return json({ data: await adminSellersData(env.DB) });
    if (path === 'admin/queue' || path === 'admin/candidates') {
      const list = path === 'admin/queue' ? 'queue' : 'candidates';
      try {
        const options = reviewRequestOptions(new URL(request.url).searchParams, list);
        return json(await (list === 'queue' ? adminQueuePage(env.DB, options) : adminCandidatesPage(env.DB, options)));
      } catch (error) {
        if (error instanceof AdminPaginationError) return json({ error: error.code }, 400);
        throw error;
      }
    }
  }
  if (request.method === 'GET' && path === 'admin/price-sources') {
    const snapshot = await env.DB.prepare('SELECT observed_at,scopes FROM official_price_approvals WHERE id=1')
      .first<{ observed_at: string; scopes: string }>();
    return snapshot ? json({ data: await officialScopeReceipt({ observed_at: snapshot.observed_at, scopes: JSON.parse(snapshot.scopes) },
      new URL(request.url).origin) }) : json({ error: 'price_scope_snapshot_missing' }, 404);
  }
  if (request.method === 'POST' && path === 'admin/price-sources') {
    let payload: unknown;
    try { payload = await body(request, 131072); } catch { return json({ error: 'invalid_source_approvals' }, 400); }
    const error = await syncOfficialPriceScopes(env.DB, payload);
    return error ? json({ error }, error === 'stale_source_approvals' ? 409 : 400) : json({ data: await officialScopeReceipt(payload as Parameters<typeof officialScopeReceipt>[0], new URL(request.url).origin) });
  }
  if (request.method === 'POST' && path === 'admin/price-backfill') {
    let payload;
    try { payload = await body(request, 98304); } catch { return json({ error: 'invalid_evidence' }, 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || 'discount_pct' in payload || !Object.hasOwn(priceTargetTables, payload.kind) ||
        !text(payload.id, 200) || !text(payload.expected_revision, 100) ||
        typeof payload.request_id !== 'string' || !/^[0-9a-f]{64}$/.test(payload.request_id) ||
        payload.capture_reason !== undefined && !['capture_changed','legacy_hash_missing'].includes(payload.capture_reason)) return json({ error: 'invalid_target' }, 400);
    const result = await recordBackfill(env.DB, payload.kind, payload.id, payload.expected_revision, payload.request_id, payload.price_evidence, false, payload.capture_reason);
    return result.error ? json({ error: result.error }, result.error === 'target_not_found' ? 404 : result.error === 'invalid_evidence' ? 400 : 409) : json({ data: result });
  }
  if (request.method === 'POST' && admin && parts[1] === 'deals' && parts.length === 4 && parts[3] === 'round') {
    let value: Record<string, unknown>;
    let source: string | null;
    try {
      value = await body(request);
      if (!value || !Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1) throw new Error('version');
      source = evidenceUrl(value.source_url);
    } catch {
      return json({ error: 'invalid_round' }, 400);
    }
    const status = await updateDealRound(env.DB, parts[2], Number(value.expected_version), value, source);
    return json(status === 200 ? { data: { status: 'saved' } } : { error: 'round_review' }, status);
  }
  if (request.method === 'POST' && admin && parts[1] === 'deals' && parts.length === 3) return manageDeal(request, parts[2], env);
  if (request.method === 'POST' && admin && parts[1] === 'sellers' && (parts.length === 2 || parts.length === 3)) return manageSeller(request, parts, env);
  if (request.method === 'POST' && admin && parts.length === 3 && parts[1] === 'candidates') {
    let b;
    try { b = await body(request); } catch { return json({ error: '32KB 이하 JSON 필요' }, 400); }
    if (!b || typeof b !== 'object' || Array.isArray(b) || 'discount_pct' in b) return json({ error: '잘못된 입력' }, 400);
    if (b.action === PROMOTE_OFFER || b.action === INVALIDATE_OFFER || b.action === CLOSE_OFFER) return mutateVerifiedOffer(env.DB, parts[2], b);
    if (b.action === 'dismiss_verified_offer_v2') return dismissVerifiedOffer(env.DB, parts[2], b);
    if (parts[2].startsWith('verified-')) return json({ error: 'typed_candidate' }, 409);
    if (b.action === 'promote') {
      const requestId = typeof b.request_id === 'string' ? b.request_id : '';
      const promotedBy = typeof b.promoted_by === 'string' ? b.promoted_by.trim() : 'admin';
      if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return json({ error: 'request_id 필요' }, 400);
      if (!validReviewSelection(b)) return json({ error: 'invalid_evidence_selection' }, 400);
      for (const key of ['starts_at', 'ends_at']) {
        if (b[key] !== undefined && b[key] !== null && (typeof b[key] !== 'string' || normalizeTimestamp(b[key]) === null)) return json({ error: 'invalid_schedule' }, 400);
      }
      const bundle = Array.isArray(b.bundle_items) ? b.bundle_items : [];
      const { promoteExternalCandidate } = await import('./promote-external');
      const result = await promoteExternalCandidate(env.DB, {
        candidate_id: parts[2],
        price_evidence_id: b.price_evidence_id as string | null | undefined,
        expected_revision: b.expected_revision as string | undefined,
        promoted_by: promotedBy.slice(0, 120),
        request_id: requestId,
        reason: typeof b.reason === 'string' ? b.reason : null,
        seller_id: typeof b.seller_id === 'string' ? b.seller_id : null,
        model_id: b.model_id === null ? null : typeof b.model_id === 'string' ? b.model_id : null,
        title: typeof b.title === 'string' ? b.title : null,
        price: b.price === null ? null : Number.isSafeInteger(b.price) ? b.price as number : undefined,
        starts_at: b.starts_at === undefined ? undefined : b.starts_at as string | null,
        ends_at: b.ends_at === undefined ? undefined : b.ends_at as string | null,
        source_ended: b.source_ended === true ? true : b.source_ended === false ? false : undefined,
        brand_label: typeof b.brand_label === 'string' ? b.brand_label : null,
        category_label: typeof b.category_label === 'string' ? b.category_label : null,
        bundle_items: bundle.map((row: Record<string, unknown>) => ({
          brand: typeof row.brand === 'string' ? row.brand : null,
          product_name: String(row.product_name ?? ''),
          model_id: typeof row.model_id === 'string' ? row.model_id : null,
          price: row.price === null ? null : Number.isSafeInteger(row.price) ? row.price as number : null,
        })),
      });
      if (!result.ok) return json({ error: result.code, ...(result.detail ?? {}) }, result.status);
      return json({ data: { deal_id: result.deal_id, created: result.created, promotion_id: result.promotion_id } });
    }
    if (b.action !== 'dismiss') return json({ error: 'dismiss 또는 promote 필요' }, 400);
    const candidate = await env.DB.prepare('SELECT status FROM external_candidates WHERE id = ?').bind(parts[2]).first<{ status: string }>();
    if (!candidate) return json({ error: '항목 없음' }, 404);
    if (candidate.status !== 'candidate') return json({ error: '이미 처리된 항목' }, 409);
    const result = await env.DB.prepare("UPDATE external_candidates SET status = 'dismissed', reviewed_at = ? WHERE id = ? AND status = 'candidate'").bind(new Date().toISOString(), parts[2]).run();
    return result.meta.changes ? json({ data: { status: 'dismissed' } }) : json({ error: '이미 처리된 항목' }, 409);
  }
  if (request.method === 'POST' && (path === 'ingest' || (admin && parts.length === 3 && parts[1] === 'review'))) {
    let b;
    try { b = await body(request, path === 'ingest' ? 98304 : 32768); } catch { return json({ error: 'invalid_body' }, 400); }
    if (!b || typeof b !== 'object' || Array.isArray(b) || 'discount_pct' in b) return json({ error: '잘못된 입력' }, 400);
    if (path === 'ingest' && b.kind === 'external_price_observation') return ingestExternalObservation(b, env.DB);
    if (path === 'ingest' && b.kind === OFFER_KIND) return ingestVerifiedOffer(env.DB, b);
    if (path === 'ingest' && b.kind === 'external_listing') return ingestExternal(b, env);
    if (path === 'ingest') {
      if (!safeUrl(b.source_url) || !text(b.account, 100) || !text(b.text, 20000) || !['post', 'story', 'threads_post'].includes(b.kind) || !date(b.captured_at)) return json({ error: 'source_url, account, text, kind, captured_at 확인 필요' }, 400);
      if (b.image_url != null && !isImageUrl(b.image_url)) return json({ error: '잘못된 입력' }, 400);
      let suggestions: string | null = null;
      if (b.suggestions != null) {
        const parsed = parseSuggestions(b.suggestions);
        if (!parsed) return json({ error: 'suggestions 형식 확인 필요(모델·가격·일정·링크·신뢰도 스키마)' }, 400);
        suggestions = JSON.stringify(parsed);
      }
      const u = new URL(b.source_url);
      const threads = b.kind === 'threads_post';
      const thread = threads ? threadsPost(b.source_url, b.account) : null;
      if (threads ? b.platform !== 'threads' || !thread :
          b.platform !== undefined && b.platform !== 'instagram' ||
          !['www.instagram.com', 'instagram.com'].includes(u.hostname) || u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash ||
          !(b.kind === 'story' ? /^\/stories\/[A-Za-z0-9._]+\/[0-9]+\/?$/.test(u.pathname) : /^\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))) return json({ error: 'invalid_source_url' }, 400);
      const canonical = thread?.url ?? `https://www.instagram.com${u.pathname.replace(/\/$/, '')}/`;
      const evidence = b.price_evidence == null ? null : await validatedEvidence(b.price_evidence, canonical);
      if (b.price_evidence != null && (!evidence || evidence.offer && filterOfferCapture(b.text) !== evidence.offer.source.text)) return json({ error: 'invalid_evidence' }, 400);
      if (!await officialPriceAllowed(env.DB, evidence)) return json({ error: 'official_source_not_approved' }, 409);
      const id = crypto.randomUUID(), captured = iso(b.captured_at);
      await env.DB.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,suggestions,image_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_url) DO NOTHING').bind(id, canonical, thread?.account ?? b.account, b.text, b.kind, captured, suggestions, b.image_url ?? null).run();
      const readItem = () => env.DB.prepare('SELECT id,status,captured_at FROM ingested_items WHERE source_url = ?').bind(canonical).first<{ id: string; status: string; captured_at: string }>();
      let item = await readItem();
      const staged = evidence && item?.status === 'pending'
        ? await stageIngestEvidence(env.DB, 'ingest', item.id, evidence, undefined, { text: b.text, capturedAt: captured!, suggestions })
        : null;
      if (evidence && item?.status === 'pending') item = await readItem();
      const observed = evidence && item?.status === 'approved' ? await applyLivePriceObservation(env.DB, item.id, evidence) : null;
      return json({ data: item ? { id: item.id, status: item.status,
        ...(staged?.revision === item.captured_at ? { price_evidence_id: staged.id, revision: staged.revision } : {}),
        ...(observed?.observation_id ? { price_evidence_id: observed.observation_id, revision: observed.revision } : {}),
        ...(observed?.outcome === 'withdrawn' ? { price_target_closed: true } : {}) } : null }, 202);
    }
    if (parts[2].startsWith('verified-') || parts[2].startsWith('deal-verified-')) return json({ error: 'typed_candidate' }, 409);
    if (!['approve', 'reject'].includes(b.action)) return json({ error: 'approve 또는 reject 필요' }, 400);
    if (b.action === 'approve' && !validReviewSelection(b)) return json({ error: 'invalid_evidence_selection' }, 400);
    if ((b.include_image !== undefined && typeof b.include_image !== 'boolean') || 'image_url' in b) return json({ error: '잘못된 입력' }, 400);
    const item = await env.DB.prepare('SELECT * FROM ingested_items WHERE id = ?').bind(parts[2]).first<{ status: string; source_url: string; account: string; kind: string; captured_at: string; text: string }>();
    if (!item) return json({ error: '항목 없음' }, 404);
    const requestId = b.action === 'approve' ? b.request_id : undefined;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(requestId))) return json({ error: 'invalid_request_id' }, 400);
    const key = requestId ? `review-${requestId}` : `review-${parts[2]}`;
    const selectedId = b.price_evidence_id ?? null;
    const reviewHash = await digest(JSON.stringify([parts[2], b.expected_revision ?? item.captured_at, b.model_id, b.seller_id,
      b.title, b.price ?? null, normalizeTimestamp(b.starts_at), normalizeTimestamp(b.ends_at), b.include_image ?? true,
      b.attribution, b.attribution_note ?? null, b.source_ended ?? null, selectedId]));
    const approvalReplay = async () => {
      if (!requestId) return null;
      const previous = await env.DB.prepare("SELECT request_hash FROM deal_revisions WHERE deal_id = ? AND request_id = ? AND action = 'publish'")
        .bind(parts[2], key).first<{ request_hash: string }>();
      if (!previous) return null;
      return previous.request_hash === reviewHash ? json({ data: { status: 'approved', replayed: true } }) :
        json({ error: 'request_id_reused' }, 409);
    };
    const replay = await approvalReplay();
    if (replay) return replay;
    if (item.status !== 'pending') return json({ error: '이미 검수된 항목' }, 409);
    const now = new Date().toISOString();
    if (b.action === 'reject') {
      const result = await env.DB.prepare("UPDATE ingested_items SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'").bind(now, parts[2]).run();
      return result.meta.changes === 1
        ? json({ data: { changed: 1 } })
        : json({ error: '이미 검수된 항목' }, 409);
    }
    const head = await currentReviewEvidence(env.DB, 'ingest', parts[2], item.captured_at);
    const observation = typeof selectedId === 'string' && selectedId !== head?.id ?
      await pendingPriceObservation(env.DB, 'ingest', parts[2], item.captured_at, selectedId) : null;
    const proof = observation ?? head;
    if (b.expected_revision !== undefined && b.expected_revision !== item.captured_at ||
        selectedId !== (proof?.id ?? null)) return json({ error: 'stale_evidence' }, 409);
    if (!await officialPriceAllowed(env.DB, proof?.evidence ?? null)) return json({ error: 'official_source_not_approved' }, 409);
    const facts = proof?.result.facts;
    const startsAt = normalizeTimestamp(b.starts_at);
    const endsAt = facts?.ends_at ?? normalizeTimestamp(b.ends_at);
    const price = facts?.deal_price_krw ?? b.price ?? null;
    if (!text(b.model_id) || !text(b.seller_id) || !text(b.title, 200) ||
        !(price === null || Number.isSafeInteger(price) && price >= 0) ||
        (b.starts_at != null && !startsAt) || (b.ends_at != null && !normalizeTimestamp(b.ends_at)) ||
        (startsAt && endsAt && endsAt <= startsAt)) return json({ error: 'invalid_deal' }, 400);
    const components = facts ? bundleComponents(facts) : [];
    if (facts && (b.price != null && b.price !== price || b.ends_at != null && normalizeTimestamp(b.ends_at) !== endsAt ||
        !await configurationMatches(env.DB, facts, b.model_id, components))) return json({ error: 'evidence_configuration_or_fact_conflict' }, 409);
    const model = await env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(b.model_id).first();
    const seller = await env.DB.prepare('SELECT id FROM sellers WHERE id = ?').bind(b.seller_id).first();
    if (!model || !seller) return json({ error: '등록된 모델·판매자만 게시할 수 있습니다' }, 400);
    const account = normalizeAccount(item.account);
    if (b.attribution === 'account') {
      if (item.kind === 'threads_post' || !account || !await env.DB.prepare('SELECT account FROM seller_accounts WHERE account = ? AND seller_id = ?').bind(account, b.seller_id).first()) return json({ error: '원문 계정과 판매자 연결 검수 필요' }, 400);
    } else if (b.attribution === 'explicit') {
      if (!text(b.attribution_note, 300) || b.attribution_note.trim().length < 10) return json({ error: '명시 귀속 사유 10–300자 필요' }, 400);
    } else return json({ error: '판매자 귀속 방식 선택 필요' }, 400);
    const origin = item.kind === 'threads_post' ? 'threads' : 'instagram';
    const proofId = proof?.id ?? null;
    const { detectSourceEnded } = await import('./promote-external');
    const sourceEnded = detectSourceEnded({ text: proof?.evidence.offer?.source.text ?? item.text, dates_raw: null, ends_at: endsAt },
      typeof b.source_ended === 'boolean' ? b.source_ended : undefined);
    const guard = reviewEvidenceGuard('ingest', parts[2], item.captured_at, proof, !!observation);
    const statements = [
      env.DB.prepare(`INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at,image_url,origin,source_ended,${priceColumns})
        SELECT id,?,?,?,?,source_url,'manual',?,?,?,CASE WHEN ? THEN image_url ELSE NULL END,?,?,?,?,?,?,?,?,?,?,?
        FROM ingested_items WHERE id = ? AND ${guard.sql}
        AND (? = 'explicit' OR (kind <> 'threads_post' AND EXISTS (SELECT 1 FROM seller_accounts WHERE account = ? AND seller_id = ?)))
        ON CONFLICT(id) DO NOTHING`).bind(b.model_id, b.seller_id, b.title, price, now, startsAt, endsAt, b.include_image === false ? 0 : 1, origin, sourceEnded ? 1 : 0,
          ...priceBindings(proof?.result ?? null, proofId, 1), parts[2], ...guard.values, b.attribution, account, b.seller_id),
      env.DB.prepare("UPDATE ingested_items SET status = 'approved', reviewed_at = ?, attribution = ?, attribution_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM deals WHERE id = ?)").bind(now, b.attribution, b.attribution === 'explicit' ? b.attribution_note.trim() : null, parts[2], parts[2]),
      env.DB.prepare(`INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at,price_evidence_id)
        SELECT ?,id,1,'publish',?,?,NULL,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,?,price_evidence_id
        FROM deals WHERE id = ? AND NOT EXISTS (SELECT 1 FROM deal_revisions WHERE deal_id = ?) ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), key, reviewHash, now, parts[2], parts[2]),
    ];
    for (const [position, name] of components.entries()) {
      statements.push(env.DB.prepare(`INSERT INTO deal_bundle_items (id,deal_id,position,product_name)
        SELECT ?,d.id,?,? FROM deals d JOIN deal_revisions r ON r.deal_id = d.id AND r.version = 1
        WHERE d.id = ? AND r.request_id = ? AND r.request_hash = ? ON CONFLICT(deal_id,position) DO NOTHING`)
        .bind(crypto.randomUUID(), position, name, parts[2], key, reviewHash));
    }
    if (proof) statements.push(recordPublishedPrice(env.DB, parts[2], key, evidencedOpening(proof.evidence, startsAt), proof.result.facts?.configuration));
    let results;
    try { results = await env.DB.batch(statements); }
    catch (error) {
      if (/offer_source_conflict/.test(String(error))) return json({ error: 'offer_source_conflict' }, 409);
      throw error;
    }
    if (results[0].meta.changes) return json({ data: { status: 'approved' } });
    const concurrentApproval = await approvalReplay();
    if (concurrentApproval) return concurrentApproval;
    if (b.attribution === 'account' && !await env.DB.prepare('SELECT 1 FROM seller_accounts WHERE account = ? AND seller_id = ?')
      .bind(account, b.seller_id).first()) return json({ error: '원문 계정과 판매자 연결 검수 필요' }, 400);
    return json({ error: 'stale_review' }, 409);
  }
  return json({ error: '지원하지 않는 경로 또는 메서드' }, request.method === 'GET' ? 404 : 405);
}

function validReviewSelection(value: Record<string, unknown>) {
  return (value.price_evidence_id == null || typeof value.price_evidence_id === 'string' && /^[a-f0-9]{64}$/.test(value.price_evidence_id)) &&
    (value.expected_revision === undefined || text(value.expected_revision, 100));
}
