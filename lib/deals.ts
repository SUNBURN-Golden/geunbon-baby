import { ROUND_LINK, sellerOrdinal, validPublicationProof } from './deal-evidence-sql';
import type { Deal } from './data';
import { dealsCopy } from './deals-copy';
import { activeStart, publicDealEligibility, verifiedActive, verifiedInterval, verifiedEndOnly, verifiedClosed, verifiedUnknown, verifiedStart } from './verified-deal-sql';

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
  origin?: Deal['origin'];
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
  seller_round_number?: number | null;
  seller_registration_source: string | null;
  seller_withdrawal_source: string | null;
  seller_official_import_source: string | null;
};

// Public reads exclude withdrawn deals and all lifecycle metadata.
export const PUBLIC_DEAL_COLUMNS = `id, model_id, seller_id, title, deal_price_krw AS price, deal_price_krw, list_price_krw, discount_pct, price_source_url, list_price_source_url, price_checked_at, source_url, image_url, verify_level, checked, starts_at, ends_at,
  origin, source_host, orders_open, COALESCE(source_ended, 0) AS source_ended, brand_label, category_label`;
const publishedDeals = (nowMs: number) => `SELECT ${PUBLIC_DEAL_COLUMNS} FROM deals WHERE ${publicDealEligibility('deals', nowMs)}`;

// A shared placeholder seller may supply the /sellers trust anchor, but its
// name and evidence are not listing-specific and it cannot earn a round count.
export const placeholderSeller = "d.seller_id GLOB 'ext-*-unknown'";

// Joined IDs distinguish missing rows from rows whose price is unknown.
export const dealFields = (asOf: string) => ({
  id: 'd.id', model_id: 'd.model_id', seller_id: 'd.seller_id', title: 'd.title',
  price: 'd.deal_price_krw', deal_price_krw: 'd.deal_price_krw', list_price_krw: 'd.list_price_krw',
  discount_pct: 'd.discount_pct', price_source_url: 'd.price_source_url',
  list_price_source_url: 'd.list_price_source_url', price_checked_at: 'd.price_checked_at',
  source_url: 'd.source_url', image_url: 'd.image_url', verify_level: 'd.verify_level', checked: 'd.checked',
  starts_at: 'd.starts_at', ends_at: 'd.ends_at', origin: 'd.origin', source_host: 'd.source_host',
  orders_open: 'd.orders_open', source_ended: 'COALESCE(d.source_ended,0)',
  brand_label: 'd.brand_label', category_label: 'd.category_label',
  model_joined_id: 'm.id', model_name: 'm.name', model_official_price: 'm.official_price',
  model_checked: 'm.checked', model_verify_level: 'm.verify_level',
  seller_joined_id: 's.id',
  seller_name: `CASE WHEN ${placeholderSeller} THEN d.published_seller_label ELSE COALESCE(s.name,d.published_seller_label) END`,
  seller_registration_source: `CASE WHEN ${placeholderSeller} THEN NULL ELSE s.registration_source END`,
  seller_withdrawal_source: `CASE WHEN ${placeholderSeller} THEN NULL ELSE s.withdrawal_source END`,
  seller_official_import_source: `CASE WHEN ${placeholderSeller} THEN NULL ELSE s.official_import_source END`,
  seller_round_number: `CASE WHEN ${placeholderSeller} THEN NULL ELSE NULLIF(${sellerOrdinal(asOf)},0) END`,
});

export const dealContextJoins = `
  LEFT JOIN models AS m ON m.id = d.model_id
  LEFT JOIN sellers AS s ON s.id = d.seller_id
  ${ROUND_LINK}`;

export const dealSelect = (nowMs = Date.now()) => `
  SELECT ${Object.entries(dealFields(`'${new Date(nowMs).toISOString()}'`)).map(([key, expression]) => `${expression} AS ${key}`).join(', ')}
  FROM deals AS d ${dealContextJoins}
  WHERE ${publicDealEligibility('d', nowMs)}`;

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

