import { normalizeTimestamp, parseDate } from './deals';

export class HistoryError extends Error {
  constructor(public code: string, public status = 400, public detail: Record<string, unknown> = {}) { super(code); }
}
export const reject = (code: string, status = 400): never => { throw new HistoryError(code, status); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid_review');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return reject('invalid_review');
  return value.trim();
}
export function key(value: unknown): string {
  const id = string(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) return reject('invalid_key');
  return id;
}
export function safeSource(value: unknown): string {
  const input = string(value, 2048);
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
        /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+$/i.test(url.hostname) &&
        !/\.(?:local|internal|localhost|test|invalid)$/i.test(url.hostname)) return url.href;
  } catch { /* validation below */ }
  return reject('invalid_source');
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return entry;
  });
}
export async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export const statement = (db: D1Database, sql: string, ...bindings: (string | number | null)[]) =>
  db.prepare(sql).bind(...bindings);
export function guard(db: D1Database, predicate: string, ...bindings: (string | number | null)[]) {
  return statement(db, `INSERT INTO history_write_guard SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END`, ...bindings);
}
export async function replay<T>(db: D1Database, id: string, hash: string): Promise<T | null> {
  const row = await statement(db, 'SELECT digest,result FROM history_receipts WHERE id = ?', id).first<{ digest: string; result: string }>();
  if (!row) return null;
  if (row.digest !== hash) reject('request_id_reused', 409);
  return JSON.parse(row.result) as T;
}
export async function commit<T>(db: D1Database, writes: D1PreparedStatement[], id: string, hash: string,
  result: T, actor: string, reason: string, now: string) {
  try {
    await db.batch([...writes, statement(db, 'INSERT INTO history_receipts VALUES (?,?,?,?,?,?)',
      id, hash, JSON.stringify(result), actor, reason, now)]);
  } catch (error) {
    const existing = await replay<T>(db, id, hash);
    if (existing) return { result: existing, replayed: true };
    if (error instanceof Error && /history_precondition|UNIQUE constraint failed: (campaign_|external_promotions|history_receipts)/.test(error.message)) {
      return reject('stale_review', 409);
    }
    throw error;
  }
  return { result, replayed: false };
}
export function decision(value: Record<string, unknown>) {
  const request_id = key(value.request_id);
  const reason = string(value.reason, 300);
  if (reason.length < 10) reject('review_reason_required');
  return { request_id, reason, actor: value.actor === undefined ? 'admin' : string(value.actor, 120) };
}
export function observation(value: unknown) {
  const b = object(value);
  const precision = b.precision;
  let observed_at: string | null = null;
  if (precision === 'day' && typeof b.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.observed_at) && Number.isFinite(parseDate(b.observed_at))) {
    observed_at = b.observed_at;
  } else if (precision === 'instant') {
    observed_at = normalizeTimestamp(b.observed_at);
  }
  if (observed_at === null && !(precision === null && b.observed_at === null)) return reject('invalid_observation_date');
  return { namespace: key(b.namespace), record_key: key(b.record_key), revision_key: key(b.revision_key),
    item_key: key(b.item_key), source_url: safeSource(b.source_url), observed_at, precision: precision as 'day' | 'instant' | null };
}
export type Observation = ReturnType<typeof observation>;
