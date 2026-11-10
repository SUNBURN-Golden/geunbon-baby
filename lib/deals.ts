import { displayableOfficialPrice, type Deal } from './data';
import { dealsCopy } from './deals-copy';
import { S, E, EFFECTIVE_END, COMPLETE, UPCOMING, END_ONLY, START_ONLY, PERMANENT, SOURCE_ENDED } from './deal-query-sql';

export type Timing = {
  state: 'active' | 'upcoming' | 'ended' | 'unknown';
  days: number | null;
};
export type Gap = {
  relation: 'below' | 'equal' | 'above';
  won: number;
  percent: number;
};

export type DealWithContext = Deal & {
  origin?: 'instagram' | 'external_web';
  source_host?: string | null;
  source_ended?: number;
  brand_label?: string | null;
  category_label?: string | null;
  model_joined_id: string | null;
  model_name: string | null;
  model_official_price: number | null;
  model_checked: string | null;
  model_verify_level: string | null;
  seller_joined_id: string | null;
  seller_name: string | null;
  seller_registration_source: string | null;
  seller_withdrawal_source: string | null;
  seller_official_import_source: string | null;
};

export const dealOfficialPrice = (deal: DealWithContext) =>
  deal.model_joined_id ? displayableOfficialPrice({ official_price: deal.model_official_price, verify_level: deal.model_verify_level }) : null;

// Public reads exclude withdrawn deals and all lifecycle metadata.
export const PUBLIC_DEAL_COLUMNS = `id, model_id, seller_id, title, price, source_url, image_url, verify_level, checked, starts_at, ends_at,
  COALESCE(origin, 'instagram') AS origin, source_host, COALESCE(source_ended, 0) AS source_ended, brand_label, category_label`;
export const PUBLISHED_DEALS = `SELECT ${PUBLIC_DEAL_COLUMNS} FROM deals WHERE status = 'published'`;

// Joined IDs distinguish missing rows from rows whose price is unknown.
export const DEAL_SELECT = `
  SELECT d.id, d.model_id, d.seller_id, d.title, d.price, d.source_url, d.image_url,
         d.verify_level, d.checked, d.starts_at, d.ends_at,
         COALESCE(d.origin, 'instagram') AS origin, d.source_host, COALESCE(d.source_ended, 0) AS source_ended,
         d.brand_label, d.category_label,
         m.id AS model_joined_id, m.name AS model_name,
         m.official_price AS model_official_price, m.checked AS model_checked,
         m.verify_level AS model_verify_level,
         s.id AS seller_joined_id, s.name AS seller_name,
         s.registration_source AS seller_registration_source,
         s.withdrawal_source AS seller_withdrawal_source,
         s.official_import_source AS seller_official_import_source
  FROM deals AS d
  LEFT JOIN models AS m ON m.id = d.model_id
  LEFT JOIN sellers AS s ON s.id = d.seller_id
  WHERE d.status = 'published'`;

export function priceGap(price: number | null, official: number | null): Gap | null {
  if (price === null || official === null || !Number.isFinite(price) ||
      !Number.isFinite(official) || price < 0 || official <= 0) return null;
  const won = official - price;
  const percent = won / official * 100;
  if (!Number.isFinite(percent)) return null;
  return { relation: won > 0 ? 'below' : won < 0 ? 'above' : 'equal', won, percent };
}

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// Deal schedules require an explicit instant. Validate the local calendar before
// Date.parse can silently roll an impossible date into the following month.
export function parseTimestamp(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) ||
      calendar.getUTCDate() !== Number(day)) return NaN;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return NaN;
  const ms = Date.parse(value);
  const utcYear = new Date(ms).getUTCFullYear();
  return utcYear >= 0 && utcYear <= 9999 ? ms : NaN;
}

// Checked dates may omit the time and are then interpreted as UTC midnight.
export function parseDate(value: string): number {
  return parseTimestamp(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = parseTimestamp(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Keep the same result-year range as SQLite and fixed-width text ordering.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso) ? iso : null;
}

function kstDay(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS);
}

