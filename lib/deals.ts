import { displayableOfficialPrice, type Deal } from './data';
import { dealsCopy } from './deals-copy';

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
      : state === 'ended' && deal.ends_at ? -parseTimestamp(deal.ends_at) : 0;
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