export function dealTiming(startsAt: string | null, endsAt: string | null, nowMs: number, sourceEnded = false, ordersOpen = false): Timing {
  if (sourceEnded) return { state: 'ended', days: null };
  const start = startsAt ? parseTimestamp(startsAt) : NaN;
  const end = endsAt ? parseTimestamp(endsAt) : NaN;
  if (!Number.isFinite(nowMs)) return { state: 'unknown', days: null };
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) return { state: 'unknown', days: null };
  if (endsAt && Number.isFinite(end) && nowMs > end) return { state: 'ended', days: null };
  if (startsAt && Number.isFinite(start) && nowMs < start) return { state: 'upcoming', days: kstDay(start) - kstDay(nowMs) };
  if (Number.isFinite(end) && (Number.isFinite(start) || startsAt === null && ordersOpen)) {
    return { state: 'active', days: kstDay(end) - kstDay(nowMs) };
  }
  return { state: 'unknown', days: null };
}

export function dealTimingFor(deal: Pick<Deal, 'starts_at' | 'ends_at' | 'source_ended' | 'orders_open'>, nowMs: number) {
  return dealTiming(deal.starts_at, deal.ends_at, nowMs, deal.source_ended === 1, deal.orders_open === 1);
}

export function isDealPubliclyActive(deal: Pick<Deal, 'starts_at' | 'ends_at' | 'source_ended' | 'orders_open'>, nowMs: number) {
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
export type DealSort = 'discount' | 'ending';
type Cursor = [1 | 2, PublicDealSurface, 'chronological' | DealSort, string | null, Partition, string | null, string, string | null, (number | null)?];
export type PublicDealOptions = { surface: PublicDealSurface; limit: number; cursor: Cursor | null; modelId: string | null; sort?: DealSort };
export class PublicDealPaginationError extends Error {
  constructor(public code: 'invalid_limit' | 'invalid_cursor' | 'invalid_sort') { super(code); }
}
const boundedString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.length > 0 && !/[\u0000-\u001f\u007f]/.test(v);
const canonicalInstant = (v: unknown): v is string => typeof v === 'string' && normalizeTimestamp(v) === v;
function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function publicDealOptions(params: URLSearchParams, surface: PublicDealSurface, modelId: string | null = null): PublicDealOptions {
  const sorts = params.getAll('sort');
  const sortable = surface === 'page-deals' || surface === 'api-deals';
  if (sorts.length && (!sortable || sorts.length !== 1 || !['discount', 'ending'].includes(sorts[0]))) throw new PublicDealPaginationError('invalid_sort');
  const sort = sorts[0] as DealSort | undefined ?? (surface === 'page-deals' ? 'discount' : undefined);
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
      if (!Array.isArray(value) || value.length !== (sort ? 9 : 8)) throw new Error();
      const [v, scope, order, model, part, key, id, time, rank] = value;
      if (v !== (sort ? 2 : 1) || scope !== surface || order !== (sort ?? 'chronological') || model !== modelId ||
          !(model === null || boundedString(model, 200)) || !boundedString(id, 200)) throw new Error();
      if (sort) {
        if (sort === 'discount' && part === 'active' ? !Number.isInteger(rank) || rank < -100 || rank > -1 : rank !== null) throw new Error();
        if (!canonicalInstant(time) || !['active', 'upcoming', 'ended', 'unknown'].includes(part) || !canonicalInstant(key)) throw new Error();
      } else if (time !== null || !['null', 'start'].includes(part) || (part === 'null' ? key !== null : !(typeof key === 'string' && key.length <= 256))) throw new Error();
      cursor = value as Cursor;
      if (encodeCursor(cursor) !== raw) throw new Error();
    } catch { throw new PublicDealPaginationError('invalid_cursor'); }
  }
  return { surface, limit, cursor, modelId, sort };
}
// Next passes repeated page parameters as arrays. Preserve duplicates for validation.
export function publicPageParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const result = new URLSearchParams();
  for (const key of ['limit', 'cursor', 'sort']) {
    const value = params[key];
    if (Array.isArray(value)) for (const item of value) result.append(key, item);
    else if (value !== undefined) result.append(key, value);
  }
  return result;
}

