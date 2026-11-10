/** Pure, bounded source verification. No fetch, model, persistence or publication. */
import { createHash } from 'node:crypto';
import { canonicalUrl, filterChanged } from '../../shared/privacy-rules';
import { extractModels } from './extract';
import { DAY, KST_OFFSET, kstDate } from './kst';
export const FACT_CHECK_VERSION = 'deal-facts@1';
export const CHECKED_SCHEMA_VERSION = 1;
export const INTERPRETATION_POLICY = 'kst-observation-year@1';
export type CheckedDate = { year: number | null; month: number; day: number; hour: number | null; minute: number | null; second: number | null; precision: 'day' | 'hour' | 'minute' | 'second' };
export type FactReason = 'missing' | 'not_found' | 'ambiguous' | 'invalid' | 'contradictory_range';
export type Evidence = { source: string; start: number; end: number; quote: string };
export type Fact<T> = { value: T; reason: null; evidence: Evidence } | { value: null; reason: FactReason; evidence?: Evidence };
export type FactCheck = {
  version: typeof FACT_CHECK_VERSION; schema_version: 1; interpretation_policy: typeof INTERPRETATION_POLICY;
  source: string; source_hash: string; text_length: number; observed_at: string; observation_year_kst: number; truncated: boolean;
  fields: { gonggu_price: Fact<number>; regular_price: Fact<number>; start_date: Fact<CheckedDate>; end_date: Fact<CheckedDate> };
};
export type FactCandidates = { gonggu_price?: unknown; regular_price?: unknown; period?: unknown; start_date?: unknown; end_date?: unknown };
export const sourceHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const missing = (v: unknown) => v == null || typeof v === 'string' && /^(?:|정보\s*없음|미확인|가격\s*미확인|마감일\s*미확인|미정|가격\s*문의|추후\s*공지|tbd|unknown|null|n\/a|없음|-)$/i.test(v.trim());
const failed = <T>(reason: FactReason, evidence?: Evidence): Fact<T> => ({ value: null, reason, ...(evidence ? { evidence } : {}) });
// Map NFKC token positions back to the exact supplied text (including fullwidth forms).
function normalized(text: string) {
  let value = ''; const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const char of text) { const n = char.normalize('NFKC'); for (let i = 0; i < n.length; i++) { starts.push(offset); ends.push(offset + char.length); } value += n; offset += char.length; }
  return { value, starts, ends };
}
const moneyPattern = /(?:₩\s*|KRW\s*)?\d+(?:[ \t]*,[ \t]*\d+)*(?:\.\d+)?(?:\s*(?:억|만|천)\s*(?:\d+(?:[ \t]*,[ \t]*\d+)*(?:\.\d+)?\s*(?:만|천)?)?)*\s*(?:원|KRW)?/gi;
export function normalizeMoney(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim().replace(/^(?:₩|KRW)\s*/i, '').replace(/\s*(?:원|KRW)$/i, '').replace(/\s+/g, '');
  if (!s) return null;
  let total = 0, previousUnit = Infinity;
  while (s) {
    const m = /^(\d+(?:,\d+)*(?:\.\d+)?)(억|만|천)?/.exec(s);
    if (!m || m[1].includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[1])) return null;
    const unit = m[2] === '억' ? 100000000 : m[2] === '만' ? 10000 : m[2] === '천' ? 1000 : 1;
    if (unit >= previousUnit || !m[2] && m[1].includes('.')) return null;
    previousUnit = unit; total += Number(m[1].replace(/,/g, '')) * unit; s = s.slice(m[0].length);
  }
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
type Token<T> = { value: T; start: number; end: number; role: 'start' | 'end' | 'sale' | 'regular' | null; range?: number };
const maskedUrls = (s: string) => s.replace(/https?:\/\/[^\s<>"']+/gi, m => ' '.repeat(m.length));
function monies(text: string): Token<number>[] {
  const out: Token<number>[] = [], s = maskedUrls(text);
  for (const m of s.matchAll(moneyPattern)) {
    const raw = m[0].trim(), start = m.index!, end = start + m[0].trimEnd().length;
    if (!/₩|KRW|원|억|만|천/i.test(raw) || /[\p{L}\p{N}_,.\/-]/u.test(s[start - 1] ?? '') || /[\d,.\w]/.test(s[end] ?? '')) continue;
    if (/\d[\d,]*[ \t]+$/.test(s.slice(Math.max(0,start-30),start)) || /^[ \t]*(?:부터|이상|미만|대(?:\s|$))/.test(s.slice(end))) continue;
    const value = normalizeMoney(raw); if (value === null) continue;
    const before = s.slice(Math.max(s.lastIndexOf('\n', start - 1) + 1, start - 70), start);
    const labels = [...before.matchAll(/정상가|정가|소비자가|공식가|regular|공구가|공구\s*가격|판매가|할인가|특가|가격/gi)];
    const label = labels.at(-1)?.[0] ?? '';
    const role = /정상가|정가|소비자가|공식가|regular/i.test(label) ? 'regular' : label ? 'sale' : null;
    out.push({ value, start, end, role });
  }
  return out;
}
const datePattern = /(?<![\d\w])(?:(\d{4})\s*(?:[-./]|년)\s*)?(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})[ \t]*(?:일|\.(?!\d))?(?:[ \t]*(?:\([월화수목금토일](?:요일)?\))?[ \t]*(?:T|오전\s*|오후\s*)?(\d{1,2})(?::(\d{2})(?::(\d{2}))?|\s*시(?:\s*(\d{1,2})\s*분)?))?/g;
export function validDate(d: CheckedDate): boolean {
  if (!d || Object.keys(d).sort().join(',') !== 'day,hour,minute,month,precision,second,year' || !(d.year === null || Number.isInteger(d.year) && d.year >= 1900 && d.year <= 9999) || !Number.isInteger(d.month) || !Number.isInteger(d.day)) return false;
  const date = new Date(Date.UTC(d.year ?? 2000, d.month - 1, d.day));
  return date.getUTCMonth() === d.month - 1 && date.getUTCDate() === d.day &&
    (d.precision === 'day' && d.hour === null && d.minute === null && d.second === null || ['hour', 'minute', 'second'].includes(d.precision) && Number.isInteger(d.hour) && d.hour! >= 0 && d.hour! <= 23 && (d.precision === 'hour' ? d.minute === null && d.second === null : Number.isInteger(d.minute) && d.minute! >= 0 && d.minute! <= 59 && (d.precision === 'minute' ? d.second === null : Number.isInteger(d.second) && d.second! >= 0 && d.second! <= 59)));
}
function dateTokens(text: string): Token<CheckedDate>[] {
  const s = maskedUrls(text), out: Token<CheckedDate>[] = [];
  for (const m of s.matchAll(datePattern)) {
    const start = m.index!, raw = m[0], end = start + raw.trimEnd().length;
    if (/^(?:Z|[+-](?!09:00)\d{2}:\d{2}|:\d)/.test(s.slice(end)) || /[\d./]/.test(s[end] ?? '') || /[\d./]/.test(s[start - 1] ?? '')) continue;
    if (/(?:^|[^\d])\d{3,}-$/.test(s.slice(Math.max(0,start-30),start))) continue;
    if (/[A-Za-z][A-Za-z0-9_.-]*$/.test(s.slice(Math.max(0,start-80),start)) || /(?:게시|등록|확인|발행|출시|업데이트|배송|생산|제조)(?:일|날짜)?\s*[:：]?\s*$/.test(s.slice(Math.max(0,start-30),start))) continue;
    let hour = m[4] == null ? null : +m[4];
    if (hour !== null && /오전|오후/.test(raw) && (hour < 1 || hour > 12)) hour = NaN;
    if (hour !== null && /오후/.test(raw) && hour < 12) hour += 12;
    if (hour === 12 && /오전/.test(raw)) hour = 0;
    const value: CheckedDate = { year: m[1] ? +m[1] : null, month: +m[2], day: +m[3], hour, minute: m[5] != null || m[7] != null ? +(m[5] ?? m[7]) : null, second: m[6] != null ? +m[6] : null, precision: hour === null ? 'day' : m[6] != null ? 'second' : m[5] != null || m[7] != null ? 'minute' : 'hour' };
    const before = s.slice(Math.max(s.lastIndexOf('\n', start - 1) + 1, start - 20), start), after = s.slice(end, end + 12);
    const role = /(?:마감|종료|까지|end)\s*[:：]?\s*$/i.test(before) ? 'end' : /(?:시작|오픈|start)\s*[:：]?\s*$/i.test(before) ? 'start' : /^[ \t]*(?:\([월화수목금토일](?:요일)?\))?[ \t]*(?:까지|마감|종료)/.test(after) ? 'end' : /^[ \t]*(?:\([월화수목금토일](?:요일)?\))?[ \t]*(?:부터|시작|오픈)/.test(after) ? 'start' : null;
    out.push({ value, start, end, role });
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i], b = out[i + 1], between = s.slice(a.end, b.start);
    if (/^\s*(?:\([월화수목금토일](?:요일)?\))?\s*(?:~|～|–|—|-|부터|에서|to)\s*$/i.test(between)) {
      a.role = 'start'; b.role = 'end'; a.range = b.range = i;
      // A written year propagates only within this syntactically bound range.
      if (a.value.year !== null && b.value.year === null && a.value.month <= b.value.month) b.value = { ...b.value, year: a.value.year };
      else if (b.value.year !== null && a.value.year === null && a.value.month <= b.value.month) a.value = { ...a.value, year: b.value.year };
      i++;
    }
  }
  return out;
}
// Object key order is not semantic: durable rows come back from canonical JSON.
const sameDate = (a: CheckedDate, b: CheckedDate) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second && a.precision === b.precision;
export function checkDealFacts(candidates: FactCandidates, text: string, source: string, observedAt: string, truncated = false, scopeTitle?: string): FactCheck {
  if (!Number.isFinite(Date.parse(observedAt)) || filterChanged(text) || text.length > 20000 || canonicalUrl(source) !== source) throw new Error('extraction_result_invalid');
  const n = normalized(text);
  const evidence = (t: { start: number; end: number }): Evidence => {
    const start = n.starts[t.start], end = n.ends[t.end - 1];
    return { source, start, end, quote: text.slice(start, end) };
  };
  const scopedTitle = scopeTitle?.normalize('NFKC');
  const title = scopedTitle && n.value.includes(scopedTitle) ? scopedTitle : n.value.split('\n')[0];
  const titleModels = new Set(extractModels(title).map(m => m.model_id));
  const prices = monies(n.value).filter(token => {
    // Prepared DeepSeek text is flattened. Inspect only the price's preceding
    // source context, never gifts/other product text following that amount.
    const before = n.value.slice(Math.max(n.value.lastIndexOf('\n', token.start - 1) + 1, token.start - 80), token.start);
    if (/(?:다른\s*상품|타\s*상품|추천|관련\s*상품)/.test(before)) return false;
    const models = extractModels(before);
    if (titleModels.size && models.length && !models.some(m => titleModels.has(m.model_id))) return false;
    const component = /(?:구성품|옵션|추가|별도|트레이|베이비세트|뉴본|배시넷)/.test(before) && !/(?:전체|총액|세트가|묶음가|번들가)/.test(before);
    return !component || /(?:트레이|베이비세트|뉴본|배시넷)/.test(title) && models.some(m => titleModels.has(m.model_id));
  });
  function price(key: 'gonggu_price' | 'regular_price'): Fact<number> {
    const candidate = candidates[key]; if (missing(candidate)) return failed('missing');
    const value = normalizeMoney(candidate); if (value === null) return failed('invalid');
    const role = key === 'gonggu_price' ? 'sale' : 'regular';
    const eligible = prices.filter(t => t.role === role || role === 'sale' && t.role === null);
    const matches = eligible.filter(t => t.value === value);
    if (!matches.length) return failed('not_found');
    // Multiple offer/component amounts or multiple unlabeled prices require human attribution.
    if (new Set(eligible.map(t => t.value)).size > 1 || matches.some(t => t.end - t.start > 240)) return failed('ambiguous');
    return { value, reason: null, evidence: evidence(matches[0]) };
  }
  const sourceDates = dateTokens(n.value), periodDates = typeof candidates.period === 'string' ? dateTokens(candidates.period.normalize('NFKC')) : [];
  function date(key: 'start_date' | 'end_date'): Fact<CheckedDate> {
    const role = key === 'start_date' ? 'start' : 'end';
    const supplied = candidates[key];
    let wanted: CheckedDate | undefined;
    if (supplied !== undefined) {
      if (missing(supplied)) return failed('missing');
      const ts = typeof supplied === 'string' ? dateTokens(supplied.normalize('NFKC')) : [];
      if (ts.length !== 1) return failed('invalid'); wanted = ts[0].value;
    } else {
      const ts = periodDates.filter(t => t.role === role || role === 'start' && t.role === null && periodDates.length === 1);
      if (!ts.length) return failed(missing(candidates.period) ? 'missing' : 'not_found');
      if (ts.length > 1) return failed('ambiguous'); wanted = ts[0].value;
    }
    if (!validDate(wanted)) return failed('invalid');
    const matches = sourceDates.filter(t => (t.role === role || t.role === null && sourceDates.length === 1 && role === 'start') && sameDate(t.value, wanted!));
    if (!matches.length) return failed('not_found');
    const eligible = sourceDates.filter(t => t.role === role);
    if (new Set(eligible.map(t => JSON.stringify(t.value))).size > 1 || matches[0].end - matches[0].start > 240) return failed('ambiguous');
    const match = matches[0];
    // Include the written year in evidence when propagated from the other endpoint.
    const range = match.range === undefined ? [match] : sourceDates.filter(t => t.range === match.range);
    const span = { start: Math.min(...range.map(t => t.start)), end: Math.max(...range.map(t => t.end)) };
    if (span.end - span.start > 240) return failed('ambiguous');
    return { value: wanted, reason: null, evidence: evidence(span) };
  }
  const start_date = date('start_date'), end_date = date('end_date');
  const fields = { gonggu_price: price('gonggu_price'), regular_price: price('regular_price'), start_date, end_date };
  if (start_date.value && end_date.value) {
    const a = start_date.value, b = end_date.value;
    const aTime = dateTimestamp(a), bTime = dateTimestamp(b);
    const backwards = aTime !== null && bTime !== null ? bTime < aTime : a.year === null && b.year === null && a.month === b.month && (b.day < a.day || b.day === a.day && b.hour !== null && a.hour !== null && b.hour * 60 + (b.minute ?? 0) < a.hour * 60 + (a.minute ?? 0));
    if (backwards) { fields.start_date = failed('contradictory_range', start_date.evidence); fields.end_date = failed('contradictory_range', end_date.evidence); }
  }
  for (const a of sourceDates.filter(t => t.role === 'start' && t.range !== undefined)) {
    const b = sourceDates.find(t => t.role === 'end' && t.range === a.range)!;
    const from = dateTimestamp(a.value), to = dateTimestamp(b.value);
    const contradictory = from !== null && to !== null ? to < from : a.value.year === null && b.value.year === null && a.value.month === b.value.month && b.value.day < a.value.day;
    if (contradictory && (fields.start_date.value !== null || fields.end_date.value !== null)) {
      const span = evidence({ start: a.start, end: b.end });
      fields.start_date = failed('contradictory_range', span); fields.end_date = failed('contradictory_range', span);
    }
  }
  return { version: FACT_CHECK_VERSION, schema_version: CHECKED_SCHEMA_VERSION, interpretation_policy: INTERPRETATION_POLICY, source, source_hash: sourceHash(text), text_length: text.length, observed_at: new Date(observedAt).toISOString(), observation_year_kst: +kstDate(observedAt).slice(0, 4), truncated, fields };
}
/** Publication requires a written year. Date-only ends are inclusive through their KST day. */
export function dateTimestamp(d: CheckedDate | null, end = false): number | null {
  if (!d || d.year === null || !validDate(d)) return null;
  return Date.UTC(d.year, d.month - 1, d.day, d.hour ?? 0, d.minute ?? 0, d.second ?? 0) - KST_OFFSET + (end && d.precision === 'day' ? DAY - 1 : 0);
}
export function publishDate(d: CheckedDate | null, end = false): string | null {
  const time = dateTimestamp(d, end); return time === null ? null : new Date(time).toISOString();
}
/** No adjacent-year heuristic: December/January and cross-year yearless ranges are uncertain. */
export function interpretSchedule(check: FactCheck) {
  const start = check.fields.start_date.value, end = check.fields.end_date.value;
  const observationMonth = +kstDate(check.observed_at).slice(5, 7);
  const sourceCrossYear = [check.fields.start_date, check.fields.end_date].some(f => {
    if (!f.evidence) return false;
    const dates = dateTokens(f.evidence.quote.normalize('NFKC'));
    return dates.some(a => a.role === 'start' && a.range !== undefined && dates.some(b => b.range === a.range && b.role === 'end' && (a.value.year === null || b.value.year === null) && b.value.month < a.value.month));
  });
  const crossYear = sourceCrossYear || !!(start && end && (start.year === null || end.year === null) && end.month < start.month);
  function interpret(d: CheckedDate | null, isEnd = false) {
    if (!d) return { at: null, year_ambiguous: false };
    const ambiguous = d.year === null && (crossYear || observationMonth === 12 && d.month === 1 || observationMonth === 1 && d.month === 12);
    return { at: ambiguous ? null : dateTimestamp({ ...d, year: d.year ?? check.observation_year_kst }, isEnd), year_ambiguous: ambiguous };
  }
  return { start: interpret(start), end: interpret(end, true) };
}
export function validFactCheck(raw: unknown): raw is FactCheck {
  try {
    const c = raw as FactCheck;
    if (!c || c.version !== FACT_CHECK_VERSION || c.schema_version !== CHECKED_SCHEMA_VERSION || c.interpretation_policy !== INTERPRETATION_POLICY || canonicalUrl(c.source) !== c.source || !/^[a-f0-9]{64}$/.test(c.source_hash) || !Number.isInteger(c.text_length) || c.text_length < 0 || c.text_length > 20000 || typeof c.truncated !== 'boolean' || new Date(c.observed_at).toISOString() !== c.observed_at || +kstDate(c.observed_at).slice(0, 4) !== c.observation_year_kst || Object.keys(c).sort().join(',') !== 'fields,interpretation_policy,observation_year_kst,observed_at,schema_version,source,source_hash,text_length,truncated,version') return false;
    if (Object.keys(c.fields).sort().join(',') !== 'end_date,gonggu_price,regular_price,start_date') return false;
    for (const [key, f] of Object.entries(c.fields)) {
      if (!f || Object.keys(f).some(k => !['value', 'reason', 'evidence'].includes(k))) return false;
      if (f.value === null ? !['missing','not_found','ambiguous','invalid','contradictory_range'].includes(f.reason!) : f.reason !== null || (key.endsWith('price') ? !Number.isSafeInteger(f.value) || (f.value as number) < 0 : !validDate(f.value as CheckedDate))) return false;
      if (f.value !== null && !f.evidence) return false;
      if (f.evidence) {
        const e = f.evidence;
        if (Object.keys(e).sort().join(',') !== 'end,quote,source,start' || e.source !== c.source || !Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end > c.text_length || e.end <= e.start || typeof e.quote !== 'string' || e.quote.length !== e.end - e.start || e.quote.length > 240 || filterChanged(e.quote)) return false;
        if (f.value !== null && (key.endsWith('price') ? !monies(e.quote.normalize('NFKC')).some(t => t.value === f.value) : !dateTokens(e.quote.normalize('NFKC')).some(t => sameDate(t.value, f.value as CheckedDate)))) return false;
      }
    }
    return Buffer.byteLength(JSON.stringify(c)) <= 8000;
  } catch { return false; }
}
/** Only use on durable envelopes; this validates structure, not a fresh source observation. */
export function checkedFacts(c: FactCheck) { return { gonggu_price: c.fields.gonggu_price.value, regular_price: c.fields.regular_price.value, start_date: c.fields.start_date.value, end_date: c.fields.end_date.value }; }

/** Source-aware validation only at the original in-memory checking boundary. */
export function validateCheckedText(check: FactCheck, text: string): void {
  if (!validFactCheck(check) || check.source_hash !== sourceHash(text) || check.text_length !== text.length || Object.values(check.fields).some(f => f.evidence && text.slice(f.evidence.start, f.evidence.end) !== f.evidence.quote)) throw new Error('extraction_result_invalid');
}