export function dealTiming(startsAt: string | null, endsAt: string | null, nowMs: number, sourceEnded = false): Timing {
  if (sourceEnded) return { state: 'ended', days: null };
  const start = startsAt ? parseTimestamp(startsAt) : NaN;
  const end = endsAt ? parseTimestamp(endsAt) : NaN;
  if (!Number.isFinite(nowMs)) return { state: 'unknown', days: null };
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) return { state: 'unknown', days: null };
  if (endsAt && Number.isFinite(end) && nowMs > end && (!startsAt || Number.isFinite(start))) return { state: 'ended', days: null };
  if (startsAt && Number.isFinite(start) && nowMs < start) return { state: 'upcoming', days: kstDay(start) - kstDay(nowMs) };
  if (Number.isFinite(end) && Number.isFinite(start)) {
    return { state: 'active', days: kstDay(end) - kstDay(nowMs) };
  }
  return { state: 'unknown', days: null };
}

export function dealTimingFor(deal: Pick<Deal, 'starts_at' | 'ends_at'> & { source_ended?: number }, nowMs: number) {
  return dealTiming(deal.starts_at, deal.ends_at, nowMs, deal.source_ended === 1);
}

export function isDealPubliclyActive(deal: Pick<Deal, 'starts_at' | 'ends_at'> & { source_ended?: number }, nowMs: number) {
  return dealTimingFor(deal, nowMs).state === 'active';
}

export function sortDeals<T extends Deal>(deals: readonly T[], nowMs: number): T[] {
  const rank = { active: 0, upcoming: 1, ended: 2, unknown: 3 };
  return deals.map(deal => {
    const { state } = dealTimingFor(deal, nowMs);
    const time = state === 'upcoming' && deal.starts_at ? parseTimestamp(deal.starts_at)
      : state === 'active' && deal.ends_at ? parseTimestamp(deal.ends_at)
      : state === 'ended' ? -(deal.ends_at && Number.isFinite(parseTimestamp(deal.ends_at)) ? parseTimestamp(deal.ends_at) : 0) : 0;
    return { deal, rank: rank[state], time };
  }).sort((a, b) => a.rank - b.rank || a.time - b.time ||
    (a.deal.id < b.deal.id ? -1 : a.deal.id > b.deal.id ? 1 : 0)
  ).map(({ deal }) => deal);
}

export function formatGap(gap: Gap): string {
  if (gap.relation === 'equal') return dealsCopy.equal;
  const percent = Math.abs(gap.percent);
  return dealsCopy[gap.relation]
    .replace('{percent}', percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1))
    .replace('{won}', Math.abs(gap.won).toLocaleString('ko-KR'));
}

export function formatDealDate(value: string | null, withTime = false): string | null {
  if (value === null) return null;
  const ms = parseDate(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms + KST_OFFSET_MS);
  const day = `${String(date.getUTCFullYear()).padStart(4, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${String(date.getUTCDate()).padStart(2, '0')}`;
  return withTime ? `${day} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}` : day;
}