type Candidate = { id: string; key: string | null; rank?: number; part: Partition };
async function publicRows<T>(db: D1Database, sql: string, ...values: (string | number)[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error('Public deal query failed');
  return result.results;
}
async function candidates(db: D1Database, sql: string, values: (string | number)[], part: Partition): Promise<Candidate[]> {
  const rows = await publicRows<{ id: string; key: string | null; rank?: number }>(db, sql, ...values);
  return rows.map(row => ({ ...row, part }));
}
async function hydrate<T extends Deal>(db: D1Database, rows: Candidate[], joined: boolean, nowMs: number): Promise<T[]> {
  if (!rows.length) return [];
  const result = await publicRows<T>(db, `${joined ? dealSelect(nowMs) : publishedDeals(nowMs)} AND ${joined ? 'd.' : ''}id IN (${rows.map(() => '?').join(',')})`, ...rows.map(row => row.id));
  const byId = new Map(result.map(row => [row.id, row]));
  // A withdrawal between selection and hydration disappears immediately.
  return rows.flatMap(row => { const deal = byId.get(row.id); return deal ? [deal] : []; });
}
function pageCursor(options: PublicDealOptions, row: Candidate, time: string | null): string {
  if (options.sort) return encodeCursor([2, options.surface, options.sort, options.modelId, row.part, row.key, row.id, time, row.rank ?? null]);
  return encodeCursor([1, options.surface, 'chronological', options.modelId, row.part, row.key, row.id, null]);
}
export async function chronologicalDeals<T extends Deal = Deal>(db: D1Database, options: PublicDealOptions, joined = false, nowMs = Date.now()) {
  const { limit, cursor, modelId } = options;
  const index = modelId === null ? 'verified_deal_chronology' : 'verified_deal_model_chronology';
  const base = `FROM deals INDEXED BY ${index} WHERE ${publicDealEligibility('deals', nowMs)}${modelId === null ? '' : ' AND model_id = ?'}`;
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
  const data = await hydrate<T>(db, selected, joined, nowMs);
  return { data, next_cursor: rows.length > limit ? pageCursor(options, selected.at(-1)!, null) : null };
}

type Stream = { index: string; predicate: string; key: string; dynamic: string; values: string[]; descending?: boolean; ranked?: boolean };
// A public integer discount is in [1, 100]. SQLite seeks to the end-time
// lower bound within each rank and emits index order without sorting history.
const discountRankValues = Array.from({ length: 100 }, (_, i) => i - 100);
const discountRanks = (after = -101) => discountRankValues.slice(after + 101).join(',');
function lifecycleStreams(phase: Phase, time: string, sort: DealSort): Stream[] {
  if (phase === 'active') return [{
    index: sort === 'discount' ? 'verified_deal_discount' : 'verified_deal_ending',
    predicate: verifiedActive, key: 'ends_at', dynamic: `ends_at >= ? AND ${activeStart} <= ?`, values: [time, time], ranked: sort === 'discount',
  }];
  if (phase === 'upcoming') return [{ index: 'verified_deal_upcoming', predicate: verifiedInterval, key: verifiedStart, dynamic: `${verifiedStart} > ?`, values: [time] }];
  if (phase === 'ended') return [
    { index: 'verified_deal_ended', predicate: verifiedInterval, key: 'ends_at', dynamic: 'ends_at < ?', values: [time], descending: true },
    { index: 'verified_deal_end_only_ended', predicate: verifiedEndOnly, key: 'ends_at', dynamic: 'ends_at < ?', values: [time], descending: true },
    { index: 'verified_deal_closed', predicate: verifiedClosed, key: 'ends_at', dynamic: '1', values: [], descending: true },
  ];
  return [
    { index: 'verified_deal_unknown', predicate: verifiedUnknown, key: 'ends_at', dynamic: '1', values: [] },
    { index: 'verified_deal_end_only_unknown', predicate: verifiedEndOnly, key: 'ends_at', dynamic: 'ends_at >= ? AND orders_open = 0', values: [time] },
  ];
}
function compareCandidates(a: Candidate, b: Candidate, descending = false) {
  const cmp = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  return (a.rank ?? 0) - (b.rank ?? 0) || (descending ? -1 : 1) * cmp(a.key ?? '', b.key ?? '') || cmp(a.id, b.id);
}
export async function lifecycleDeals<T extends Deal = DealWithContext>(db: D1Database, options: PublicDealOptions, nowMs: number, joined = true) {
  const time = options.cursor?.[7] ?? normalizeTimestamp(new Date(nowMs).toISOString())!;
  const phases: Phase[] = ['active', 'upcoming', 'ended', 'unknown'];
  const rows: Candidate[] = [];
  for (const phase of phases.slice(options.cursor ? phases.indexOf(options.cursor[4] as Phase) : 0)) {
    const capacity = options.limit + 1 - rows.length;
    const anchor = options.cursor?.[4] === phase ? options.cursor : null;
    const streams = lifecycleStreams(phase, time, options.sort ?? 'discount');
    const merged: Candidate[] = [];
    for (const stream of streams) {
      const { index, predicate, key, dynamic, values, descending, ranked } = stream;
      const base = `SELECT id, ${key} AS key${ranked ? ',(-discount_pct) AS rank' : ''} FROM deals INDEXED BY ${index} WHERE ${predicate} AND ${publicDealEligibility('deals', nowMs)} AND ${dynamic}`;
      const order = ` ORDER BY ${ranked ? '(-discount_pct), ' : ''}${key} ${descending ? 'DESC' : 'ASC'}, id ASC LIMIT ?`;
      if (anchor && descending) {
        // Mixed DESC time / ASC ID needs two seeks. First exhaust the tied
        // instant by ID, then seek strictly older instants. Each logical stream
        // still transfers <= capacity rows, even with arbitrarily large ties.
        const tied = await candidates(db, `${base} AND ${key} = ? AND id > ? ORDER BY id ASC LIMIT ?`, [...values, anchor[5]!, anchor[6], capacity], phase);
        merged.push(...tied);
        if (tied.length < capacity) merged.push(...await candidates(db, `${base} AND ${key} < ?${order}`, [...values, anchor[5]!, capacity - tied.length], phase));
      } else if (anchor && ranked) {
        const tied = await candidates(db, `${base} AND (-discount_pct) = ? AND (ends_at, id) > (?, ?) ORDER BY ends_at, id LIMIT ?`, [...values, anchor[8]!, anchor[5]!, anchor[6], capacity], phase);
        merged.push(...tied);
        const lowerRanks = discountRanks(anchor[8]!);
        if (tied.length < capacity && lowerRanks) merged.push(...await candidates(db, `${base} AND (-discount_pct) IN (${lowerRanks})${order}`, [...values, capacity - tied.length], phase));
      } else {
        // The inclusive tuple gives SQLite a composite seek through arbitrarily
        // large ties before the explicit exclusive continuation predicate.
        const seek = !anchor ? '' : ` AND (${key}, id) >= (?, ?) AND (${key} > ? OR (${key} = ? AND id > ?))`;
        const bound = !anchor ? [] : [anchor[5]!, anchor[6], anchor[5]!, anchor[5]!, anchor[6]];
        const ranks = ranked ? ` AND (-discount_pct) IN (${discountRanks()})` : '';
        merged.push(...await candidates(db, `${base}${seek}${ranks}${order}`, [...values, ...bound, capacity], phase));
      }
    }
    merged.sort((a, b) => compareCandidates(a, b, phase === 'ended'));
    rows.push(...merged.slice(0, capacity));
    if (rows.length > options.limit) break;
  }
  const selected = rows.slice(0, options.limit);
  const data = await hydrate<T>(db, selected, joined, nowMs);
  return { data, next_cursor: rows.length > options.limit ? pageCursor(options, selected.at(-1)!, time) : null, nowMs: parseTimestamp(time) };
}
export async function activeDealCount(db: D1Database, nowMs: number, eligibilityNow = nowMs): Promise<number> {
  const time = new Date(nowMs).toISOString();
  const result = await db.prepare(`SELECT COUNT(*) AS count FROM deals INDEXED BY verified_deal_ending WHERE ${verifiedActive} AND ${publicDealEligibility('deals', eligibilityNow)} AND ends_at >= ? AND ${activeStart} <= ?`).bind(time, time).first<{ count: number }>();
  if (!result) throw new Error('active count unavailable');
  return result.count;
}
export type ModelDealSummary = { model_id: string; active_count: number; lowest_price: number | null; confirmed_price?: number | null };
// `confirmed_price` needs a configuration match recorded in
// model_official_configurations. No production writer exists yet because
// catalog evidence cannot distinguish variants, so /models deliberately keeps
// its 공식가 as plain text until such evidence is available.
export async function modelDealSummaries(db: D1Database, modelIds: readonly string[], nowMs: number, compareCatalog = false): Promise<Map<string, ModelDealSummary>> {
  const summaries = new Map([...new Set(modelIds)].map(model_id => [model_id, { model_id, active_count: 0, lowest_price: null } as ModelDealSummary]));
  const ids = [...summaries.keys()];
  const time = new Date(nowMs).toISOString();
  // <= 82 bound values, below D1's 100-parameter limit. One result per model.
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const active = `SELECT id, model_id, deal_price_krw FROM deals INDEXED BY verified_deal_model_active
      WHERE ${verifiedActive} AND ${publicDealEligibility('deals', nowMs)}
      AND model_id IN (${batch.map(() => '?').join(',')}) AND ends_at >= ? AND ${activeStart} <= ?`;
    const totals = 'SELECT model_id, COUNT(*) AS active_count, MIN(deal_price_krw) AS lowest_price FROM active GROUP BY model_id';
    const query = `WITH active AS (${active}), totals AS (${totals})
      SELECT totals.*${compareCatalog ? `, (SELECT picked.deal_price_krw
        FROM active AS picked JOIN deals d ON d.id=picked.id
        JOIN models model ON model.id=picked.model_id AND model.verify_level='page_body'
        JOIN model_official_configurations config ON config.model_id=model.id
          AND config.source_url=model.source_url AND config.checked=model.checked
        JOIN deal_price_history h ON h.deal_id=d.id AND h.deal_version=d.version AND h.price_evidence_id=d.price_evidence_id
          AND h.configuration_key=config.configuration_key
        WHERE picked.id=(SELECT a.id FROM active a WHERE a.model_id=totals.model_id AND a.deal_price_krw=totals.lowest_price ORDER BY a.id LIMIT 1)
          AND d.list_price_source_url=model.source_url AND d.list_price_krw=model.official_price
          AND ${validPublicationProof('h')}) AS confirmed_price` : ''}
      FROM totals`;
    const rows = await publicRows<ModelDealSummary>(db, query, ...batch, time, time);
    for (const row of rows) summaries.set(row.model_id, row);
  }
  return summaries;
}
export async function activeDealPreview(db: D1Database, nowMs: number): Promise<DealWithContext[]> {
  const time = new Date(nowMs).toISOString();
  const rows = await candidates(db, `SELECT id, ends_at AS key FROM deals INDEXED BY verified_deal_discount WHERE ${verifiedActive} AND ${publicDealEligibility('deals', nowMs)} AND ends_at >= ? AND ${activeStart} <= ? AND (-discount_pct) IN (${discountRanks()}) ORDER BY (-discount_pct), ends_at, id LIMIT ?`, [time, time, 12], 'active');
  return hydrate<DealWithContext>(db, rows, true, nowMs);
}

