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
  seller_handle?: string | null;
  seller_ordinal?: number;
  campaign_id?: string;
  offer?: ComparedOffer;
  official_badges?: OfficialSellerBadge[];
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

// Public reads exclude withdrawn deals and all lifecycle metadata.
export const PUBLIC_DEAL_COLUMNS = `id, model_id, seller_id, title, deal_price_krw AS price, deal_price_krw, list_price_krw, discount_pct, price_source_url, list_price_source_url, price_checked_at, source_url, image_url, verify_level, checked, starts_at, ends_at,
  origin, source_host, orders_open, COALESCE(source_ended, 0) AS source_ended, brand_label, category_label`;


// Joined IDs distinguish missing rows from rows whose price is unknown.
export const dealSelect = (nowMs = Date.now()) => `
  SELECT d.id, d.model_id, d.seller_id, d.title, d.deal_price_krw AS price, d.deal_price_krw, d.list_price_krw, d.discount_pct,
         d.price_source_url, d.list_price_source_url, d.price_checked_at, d.source_url, d.image_url,
         d.verify_level, d.checked, d.starts_at, d.ends_at,
         d.origin, d.source_host, d.orders_open, COALESCE(d.source_ended, 0) AS source_ended,
         d.brand_label, d.category_label, s.handle AS seller_handle,
         m.id AS model_joined_id, m.name AS model_name,
         m.official_price AS model_official_price, m.checked AS model_checked,
         m.verify_level AS model_verify_level,
         s.id AS seller_joined_id, s.name AS seller_name,
         s.registration_source AS seller_registration_source,
         s.withdrawal_source AS seller_withdrawal_source,
         s.official_import_source AS seller_official_import_source
  FROM deals AS d
  LEFT JOIN models AS m ON m.id = d.model_id
  JOIN canonical_sellers AS seller_map ON seller_map.id=d.seller_id
  JOIN sellers AS s ON s.id = seller_map.canonical_id
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
export type PublicDealOptions = { surface: PublicDealSurface; limit: number; cursor: Cursor | null; modelId: string | null; sort?: DealSort; configuration?: HistoryConfiguration; cursorModel?: string };
export class PublicDealPaginationError extends Error {
  constructor(public code: 'invalid_limit' | 'invalid_cursor' | 'invalid_sort' | 'invalid_configuration') { super(code); }
}
const boundedString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.length > 0 && !/[\u0000-\u001f\u007f]/.test(v);
const canonicalInstant = (v: unknown): v is string => typeof v === 'string' && normalizeTimestamp(v) === v;
function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Validating the search parameters is pure. Callers can reject malformed
// limits, sorts and cursors before resolving a default configuration in D1.
export function validatePublicDealOptions(params: URLSearchParams, surface: PublicDealSurface): void {
  dealOptions(params, surface, null, undefined, true);
}
export function publicDealOptions(params: URLSearchParams, surface: PublicDealSurface, modelId: string | null = null, configuration?: HistoryConfiguration): PublicDealOptions {
  return dealOptions(params, surface, modelId, configuration, false);
}
function dealOptions(params: URLSearchParams, surface: PublicDealSurface, modelId: string | null, configuration: HistoryConfiguration | undefined, anyCursorModel: boolean): PublicDealOptions {
  const cursorModel = configuration && historySelection(configuration);
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
      if (v !== (sort ? 2 : 1) || scope !== surface || order !== (sort ?? 'chronological') ||
          (!anyCursorModel && model !== (cursorModel ?? modelId)) ||
          !(model === null || boundedString(model, anyCursorModel || cursorModel ? 1000 : 200)) || !boundedString(id, 200)) throw new Error();
      if (sort) {
        if (sort === 'discount' && part === 'active' ? !Number.isInteger(rank) || rank < -100 || rank > -1 : rank !== null) throw new Error();
        if (!canonicalInstant(time) || !['active', 'upcoming', 'ended', 'unknown'].includes(part) || !canonicalInstant(key)) throw new Error();
      } else if (time !== null || !['null', 'start'].includes(part) || (part === 'null' ? key !== null : !(typeof key === 'string' && key.length <= 256))) throw new Error();
      cursor = value as Cursor;
      if (encodeCursor(cursor) !== raw) throw new Error();
    } catch { throw new PublicDealPaginationError('invalid_cursor'); }
  }
  return { surface, limit, cursor, modelId, sort, configuration, cursorModel };
}
// Next passes repeated page parameters as arrays. Preserve duplicates for validation.
export function publicPageParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const result = new URLSearchParams();
  for (const key of ['limit', 'cursor', 'sort', 'round']) {
    const value = params[key];
    if (Array.isArray(value)) for (const item of value) result.append(key, item);
    else if (value !== undefined) result.append(key, value);
  }
  return result;
}

type Candidate = { id: string; key: string | null; rank?: number; part: Partition };
async function publicRows<T>(db: D1Database, sql: string, ...values: (string | number | null)[]): Promise<T[]> {
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
  const hydrated = await enrichCampaigns(db, await publicRows<DealWithContext>(db,
    `${dealSelect(nowMs)} AND d.id IN (${rows.map(() => '?').join(',')})`, ...rows.map(row => row.id)), nowMs);
  const result = hydrated.map(deal => {
    if (joined) return deal;
    const { id,model_id,seller_id,title,price,deal_price_krw,list_price_krw,discount_pct,price_source_url,list_price_source_url,
      price_checked_at,source_url,image_url,verify_level,checked,starts_at,ends_at,origin,source_host,source_ended,orders_open,
      brand_label,category_label,seller_handle,seller_name,seller_ordinal,campaign_id,offer,official_badges } = deal;
    return { id,model_id,seller_id,title,price,deal_price_krw,list_price_krw,discount_pct,price_source_url,list_price_source_url,
      price_checked_at,source_url,image_url,verify_level,checked,starts_at,ends_at,origin,source_host,source_ended,orders_open,
      brand_label,category_label,seller_handle,seller_name,seller_ordinal,campaign_id,offer,official_badges };
  }) as unknown as T[];
  const byId = new Map(result.map(row => [row.id, row]));
  // A withdrawal between selection and hydration disappears immediately.
  return rows.flatMap(row => { const deal = byId.get(row.id); return deal ? [deal] : []; });
}
function pageCursor(options: PublicDealOptions, row: Candidate, time: string | null): string {
  if (options.sort) return encodeCursor([2, options.surface, options.sort, options.cursorModel ?? options.modelId, row.part, row.key, row.id, time, row.rank ?? null]);
  return encodeCursor([1, options.surface, 'chronological', options.cursorModel ?? options.modelId, row.part, row.key, row.id, null]);
}
export async function chronologicalDeals<T extends Deal = Deal>(db: D1Database, options: PublicDealOptions, joined = false, nowMs = Date.now()) {
  const { limit, cursor, modelId, configuration } = options;
  const index = modelId === null ? 'verified_deal_chronology' : 'verified_deal_model_chronology';
  const base = `FROM deals INDEXED BY ${index} WHERE ${publicDealEligibility('deals', nowMs)}${modelId === null ? '' : ' AND model_id = ?'}${configuration ? ' AND ' + matchingDealConfiguration : ''}`;
  const scope = [...(modelId === null ? [] : [modelId]),...(configuration ? [configuration.configuration_key,configuration.scope] : [])];
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
const matchingDealConfiguration = `EXISTS (SELECT 1 FROM campaign_offers history
  JOIN campaign_deals member ON member.campaign_id=history.campaign_id AND member.deal_id=history.deal_id
  JOIN offer_price_observations price ON price.offer_id=history.id JOIN campaign_observations support ON support.price_id=price.id
  WHERE history.deal_id=deals.id AND history.configuration_key=? AND history.scope=?
  AND support.proof_id=deals.price_evidence_id AND support.retracted_by IS NULL)`;
export type ModelDealSummary = { model_id: string; active_count: number; lowest_price: number | null };
export async function modelDealSummaries(db: D1Database, modelIds: readonly string[], nowMs: number, configuration?: HistoryConfiguration): Promise<Map<string, ModelDealSummary>> {
  const summaries = new Map([...new Set(modelIds)].map(model_id => [model_id, { model_id, active_count: 0, lowest_price: null } as ModelDealSummary]));
  const ids = [...summaries.keys()];
  const time = new Date(nowMs).toISOString();
  // <= 82 bound values, below D1's 100-parameter limit. One result per model.
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const rows = await publicRows<ModelDealSummary>(db, `SELECT model_id, COUNT(*) AS active_count, MIN(deal_price_krw) AS lowest_price FROM deals INDEXED BY verified_deal_model_active WHERE ${verifiedActive} AND ${publicDealEligibility('deals', nowMs)} AND model_id IN (${batch.map(() => '?').join(',')}) AND ends_at >= ? AND ${activeStart} <= ?${configuration ? ' AND ' + matchingDealConfiguration : ''} GROUP BY model_id`,
      ...batch, time, time, ...(configuration ? [configuration.configuration_key,configuration.scope] : []));
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

// Public historical queries
type ScopedCursor = [string, string, string];
function scopedOptions(params: URLSearchParams, scope: string) {
  const limit = params.get('limit') ?? '20';
  const cursor = params.get('cursor');
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) || ['limit','cursor'].some(k => params.getAll(k).length > 1)) throw new PublicDealPaginationError('invalid_limit');
  let key = '', id = '';
  if (cursor !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error();
      const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))) as ScopedCursor;
      if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== scope || !boundedString(decoded[1], 40) ||
          !boundedString(decoded[2], 200) || scopedCursor(...decoded) !== cursor) throw new Error();
      [, key, id] = decoded;
    } catch { throw new PublicDealPaginationError('invalid_cursor'); }
  }
  return { limit: Number(limit), key, id };
}
function scopedCursor(scope: string, key: string, id: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([scope,key,id])))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

export type OfficialSellerBadge = { digest: string; brand_id: string; campaign_id: string | null; evidence_url: string; title?: string | null };
export type ComparedOffer = { id: string; model_id: string; configuration_key: string; scope: string; amount: number; record_low: boolean };
export const sellerHref = (handle: string) => `/sellers/${encodeURIComponent(handle)}`;
export const roundHref = (handle: string, round: string) => `${sellerHref(handle)}?${new URLSearchParams({ round })}`;

const roundBrands = `SELECT DISTINCT o.campaign_id,m.brand
  FROM accepted_offer_prices o JOIN models m ON m.id=o.model_id`;

export async function campaignDetail(db: D1Database, id: string, now: number) {
  const row = await db.prepare(`${dealSelect(now)} AND d.id=?`).bind(id).first<DealWithContext>();
  return row ? (await enrichCampaigns(db, [row], now))[0] : null;
}

async function enrichCampaigns(db: D1Database, deals: DealWithContext[], now: number) {
  if (!deals.length) return deals;
  const ids = deals.map(deal => deal.id);
  const selected = JSON.stringify(ids);
  const [contexts, badges, offers] = await Promise.all([
    publicRows<{ deal_id: string; campaign_id: string; ordinal: number }>(db, `SELECT cd.deal_id,c.id AS campaign_id,
      (SELECT count(*) FROM accepted_seller_rounds prior WHERE prior.seller_id=c.seller_id
        AND (prior.sort_at,prior.id)<=(c.sort_at,c.id)) AS ordinal
      FROM campaign_deals cd JOIN accepted_seller_rounds c ON c.id=cd.campaign_id
      WHERE cd.deal_id IN (SELECT value FROM json_each(?))`, selected),
    publicRows<OfficialSellerBadge & { deal_id: string }>(db, `SELECT d.id AS deal_id,a.digest,a.brand_id,a.campaign_id,a.evidence_url
      FROM deals d JOIN models model ON model.id=d.model_id JOIN campaign_deals cd ON cd.deal_id=d.id
      JOIN accepted_seller_rounds c ON c.id=cd.campaign_id
      JOIN official_attestations a ON a.seller_id=c.seller_id AND a.brand_id=model.brand AND (a.campaign_id IS NULL OR a.campaign_id=c.id)
      JOIN official_approvals approval ON approval.digest=a.digest AND approval.state='approved'
      JOIN seller_identity_aliases identity ON identity.seller_id=a.seller_id
        AND identity.source_url=json_extract(a.envelope,'$.envelope.claim.seller_identity_url')
      WHERE d.id IN (SELECT value FROM json_each(?)) ORDER BY a.brand_id,a.digest`, selected),
    publicRows<Omit<ComparedOffer,'record_low'> & { deal_id: string; minimum: number }>(db, `SELECT d.id AS deal_id,o.id,
      o.model_id,o.configuration_key,o.scope,d.deal_price_krw AS amount,
      (SELECT MIN(p.amount) FROM accepted_offer_prices p WHERE p.model_id=o.model_id
        AND p.configuration_key=o.configuration_key AND p.scope=o.scope AND p.point_time<=?) AS minimum
      FROM deals d JOIN campaign_offers o ON o.deal_id=d.id JOIN offer_price_observations price ON price.offer_id=o.id
      JOIN campaign_observations support ON support.price_id=price.id AND support.proof_id=d.price_evidence_id AND support.retracted_by IS NULL
      WHERE d.id IN (SELECT value FROM json_each(?)) AND o.model_id=d.model_id AND o.line_id IS NULL
        AND o.campaign_id=(SELECT campaign_id FROM campaign_deals WHERE deal_id=d.id)
      GROUP BY d.id,o.id`, new Date(now).toISOString(), selected),
  ]);
  const contextById = new Map(contexts.map(c => [c.deal_id,c]));
  const offerById = new Map(offers.map(({ deal_id, minimum, ...offer }) => [deal_id, { offer, minimum }]));
  const badgesById = new Map<string, OfficialSellerBadge[]>();
  for (const badge of badges) {
    const list = badgesById.get(badge.deal_id) ?? [];
    list.push(badge);
    badgesById.set(badge.deal_id,list);
  }
  return deals.map(deal => {
    const context = contextById.get(deal.id);
    const matched = offerById.get(deal.id);
    return { ...deal, seller_id: deal.seller_joined_id ?? deal.seller_id,
      seller_ordinal: context?.ordinal, campaign_id: context?.campaign_id,
      official_badges: badgesById.get(deal.id) ?? [],
      ...(matched ? { offer: { ...matched.offer, record_low: isDealPubliclyActive(deal,now) && matched.minimum != null && matched.offer.amount <= matched.minimum } } : {}),
    };
  });
}

export type HistoryConfiguration = {
  model_id: string; name: string; brand: string; configuration_key: string; scope: string;
};
export function historyConfigurations(db: D1Database, model: string | null, seller: string | null = null) {
  return publicRows<HistoryConfiguration>(db, `SELECT DISTINCT p.model_id,m.name,m.brand,p.configuration_key,p.scope
    FROM accepted_offer_prices p JOIN accepted_seller_rounds c ON c.id=p.campaign_id JOIN models m ON m.id=p.model_id
    WHERE (? IS NULL OR p.model_id=?) AND (? IS NULL OR c.seller_id=?)
    ORDER BY m.brand,m.name,p.model_id,p.scope,p.configuration_key`, model,model,seller,seller);
}

export async function sellerProfile(db: D1Database, handle: string, now: number) {
  const seller = await db.prepare(`SELECT canonical.*,public.handle AS requested_handle
    FROM sellers public JOIN canonical_sellers ids ON ids.id=public.id JOIN sellers canonical ON canonical.id=ids.canonical_id
    WHERE public.id=COALESCE((SELECT id FROM sellers WHERE handle=?),
      (SELECT seller_id FROM seller_handle_aliases WHERE handle=?))`).bind(handle,handle).first<import('./data').Seller & { handle: string; requested_handle: string }>();
  if (!seller) return null;
  const [summary, observations, brands, products, badges] = await Promise.all([
    db.prepare(`SELECT count(*) AS total,COALESCE(SUM(NOT EXISTS (
      SELECT 1 FROM accepted_offer_prices p JOIN campaign_offers o ON o.id=p.offer_id
      WHERE p.campaign_id=c.id AND o.closed_at IS NULL AND p.id=(
        SELECT recent.id FROM accepted_offer_prices recent WHERE recent.offer_id=o.id ORDER BY recent.point_time DESC,recent.id DESC LIMIT 1)
      AND p.ends_at>=?
    )),0) AS completed FROM accepted_seller_rounds c WHERE c.seller_id=?`)
      .bind(new Date(now).toISOString(),seller.id).first<{ total: number; completed: number }>(),
    publicRows<{ observed_at: string; precision: 'day' | 'instant' }>(db, `WITH o AS (
      SELECT s.* FROM campaign_observations s JOIN accepted_seller_rounds c ON c.id=s.campaign_id
      WHERE c.seller_id=? AND s.retracted_by IS NULL),
      first AS (SELECT observed_at,precision FROM o ORDER BY point_time,id LIMIT 1),
      last AS (SELECT observed_at,precision FROM o ORDER BY point_time DESC,id DESC LIMIT 1)
      SELECT * FROM first UNION ALL SELECT * FROM last`, seller.id),
    publicRows<{ brand: string }>(db,`SELECT DISTINCT b.brand FROM (${roundBrands}) b
      JOIN accepted_seller_rounds c ON c.id=b.campaign_id WHERE c.seller_id=? ORDER BY b.brand`,seller.id),
    historyConfigurations(db, null, seller.id),
    publicRows<OfficialSellerBadge>(db,`SELECT a.digest,a.brand_id,a.campaign_id,a.evidence_url,c.title
      FROM official_attestations a JOIN official_approvals approval ON approval.digest=a.digest AND approval.state='approved'
      JOIN seller_identity_aliases identity ON identity.seller_id=a.seller_id
        AND identity.source_url=json_extract(a.envelope,'$.envelope.claim.seller_identity_url')
      LEFT JOIN accepted_seller_rounds c ON c.id=a.campaign_id
      WHERE a.seller_id=? AND (a.campaign_id IS NULL OR c.seller_id=a.seller_id AND EXISTS (
        SELECT 1 FROM (${roundBrands}) b WHERE b.campaign_id=c.id AND b.brand=a.brand_id))
      ORDER BY a.brand_id,a.campaign_id,a.digest`,seller.id),
  ]);
  return { seller, ...summary!, first_seen: observations[0] ?? null, last_seen: observations[1] ?? null,
    brands: brands.map(b => b.brand), products, official_badges: badges };
}

type Round = { id: string; title: string; source_url: string; starts_at: string | null; sort_at: string };
export async function sellerCampaignPage(db: D1Database, seller: string, params: URLSearchParams, now: number) {
  const scope = `seller:${seller}`, { limit,key,id } = scopedOptions(params, scope);
  const picked = params.get('round');
  if (params.getAll('round').length>1 || picked!==null && !boundedString(picked,200)) throw new PublicDealPaginationError('invalid_cursor');
  const rows = await publicRows<Round>(db,`SELECT id,title,source_url,starts_at,sort_at FROM accepted_seller_rounds
    WHERE seller_id=? AND ${picked ? 'id=COALESCE((SELECT merged_into FROM seller_campaigns WHERE id=?),?)' : '(sort_at,id)>(?,?)'}
    ORDER BY sort_at,id LIMIT ?`, seller,...(picked ? [picked,picked] : [key,id]),limit+1);
  const page = rows.slice(0,limit);
  const dealRows = page.length ? await publicRows<DealWithContext>(db,`${dealSelect(now)} AND d.id IN (
    SELECT deal_id FROM campaign_deals WHERE campaign_id IN (SELECT value FROM json_each(?))) ORDER BY d.id`, JSON.stringify(page.map(r => r.id))) : [];
  const deals = new Map<string | undefined, DealWithContext[]>();
  for (const deal of await enrichCampaigns(db,dealRows,now)) {
    const list = deals.get(deal.campaign_id) ?? [];
    list.push(deal);
    deals.set(deal.campaign_id,list);
  }
  return { data: page.map(round => ({ ...round, deals: deals.get(round.id) ?? [] })),
    next_cursor: rows.length > limit ? scopedCursor(scope,page.at(-1)!.sort_at,page.at(-1)!.id) : null };
}

export type PricePoint = {
  id: string; campaign_id: string; seller_id: string; seller_name: string; handle: string; title: string;
  observed_at: string; precision: 'day' | 'instant'; point_time: string; amount: number; list_amount: number;
  scope: string; source_url: string; official_url: string;
};
export async function modelPriceHistory(db: D1Database, model: string, configuration: string, params: URLSearchParams,
  now: number, seller: string | null = null, offerScope = 'unit') {
  const scope = JSON.stringify(['history',model,configuration,offerScope,seller]);
  const { limit,key,id } = scopedOptions(params, scope);
  const base = `FROM accepted_offer_prices p JOIN accepted_seller_rounds c ON c.id=p.campaign_id
    JOIN sellers s ON s.id=c.seller_id WHERE p.model_id=? AND p.configuration_key=? AND p.scope=? AND p.point_time<=?`;
  const fields = 'p.id,p.campaign_id,c.seller_id,s.name AS seller_name,s.handle,c.title,p.observed_at,p.precision,p.point_time,p.amount,p.list_amount,p.scope,p.source_url,p.official_url';
  const bindings = [model,configuration,offerScope,new Date(now).toISOString()];
  const scoped = `${base}${seller ? ' AND c.seller_id=?' : ''}`;
  const values = seller ? [...bindings,seller] : bindings;
  const [minimum, count, rows, sampled] = await Promise.all([
    db.prepare(`SELECT ${fields} ${base} ORDER BY p.amount,p.point_time,p.id LIMIT 1`).bind(...bindings).first<PricePoint>(),
    db.prepare(`SELECT COUNT(*) AS count ${scoped}`).bind(...values).first<{ count:number }>(),
    publicRows<PricePoint>(db,`SELECT ${fields} ${scoped} AND (p.point_time,p.id)>(?,?) ORDER BY p.point_time,p.id LIMIT ?`,...values,key,id,limit+1),
    publicRows<PricePoint>(db,`WITH points AS (SELECT ${fields},julianday(p.point_time) AS day ${scoped}),
      bounds AS (SELECT MIN(day) AS first,MAX(day) AS last FROM points),
      buckets AS (SELECT points.*,CAST(31*(day-first)/MAX(last-first,0.000001) AS INTEGER) AS bucket FROM points,bounds),
      ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY amount,point_time,id) lo,
        ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY amount DESC,point_time DESC,id DESC) hi,
        ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY list_amount,point_time,id) list_lo,
        ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY list_amount DESC,point_time DESC,id DESC) list_hi FROM buckets)
      SELECT * FROM ranked WHERE lo=1 OR hi=1 OR list_lo=1 OR list_hi=1 ORDER BY point_time,id`,...values),
  ]);
  const data = rows.slice(0,limit);
  return { data, sampled, minimum, observation_count: count?.count ?? 0,
    next_cursor: rows.length > limit ? scopedCursor(scope,data.at(-1)!.point_time,data.at(-1)!.id) : null };
}

export const historySelection = (entry: HistoryConfiguration) => JSON.stringify([entry.model_id,entry.configuration_key,entry.scope]);
export function selectedHistoryConfiguration(configurations: HistoryConfiguration[], value?: string | string[] | null) {
  if (value == null) return configurations[0];
  const selection = configurations.find(entry => historySelection(entry) === value);
  if (!selection) throw new PublicDealPaginationError('invalid_configuration');
  return selection;
}

export function historyConfigurationParam(params: URLSearchParams) {
  const selections = params.getAll('configuration');
  if (selections.length>1) throw new PublicDealPaginationError('invalid_configuration');
  return selections[0];
}
