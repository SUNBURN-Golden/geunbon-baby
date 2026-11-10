// Site D1 expressions. Migration 0014 is generated from these exact definitions;
// tests assert equality so SQLite expression/partial indexes remain usable.
// Workerd limits GLOB patterns to 50 characters: keep every pattern short.
export function timestampSql(raw: string): string {
  const zone = `(CASE WHEN substr(${raw}, -1) = 'Z' THEN 'Z' ELSE substr(${raw}, -6) END)`;
  const frac = `substr(${raw}, 20, length(${raw}) - CASE WHEN substr(${raw}, -1) = 'Z' THEN 20 ELSE 25 END)`;
  const utc = `strftime('%Y-%m-%dT%H:%M:%fZ', substr(${raw}, 1, 19) || ${frac}, CASE WHEN ${zone} = 'Z' THEN '+0 minutes' ELSE (CASE substr(${zone}, 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr(${zone}, 2, 2) AS INTEGER) * 60 + CAST(substr(${zone}, 5, 2) AS INTEGER)) || ' minutes' END)`;
  return `(CASE WHEN instr(${raw}, char(0)) = 0 AND substr(${raw}, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(${raw}, 1, 4) || substr(${raw}, 6, 2) || substr(${raw}, 9, 2) || substr(${raw}, 12, 2) || substr(${raw}, 15, 2) || substr(${raw}, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(${raw}, 1, 10), '+0 days') = substr(${raw}, 1, 10)
    AND CAST(substr(${raw}, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(${raw}, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(${raw}, 18, 2) AS INTEGER) <= 59
    AND (${frac} = '' OR ${frac} GLOB '.[0-9]' OR ${frac} GLOB '.[0-9][0-9]' OR ${frac} GLOB '.[0-9][0-9][0-9]')
    AND (${zone} = 'Z' OR (${zone} GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(${zone}, 2, 2) AS INTEGER) <= 23 AND CAST(substr(${zone}, 5, 2) AS INTEGER) <= 59))
    AND length(${utc}) = 24 AND substr(${utc}, 1, 4) NOT GLOB '*[^0-9]*'
    THEN ${utc} END)`;
}
export const S = timestampSql('starts_at');
export const E = timestampSql('ends_at');
export const EFFECTIVE_END = `COALESCE(${E}, '1970-01-01T00:00:00.000Z')`;
const published = "status = 'published'";
// IS NOT mirrors the exact source_ended === 1 test, including legacy NULLs.
const natural = `${published} AND source_ended IS NOT 1`;
export const COMPLETE = `${natural} AND ${S} IS NOT NULL AND ${E} IS NOT NULL AND ${E} >= ${S}`;
export const UPCOMING = `${natural} AND ${S} IS NOT NULL AND (${E} IS NULL OR ${E} >= ${S})`;
export const END_ONLY = `${natural} AND (starts_at IS NULL OR starts_at = '') AND ${E} IS NOT NULL`;
export const START_ONLY = `${natural} AND ${S} IS NOT NULL AND ${E} IS NULL`;
export const PERMANENT = `${natural} AND ((${S} IS NOT NULL AND ${E} IS NOT NULL AND ${E} < ${S}) OR (starts_at IS NOT NULL AND starts_at <> '' AND ${S} IS NULL) OR ((starts_at IS NULL OR starts_at = '') AND ${E} IS NULL))`;
export const SOURCE_ENDED = `${published} AND source_ended = 1`;
export const publicDealIndexes = [
  ['public_deal_chronology', 'starts_at, id', published],
  ['public_deal_model_chronology', 'model_id, starts_at, id', published],
  ['public_deal_intervals', `${E}, id, ${S}, model_id, price`, COMPLETE],
  ['public_deal_model_intervals', `model_id, ${E}, id, ${S}, price`, COMPLETE],
  ['public_deal_upcoming', `${S}, id`, UPCOMING],
  ['public_deal_ended', `${E} DESC, id ASC`, COMPLETE],
  ['public_deal_end_only_ended', `${E} DESC, id ASC`, END_ONLY],
  ['public_deal_end_only_unknown', `${E}, id`, END_ONLY],
  ['public_deal_source_ended', `${EFFECTIVE_END} DESC, id ASC`, SOURCE_ENDED],
  ['public_deal_permanent_unknown', 'id', PERMANENT],
  ['public_deal_start_only', `${S}, id`, START_ONLY],
] as const;
export const publicDealMigration = `-- Additive site D1 indexes. No stored schedules or previous indexes are changed.\n-- Expressions/static predicates match lib/deal-query-sql.ts exactly. Time is bound at query time.\n${publicDealIndexes.map(([name, keys, predicate]) => `CREATE INDEX ${name} ON deals (${keys}) WHERE ${predicate};`).join('\n\n')}\n`;
