import type { Deal } from './data';
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
  model_joined_id: string | null;
  model_name: string | null;
  model_official_price: number | null;
  model_checked: string | null;
  model_verify_level: string | null;
  model_note: string | null;
  seller_joined_id: string | null;
  seller_name: string | null;
};

// Both routes use the same projection; joined IDs distinguish missing rows
// from rows whose price is still unknown.
export const DEAL_SELECT = `
  SELECT d.id, d.model_id, d.seller_id, d.title, d.price, d.source_url,
         d.verify_level, d.checked, d.starts_at, d.ends_at,
         m.id AS model_joined_id, m.name AS model_name,
         m.official_price AS model_official_price, m.checked AS model_checked,
         m.verify_level AS model_verify_level, m.note AS model_note,
         s.id AS seller_joined_id, s.name AS seller_name
  FROM deals AS d
  LEFT JOIN models AS m ON m.id = d.model_id
  LEFT JOIN sellers AS s ON s.id = d.seller_id`;

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

// Accept calendar dates (UTC, matching Date.parse) and ISO instants with an
// explicit zone. Reject ambiguous local times and dates normalized by JS.
function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) ||
      calendar.getUTCDate() !== Number(day)) return NaN;
  if (hour && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return NaN;
  if (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return NaN;
  return Date.parse(value);
}

function kstDay(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS);
}

export function dealTiming(startsAt: string, endsAt: string, nowMs: number): Timing {
  const start = parseDate(startsAt);
  const end = parseDate(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(nowMs) || end < start) {
    return { state: 'unknown', days: null };
  }
  if (nowMs < start) return { state: 'upcoming', days: kstDay(start) - kstDay(nowMs) };
  if (nowMs > end) return { state: 'ended', days: null };
  return { state: 'active', days: kstDay(end) - kstDay(nowMs) };
}

export function sortDeals<T extends Deal>(deals: readonly T[], nowMs: number): T[] {
  const rank = { active: 0, upcoming: 1, ended: 2, unknown: 3 };
  return deals.map(deal => {
    const { state } = dealTiming(deal.starts_at, deal.ends_at, nowMs);
    const time = state === 'upcoming' ? parseDate(deal.starts_at)
      : state === 'active' ? parseDate(deal.ends_at)
      : state === 'ended' ? -parseDate(deal.ends_at) : 0;
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