// Public historical queries default to 20 and never return more than 50 rows.
// Candidate reads use one lookahead. Lifecycle has eight fixed streams in total
// (1 active, 1 upcoming, 3 ended, 3 unknown): <= 8 * (limit + 1)
// candidate rows, followed by <= limit hydrated rows. No anchor lookup is needed.
export type PublicDealSurface = 'api-deals' | 'api-calendar' | 'api-model' | 'page-calendar' | 'page-model' | 'page-deals';
type Phase = Timing['state'];
type Partition = 'null' | 'start' | Phase;
type Cursor = [1, PublicDealSurface, 'chronological' | 'lifecycle', string | null, Partition, string | null, string, string | null];
export type PublicDealOptions = { surface: PublicDealSurface; limit: number; cursor: Cursor | null; modelId: string | null };
export class PublicDealPaginationError extends Error {
  constructor(public code: 'invalid_limit' | 'invalid_cursor') { super(code); }
}
const boundedString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.length > 0 && !/[\u0000-\u001f\u007f]/.test(v);
const canonicalInstant = (v: unknown): v is string => typeof v === 'string' && normalizeTimestamp(v) === v;
function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function publicDealOptions(params: URLSearchParams, surface: PublicDealSurface, modelId: string | null = null): PublicDealOptions {
  const sizes = params.getAll('limit');
  if (sizes.length > 1 || (sizes.length === 1 && (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(sizes[0])))) throw new PublicDealPaginationError('invalid_limit');
  const limit = sizes.length ? Number(sizes[0]) : 20;
  const cursors = params.getAll('cursor');
  if (cursors.length > 1) throw new PublicDealPaginationError('invalid_cursor');
  let cursor: Cursor | null = null;
  if (cursors.length) {
    const raw = cursors[0];
    try {
      if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(value) || value.length !== 8) throw new Error();
      const [v, scope, order, model, part, key, id, time] = value;
      const lifecycle = surface === 'page-deals';
      if (v !== 1 || scope !== surface || order !== (lifecycle ? 'lifecycle' : 'chronological') || model !== modelId ||
          !(model === null || boundedString(model, 200)) || !boundedString(id, 200)) throw new Error();
      if (lifecycle) {
        if (!canonicalInstant(time) || !['active', 'upcoming', 'ended', 'unknown'].includes(part) || (part === 'unknown' ? key !== null : !canonicalInstant(key))) throw new Error();
      } else if (time !== null || !['null', 'start'].includes(part) || (part === 'null' ? key !== null : !(typeof key === 'string' && key.length <= 256))) throw new Error();
      cursor = value as Cursor;
      if (encodeCursor(cursor) !== raw) throw new Error();
    } catch { throw new PublicDealPaginationError('invalid_cursor'); }
  }
  return { surface, limit, cursor, modelId };
}
// Next passes repeated page parameters as arrays. Preserve duplicates for validation.
export function publicPageParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const result = new URLSearchParams();
  for (const key of ['limit', 'cursor']) {
    const value = params[key];
    if (Array.isArray(value)) for (const item of value) result.append(key, item);
    else if (value !== undefined) result.append(key, value);
  }
  return result;
}