export function publicActiveDeals(db: D1Database, nowMs: number) {
  const time = new Date(nowMs).toISOString();
  return publicRows<Deal>(db, `SELECT ${PUBLIC_DEAL_COLUMNS} FROM deals INDEXED BY verified_deal_discount
    WHERE ${publicDealEligibility('deals', nowMs)} AND ${verifiedActive} AND ends_at >= ? AND ${activeStart} <= ?
      AND (-discount_pct) IN (${discountRanks()}) ORDER BY (-discount_pct), ends_at, id`, time, time);
}

export function publicDealIds(db: D1Database, nowMs = Date.now()) {
  return publicRows<{ id: string }>(db, `SELECT id FROM deals WHERE ${publicDealEligibility('deals', nowMs)} ORDER BY id`);
}

export async function nextDealDeadline(db: D1Database, nowMs: number) {
  const time = new Date(nowMs).toISOString();
  const earliest = (index: string, predicate: string) => `SELECT ends_at FROM deals INDEXED BY ${index}
    WHERE ${predicate} AND ${publicDealEligibility('deals', nowMs)} AND ends_at >= ? ORDER BY ends_at, id LIMIT 1`;
  const row = await db.prepare(`SELECT MIN(ends_at) AS ends_at FROM (
    SELECT ends_at FROM (${earliest('verified_deal_ending', verifiedActive)})
    UNION ALL
    SELECT ends_at FROM (${earliest('verified_deal_end_only_unknown', verifiedEndOnly)})
  )`).bind(time, time).first<{ ends_at: string | null }>();
  return row?.ends_at ?? null;
}

export async function endedDealCount(db: D1Database, nowMs: number) {
  const time = new Date(nowMs).toISOString();
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM deals WHERE ${publicDealEligibility('deals', nowMs)}
    AND (source_ended = 1 OR (ends_at < ? AND (${verifiedStart} IS NULL OR ${verifiedStart} <= ends_at)))`)
    .bind(time).first<{ count: number }>();
  if (!row) throw new Error('ended count unavailable');
  return row.count;
}