type Candidate = { id: string; key: string | null; part: Partition };
async function publicRows<T>(db: D1Database, sql: string, ...values: (string | number)[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error('Public deal query failed');
  return result.results;
}
async function candidates(db: D1Database, sql: string, values: (string | number)[], part: Partition): Promise<Candidate[]> {
  const rows = await publicRows<{ id: string; key: string | null }>(db, sql, ...values);
  return rows.map(row => ({ ...row, part }));
}
async function hydrate<T extends Deal>(db: D1Database, rows: Candidate[], joined: boolean): Promise<T[]> {
  if (!rows.length) return [];
  const result = await publicRows<T>(db, `${joined ? DEAL_SELECT : PUBLISHED_DEALS} AND ${joined ? 'd.' : ''}id IN (${rows.map(() => '?').join(',')})`, ...rows.map(row => row.id));
  const byId = new Map(result.map(row => [row.id, row]));
  // A withdrawal between selection and hydration disappears immediately.
  return rows.flatMap(row => { const deal = byId.get(row.id); return deal ? [deal] : []; });
}
function pageCursor(options: PublicDealOptions, row: Candidate, time: string | null): string {
  return encodeCursor([1, options.surface, options.surface === 'page-deals' ? 'lifecycle' : 'chronological', options.modelId, row.part, row.key, row.id, time]);
}
export async function chronologicalDeals<T extends Deal = Deal>(db: D1Database, options: PublicDealOptions, joined = false) {
  const { limit, cursor, modelId } = options;
  const index = modelId === null ? 'public_deal_chronology' : 'public_deal_model_chronology';
  const base = `FROM deals INDEXED BY ${index} WHERE status = 'published'${modelId === null ? '' : ' AND model_id = ?'}`;
  const scope = modelId === null ? [] : [modelId];
  const rows: Candidate[] = [];
  if (!cursor || cursor[4] === 'null') {
    rows.push(...await candidates(db, `SELECT id, starts_at AS key ${base} AND starts_at IS NULL${cursor ? ' AND id > ?' : ''} ORDER BY id LIMIT ?`, [...scope, ...(cursor ? [cursor[6]] : []), limit + 1], 'null'));
  }
  if (rows.length < limit + 1) {
    const anchor = cursor?.[4] === 'start' ? cursor : null;
    rows.push(...await candidates(db, `SELECT id, starts_at AS key ${base} AND starts_at IS NOT NULL${anchor ? ' AND (starts_at, id) >= (?, ?) AND (starts_at > ? OR (starts_at = ? AND id > ?))' : ''} ORDER BY starts_at, id LIMIT ?`, [...scope, ...(anchor ? [anchor[5]!, anchor[6], anchor[5]!, anchor[5]!, anchor[6]] : []), limit + 1 - rows.length], 'start'));
  }
  const selected = rows.slice(0, limit);
  const data = await hydrate<T>(db, selected, joined);
  return { data, next_cursor: rows.length > limit && data.length ? pageCursor(options, selected.find(row => row.id === data[data.length - 1].id)!, null) : null };
}

type Stream = { index: string; predicate: string; key: string; dynamic: string; values: string[]; descending?: boolean; idOrder?: boolean };
function lifecycleStreams(phase: Phase, time: string): Stream[] {
  if (phase === 'active') return [{ index: 'public_deal_intervals', predicate: COMPLETE, key: E, dynamic: `${E} >= ? AND ${S} <= ?`, values: [time, time] }];
  if (phase === 'upcoming') return [{ index: 'public_deal_upcoming', predicate: UPCOMING, key: S, dynamic: `${S} > ?`, values: [time] }];
  if (phase === 'ended') return [
    { index: 'public_deal_ended', predicate: COMPLETE, key: E, dynamic: `${E} < ?`, values: [time], descending: true },
    { index: 'public_deal_end_only_ended', predicate: END_ONLY, key: E, dynamic: `${E} < ?`, values: [time], descending: true },
    { index: 'public_deal_source_ended', predicate: SOURCE_ENDED, key: EFFECTIVE_END, dynamic: '1', values: [], descending: true },
  ];
  return [
    { index: 'public_deal_permanent_unknown', predicate: PERMANENT, key: 'NULL', dynamic: '1', values: [], idOrder: true },
    { index: 'public_deal_start_only', predicate: START_ONLY, key: 'NULL', dynamic: `${S} <= ?`, values: [time], idOrder: true },
    { index: 'public_deal_end_only_unknown', predicate: END_ONLY, key: 'NULL', dynamic: `${E} >= ?`, values: [time], idOrder: true },
  ];
}
function compareCandidates(a: Candidate, b: Candidate, descending = false) {
  const cmp = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  return (descending ? -1 : 1) * cmp(a.key ?? '', b.key ?? '') || cmp(a.id, b.id);
}
export async function lifecycleDeals(db: D1Database, options: PublicDealOptions, nowMs: number) {
  const time = options.cursor?.[7] ?? normalizeTimestamp(new Date(nowMs).toISOString())!;
  const phases: Phase[] = ['active', 'upcoming', 'ended', 'unknown'];
  const rows: Candidate[] = [];
  for (const phase of phases.slice(options.cursor ? phases.indexOf(options.cursor[4] as Phase) : 0)) {
    const capacity = options.limit + 1 - rows.length;
    const anchor = options.cursor?.[4] === phase ? options.cursor : null;
    const streams = lifecycleStreams(phase, time);
    const merged: Candidate[] = [];
    for (const stream of streams) {
      const { index, predicate, key, dynamic, values, descending, idOrder } = stream;
      const base = `SELECT id, ${key} AS key FROM deals INDEXED BY ${index} WHERE ${predicate} AND ${dynamic}`;
      const order = ` ORDER BY ${idOrder ? 'id' : `${key} ${descending ? 'DESC' : 'ASC'}, id ASC`} LIMIT ?`;
      if (anchor && descending) {
        // Mixed DESC time / ASC ID needs two seeks. First exhaust the tied
        // instant by ID, then seek strictly older instants. Each logical stream
        // still transfers <= capacity rows, even with arbitrarily large ties.
        const tied = await candidates(db, `${base} AND ${key} = ? AND id > ? ORDER BY id ASC LIMIT ?`, [...values, anchor[5]!, anchor[6], capacity], phase);
        merged.push(...tied);
        if (tied.length < capacity) merged.push(...await candidates(db, `${base} AND ${key} < ?${order}`, [...values, anchor[5]!, capacity - tied.length], phase));
      } else {
        // The inclusive tuple gives SQLite a composite seek through arbitrarily
        // large ties before the explicit exclusive continuation predicate.
        const seek = !anchor ? '' : idOrder ? ' AND id > ?' : ` AND (${key}, id) >= (?, ?) AND (${key} > ? OR (${key} = ? AND id > ?))`;
        const bound = !anchor ? [] : idOrder ? [anchor[6]] : [anchor[5]!, anchor[6], anchor[5]!, anchor[5]!, anchor[6]];
        merged.push(...await candidates(db, `${base}${seek}${order}`, [...values, ...bound, capacity], phase));
      }
    }
    merged.sort((a, b) => compareCandidates(a, b, phase === 'ended'));
    rows.push(...merged.slice(0, capacity));
    if (rows.length > options.limit) break;
  }
  const selected = rows.slice(0, options.limit);
  const data = await hydrate<DealWithContext>(db, selected, true);
  return { data, next_cursor: rows.length > options.limit && data.length ? pageCursor(options, selected.find(row => row.id === data[data.length - 1].id)!, time) : null, nowMs: parseTimestamp(time) };
}
export async function activeDealCount(db: D1Database, nowMs: number): Promise<number> {
  const time = new Date(nowMs).toISOString();
  const result = await db.prepare(`SELECT COUNT(*) AS count FROM deals INDEXED BY public_deal_intervals WHERE ${COMPLETE} AND ${E} >= ? AND ${S} <= ?`).bind(time, time).first<{ count: number }>();
  if (!result) throw new Error('active count unavailable');
  return result.count;
}
export type ModelDealSummary = { model_id: string; active_count: number; lowest_price: number | null };
export async function modelDealSummaries(db: D1Database, modelIds: readonly string[], nowMs: number): Promise<Map<string, ModelDealSummary>> {
  const summaries = new Map([...new Set(modelIds)].map(model_id => [model_id, { model_id, active_count: 0, lowest_price: null } as ModelDealSummary]));
  const ids = [...summaries.keys()];
  const time = new Date(nowMs).toISOString();
  // <= 82 bound values, below D1's 100-parameter limit. One result per model.
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const rows = await publicRows<ModelDealSummary>(db, `SELECT model_id, COUNT(*) AS active_count, MIN(CASE WHEN price >= 0 THEN price END) AS lowest_price FROM deals INDEXED BY public_deal_model_intervals WHERE ${COMPLETE} AND model_id IN (${batch.map(() => '?').join(',')}) AND ${E} >= ? AND ${S} <= ? GROUP BY model_id`, ...batch, time, time);
    for (const row of rows) summaries.set(row.model_id, row);
  }
  return summaries;
}
export async function activeDealPreview(db: D1Database, nowMs: number): Promise<DealWithContext[]> {
  const time = new Date(nowMs).toISOString();
  const rows = await candidates(db, `SELECT id, ${E} AS key FROM deals INDEXED BY public_deal_intervals WHERE ${COMPLETE} AND ${E} >= ? AND ${S} <= ? ORDER BY ${E}, id LIMIT ?`, [time, time, 12], 'active');
  return hydrate<DealWithContext>(db, rows, true);
}
