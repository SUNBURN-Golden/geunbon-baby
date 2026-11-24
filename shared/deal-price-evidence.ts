// Versioned Linux/Worker contract. All validation is pure except Web Crypto hashing.
import { canonicalUrl, filterChanged, filterText } from './privacy-rules';

export const PRICE_VERIFIER = 'deal-prices@2';
export const PRICE_MODELS = ['deepseek-flash', 'qwen4-max-preview'] as const;
export const OFFICIAL_PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PRICE_TEXT_LIMIT = 3600;
export const configurationFields = ['brand', 'model', 'generation', 'option', 'quantity', 'bundle'] as const;
export function filterOfferCapture(value: string) {
  const text = value.replace(/\r\n?/g, '\n').split('\n')
    .map(line => filterText(line, PRICE_TEXT_LIMIT + 1).replace(/\s+/g, ' ')).filter(Boolean).join('\n');
  return text.length > PRICE_TEXT_LIMIT ? '' : text;
}
export type Configuration = Record<typeof configurationFields[number], string>;
export type Span = { start: number; quote: string };
export type Reading = {
  amount: number | null;
  price: Span | null;
  deadline: Span | null;
  orders_open?: Span | null;
  configuration: Configuration | null;
  identity: Record<keyof Configuration, Span> | null;
};
export type Capture = { url: string; text: string; hash: string; observed_at: string };
export type SourceReadings = { source: Capture; readings: [Reading | null, Reading | null] };
export type PriceVariant = {
  id: string; catalog_id: string; site_model_id?: string; configuration: Configuration; brand_aliases: string[]; model_aliases: string[]; skus: string[];
};
export type OfficialApproval = { id: string; revision: number; variant?: PriceVariant };
export type OfficialPriceScope = OfficialApproval & {
  url: string; brand: string; model: string; approved_at: string; expires_at: string;
};
export type PriceOutcome = 'verified' | 'missing_offer_price' | 'offer_price_disagreement' | 'unsupported_offer_price' |
  'missing_deadline' | 'deadline_disagreement' | 'unsupported_deadline' | 'configuration_mismatch' |
  'missing_official_coverage' | 'missing_list_price' | 'list_price_disagreement' | 'unsupported_list_price' |
  'source_inaccessible' | 'expired_story' | 'provider_retryable';
export type PriceEvidence = {
  verifier: typeof PRICE_VERIFIER;
  models: typeof PRICE_MODELS;
  offer_url: string;
  offer: SourceReadings | null;
  official: SourceReadings | null;
  official_approval: OfficialApproval | null;
  failed: 'configuration_mismatch' | 'missing_official_coverage' | 'source_inaccessible' | 'expired_story' | 'provider_retryable' | null;
};
export type VerifiedPrices = {
  deal_price_krw: number; list_price_krw: number; ends_at: string; price_source_url: string;
  list_price_source_url: string; price_checked_at: string; configuration: Configuration; orders_open: boolean;
};
export type PriceResult = { outcome: Exclude<PriceOutcome, 'verified'>; facts?: never } | { outcome: 'verified'; facts: VerifiedPrices };

export const amount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function httpsSource(value: unknown, offer = false): value is string {
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    const u = new URL(value);
    canonicalUrl(value, offer);
    return u.href === value && u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash;
  } catch { return false; }
}
function inaccessibleOfferUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.href !== value || url.hash) return false;
    url.search = '';
    return httpsSource(url.href);
  } catch { return false; }
}
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const identityToken = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !filterChanged(v);
function approvalIdentity(value: Record<string, unknown>) {
  return typeof value.id === 'string' && /^[a-f0-9]{64}$/.test(value.id) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 2;
}
export function isOfficialPriceScope(value: unknown): value is OfficialPriceScope {
  return record(value) && Object.keys(value).length === (value.variant === undefined ? 7 : 8) && approvalIdentity(value) &&
    (value.variant === undefined || isPriceVariant(value.variant)) && httpsSource(value.url) &&
    clean(value.brand, 100) && clean(value.model, 100) && instant(value.approved_at) &&
    instant(value.expires_at) && value.approved_at < value.expires_at;
}
export function isPriceVariant(value: unknown): value is PriceVariant {
  if (!record(value) || Object.keys(value).length !== (value.site_model_id === undefined ? 6 : 7) ||
      value.site_model_id !== undefined && !clean(value.site_model_id, 100) || !clean(value.id, 100) || !clean(value.catalog_id, 100) ||
      !record(value.configuration)) return false;
  const configuration = value.configuration;
  return Object.keys(configuration).length === configurationFields.length &&
    configurationFields.every(field => clean(configuration[field], 100)) &&
    [value.brand_aliases, value.model_aliases, value.skus].every(list =>
      Array.isArray(list) && list.length <= 25 && list.every(alias => clean(alias, 100)));
}
function isSpan(value: unknown): value is Span {
  return record(value) && Object.keys(value).length === 2 && Number.isSafeInteger(value.start) && Number(value.start) >= 0 && clean(value.quote, 240);
}
function isReading(value: unknown): value is Reading {
  if (!record(value) || Object.keys(value).length !== (value.orders_open === undefined ? 5 : 6) || !(value.amount === null || amount(value.amount)) ||
      !(value.price === null || isSpan(value.price)) || !(value.deadline === null || isSpan(value.deadline)) ||
      !(value.orders_open == null || isSpan(value.orders_open))) return false;
  if (value.configuration === null) return value.identity === null;
  const config = value.configuration, identity = value.identity;
  return record(config) && record(identity) && Object.keys(config).length === configurationFields.length &&
    Object.keys(identity).length === configurationFields.length &&
    configurationFields.every(field => clean(config[field], 100) && isSpan(identity[field]));
}
export function readProviderReading(value: unknown): Reading | null {
  return isReading(value) ? value : null;
}
async function isSource(value: unknown, offer: boolean): Promise<boolean> {
  if (value === null) return true;
  if (!record(value) || Object.keys(value).length !== 2 || !record(value.source) || !Array.isArray(value.readings) ||
      value.readings.length !== 2 || !value.readings.every(reading => reading === null || isReading(reading))) return false;
  const { url, text, hash, observed_at } = value.source;
  return Object.keys(value.source).length === 4 && httpsSource(url, offer) && clean(text, PRICE_TEXT_LIMIT) &&
    instant(observed_at) && hash === await digest(text);
}
export async function parsePriceEvidence(value: unknown, takeOfferUrls = false): Promise<PriceEvidence | null> {
  if (!record(value) || Object.keys(value).length !== 7 || value.verifier !== PRICE_VERIFIER || !Array.isArray(value.models) ||
      value.models.length !== 2 || value.models.some((model, i) => model !== PRICE_MODELS[i]) ||
      !(httpsSource(value.offer_url, takeOfferUrls) || value.failed === 'source_inaccessible' && value.offer === null && value.official === null && inaccessibleOfferUrl(value.offer_url)) ||
      ![null, 'configuration_mismatch', 'missing_official_coverage', 'source_inaccessible', 'expired_story', 'provider_retryable'].includes(value.failed as null | string) ||
      !await isSource(value.offer, takeOfferUrls) || !await isSource(value.official, takeOfferUrls) ||
      (value.official === null ? value.official_approval !== null :
        !record(value.official_approval) || Object.keys(value.official_approval).length !== (value.official_approval.variant === undefined ? 2 : 3) ||
        !approvalIdentity(value.official_approval) || value.official_approval.variant !== undefined && !isPriceVariant(value.official_approval.variant))) return null;
  const evidence = value as PriceEvidence;
  if (evidence.offer && evidence.offer.source.url !== evidence.offer_url ||
      evidence.official && (!evidence.offer || evidence.official.source.url === evidence.offer_url)) return null;
  return evidence;
}

function exactSpan(capture: Capture, span: Span | null): string | null {
  return span && capture.text.slice(span.start, span.start + span.quote.length) === span.quote ? span.quote.normalize('NFKC').trim() : null;
}
function sourceLine(capture: Capture, span: Span): string {
  const from = capture.text.lastIndexOf('\n', span.start - 1) + 1;
  const next = capture.text.indexOf('\n', span.start + span.quote.length);
  return capture.text.slice(from, next < 0 ? undefined : next).normalize('NFKC').trim();
}
const offerLabel = /^(?:(?:전체|총액|세트|묶음|번들)\s*)?(?:공구가|공동\s*구매가|공구\s*가격|공동\s*구매\s*가격|group.buy price)\s*[:：]?\s*/i;
const regularLabel = /^(?:정가|정상가|소비자가|공식가|regular price|msrp)\s*[:：]?\s*/i;
const deadlineLabel = /^(?:공구\s*)?(?:마감일(?:시)?|종료일(?:시)?|마감|종료|deadline|ends at)\s*[:：]?\s*/i;
const rangeLabel = /^(?:(?:공동\s*구매|공구|판매)\s*기간|기간(?=\s*[:：])|offer period)\s*[:：]?\s*/i;
const closureLine = /^(?:(?:안내|상태|notice|status)\s*[:：]\s*)?(?:(?:공동\s*구매|공구|판매)\s*)?(?:마감(?:\s*(?:됨|완료|되었습니다|했습니다))?|종료(?:\s*(?:됨|완료|되었습니다|했습니다))?|closed|ended)[.!！。]*$/i;
export const withoutStandaloneClosure = (text: string) => text.split('\n').filter(line =>
  !closureLine.test(line.normalize('NFKC').trim().replace(/^\[(.*)\]$/, '$1'))).join('\n');
const completedClosure = /(?:공동\s*구매|공구|판매)\s*(?:마감|종료)\s*(?:됨|완료|되었습니다|했습니다)[.!！。)\]]*$/;
export const offerSourceClosed = (text: string) => text.normalize('NFKC').split('\n').some(line => {
  const trimmed = line.trim();
  return closureLine.test(trimmed.replace(/^\[(.*)\]$/, '$1')) || completedClosure.test(trimmed);
});
function won(text: string): number | null {
  let input = text.replace(/^(?:₩|KRW)\s*/i, '').replace(/\s*(?:원|KRW)$/i, '').replace(/[ \t]/g, '');
  if (!input || input.length > 40) return null;
  const units = { 억: 100_000_000n, 만: 10_000n, 천: 1_000n };
  let total = 0n, previousUnit = 1_000_000_000n;
  while (input) {
    const part = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(억|만|천)?/.exec(input);
    if (!part) return null;
    const [, integer, fraction = '', multiplier] = part;
    const unit = multiplier ? units[multiplier as keyof typeof units] : 1n;
    if (unit >= previousUnit || fraction && !multiplier) return null;
    const scale = 10n ** BigInt(fraction.length);
    const component = BigInt(integer.replaceAll(',', '') + fraction) * unit;
    if (component % scale) return null;
    total += component / scale;
    previousUnit = unit;
    input = input.slice(part[0].length);
  }
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}
const optionRow = '[옵션 행] ';
const itemBoundary = /^(?:\[상품\]|\[항목\]|\[옵션 행\]) /;
const accessory = /배송비|할부|추천 상품|거치대|액세서리|악세서리|accessor(?:y|ies)|shipping|installment/i;
const wholeAmount = /^(전체|총액|세트|묶음|번들)\s*/;
function lineContext(capture: Capture, span: Span) {
  const before = capture.text.slice(0, span.start).split('\n');
  const line = sourceLine(capture, span);
  const item = [...before.slice(0, -1)].reverse().find(value => itemBoundary.test(value)) ?? '';
  const heading = [...before].reverse().find(value => value.startsWith('[상품] ')) ?? '';
  return { line, item, heading, structured: capture.text.startsWith('[상품] ') || capture.text.includes('\n[상품] ') };
}
function labeledAmount(capture: Capture, reading: Reading, official: boolean) {
  const label = official ? regularLabel : offerLabel;
  const quote = exactSpan(capture, reading.price);
  if (!quote || !reading.price || !label.test(quote)) return false;
  const { line, item } = lineContext(capture, reading.price);
  const row = line.startsWith(optionRow);
  const cells = row ? line.slice(optionRow.length).split(' | ') : [line];
  const parse = (cell: string) => won(cell.replace(label, '').trim());
  const prices = cells.filter(cell => label.test(cell));
  if (prices.length !== 1 || prices[0] !== quote || parse(quote) !== reading.amount) return false;
  if (row ? cells.some(cell => accessory.test(cell)) : item.startsWith('[항목] ') || item.startsWith(optionRow)) return false;
  if (!row) {
    const lines = capture.text.normalize('NFKC').split('\n');
    if (lines.some(value => label.test(value) && parse(value) !== reading.amount)) return false;
    const index = capture.text.slice(0, reading.price.start).split('\n').length - 1;
    if (accessory.test(lines[index - 1] ?? '') && !wholeAmount.test(quote)) return false;
  }
  return reading.amount !== 0 || !official && wholeAmount.test(quote);
}
const writtenDate = /^(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})\s*(?:일)?(?:\s*\([월화수목금토일](?:요일)?\))?(?:[ T]*(오전|오후)?\s*(\d{1,2})(?:(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)|(?:시(?:\s*(\d{1,2})\s*분)?))\s*(KST|Z|[+-]\d{2}:\d{2})?)?\s*(?:까지)?$/i;
function parseWrittenDate(value: string, endOfDay = true) {
  const m = writtenDate.exec(value.trim());
  if (!m) return null;
  const [, y, month, day, amPm, hour, minute, second, fraction, koreanMinute, zone] = m;
  const date = `${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!instant(date + 'T00:00:00.000Z') || amPm && (+hour < 1 || +hour > 12)) return null;
  const inclusiveEnd = hour === undefined && endOfDay;
  const h = amPm ? +hour % 12 + (amPm === '오후' ? 12 : 0) : hour === undefined ? inclusiveEnd ? 23 : 0 : +hour;
  const min = minute ?? koreanMinute;
  const precision = hour === undefined ? 'day' : fraction ? `fraction-${fraction.length}` : second !== undefined ? 'second' : min !== undefined ? 'minute' : 'hour';
  const time = `${String(h).padStart(2, '0')}:${(min ?? (inclusiveEnd ? '59' : '00')).padStart(2, '0')}:${second ?? (inclusiveEnd ? '59' : '00')}`;
  const millis = fraction?.padEnd(3, '0') ?? (inclusiveEnd ? '999' : '000');
  const offset = !zone || zone.toUpperCase() === 'KST' ? '+09:00' : zone.toUpperCase();
  const instantMs = Date.parse(`${date}T${time}.${millis}${offset}`);
  if (h > 23 || !Number.isFinite(instantMs)) return null;
  const timestamp = new Date(instantMs).toISOString();
  return instant(timestamp) ? { timestamp, precision } : null;
}
function writtenDeadline(value: string | null) {
  if (!value) return null;
  if (deadlineLabel.test(value)) return parseWrittenDate(value.replace(deadlineLabel, ''));
  if (!rangeLabel.test(value)) return null;
  const parts = value.replace(rangeLabel, '').split(/\s*[~–—]\s*|\s+-\s+|\s*부터\s*/);
  if (parts.length !== 2) return null;
  const start = parseWrittenDate(parts[0], false), end = parseWrittenDate(parts[1]);
  return start && end && start.timestamp <= end.timestamp ? end : null;
}
export function offerDeadlinePrecision(reading: Reading | null) {
  return writtenDeadline(reading?.deadline?.quote.normalize('NFKC').trim() ?? null)?.precision ?? null;
}
export function metadataStart(quote: string) {
  const line = quote.normalize('NFKC').trim();
  if (rangeLabel.test(line)) {
    const parts = line.replace(rangeLabel, '').split(/\s*[~–—]\s*|\s+-\s+|\s*부터\s*/);
    return parts.length === 2 ? parseWrittenDate(parts[0], false)?.timestamp ?? null : null;
  }
  const label = /^(?:공구\s*)?(?:시작일(?:시)?|시작|오픈일(?:시)?|오픈|starts at)\s*[:：]\s*/i;
  return label.test(line) ? parseWrittenDate(line.replace(label, ''), false)?.timestamp ?? null : null;
}
const sameDeadline = (a: NonNullable<ReturnType<typeof writtenDeadline>>, b: NonNullable<ReturnType<typeof writtenDeadline>>) =>
  a.timestamp === b.timestamp && a.precision === b.precision;
function supportedDeadline(capture: Capture, reading: Reading) {
  const span = reading.deadline;
  const stated = writtenDeadline(exactSpan(capture, span));
  if (!span || !stated || !reading.price) return null;
  const context = sourceLine(capture, span);
  const price = lineContext(capture, reading.price);
  const deadline = lineContext(capture, span);
  if (context.startsWith(optionRow) ? context !== price.line :
      deadline.item.startsWith('[항목] ') || deadline.heading !== price.heading) return null;
  if (context !== exactSpan(capture, span) && !(context.startsWith(optionRow) && context.split(' | ').slice(1).includes(exactSpan(capture, span)!))) return null;
  const lines = capture.text.normalize('NFKC').split('\n').map(line => line.trim())
    .filter(line => !closureLine.test(line) && (deadlineLabel.test(line) || rangeLabel.test(line)));
  return lines.every(line => {
    const other = writtenDeadline(line);
    return other && sameDeadline(other, stated);
  }) ? stated : null;
}
const labels: Record<keyof Configuration, RegExp> = {
  brand: /^(?:브랜드|brand)\s*[:：]\s*/i, model: /^(?:모델(?:명)?|상품명|model|product)\s*[:：]\s*/i,
  generation: /^(?:세대|버전|generation|version)\s*[:：]\s*/i, option: /^(?:옵션|선택|option)\s*[:：]\s*/i,
  quantity: /^(?:수량|quantity)\s*[:：]\s*/i, bundle: /^(?:구성(?:품)?|번들|bundle)\s*[:：]\s*/i,
};
const configurationValue = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const sameConfiguration = (a: Configuration | null, b: Configuration | null) => !!a && !!b &&
  configurationFields.every(field => configurationValue(a[field]) === configurationValue(b[field]));

function hasTerm(text: string, term: string) {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const needle = normalize(term);
  return !!needle && (' ' + normalize(text) + ' ').includes(' ' + needle + ' ');
}

function supportedConfiguration(source: Capture, reading: Reading, variant?: PriceVariant): Configuration | null {
  const config = reading.configuration, spans = reading.identity;
  if (!config || !spans || !reading.price) return null;
  const { line, item, heading, structured } = lineContext(source, reading.price);
  if (variant && !configurationFields.every(field => {
    const terms = field === 'brand' ? variant.brand_aliases : field === 'model' ? variant.model_aliases : [];
    return [variant.configuration[field], ...terms].some(term => identityToken(term) === identityToken(config[field]));
  })) return null;
  const sku = variant?.skus.some(value => line.split(' | ').some(cell =>
    /^(?:SKU|품번|상품번호)\s*[:：]/i.test(cell) && identityToken(cell.replace(/^[^:：]+[:：]\s*/, '')) === identityToken(value)));
  if (sku) return config;
  for (const field of configurationFields) {
    const quote = exactSpan(source, spans[field]);
    if (!quote) return null;
    if (line.startsWith(optionRow)) {
      const context = sourceLine(source, spans[field]);
      if (context !== line && (!['brand', 'model', 'generation'].includes(field) || context !== heading)) return null;
      const cell = quote.replace(labels[field], '');
      const inHeading = context === heading;
      const aliases = field === 'brand' ? variant?.brand_aliases : field === 'model' ? variant?.model_aliases : [];
      if (inHeading ? ![config[field], ...(aliases ?? [])].some(term => hasTerm(cell, term)) :
          identityToken(cell) !== identityToken(config[field])) return null;
    } else {
      if (structured && item && !item.startsWith('[상품] ')) return null;
      const token = configurationValue(config[field]), label = labels[field];
      if (!token || !label.test(quote) || configurationValue(quote.replace(label, '')) !== token ||
          sourceLine(source, spans[field]) !== quote ||
          source.text.normalize('NFKC').split('\n').some(value => label.test(value) && configurationValue(value.replace(label, '')) !== token)) return null;
    }
  }
  return /^[1-9][0-9]*\s*(?:개|세트|대|pcs|units|set)?$/i.test(config.quantity.trim()) ? config : null;
}
export function matchingVariant(offer: SourceReadings, variant: PriceVariant) {
  const [a, b] = offer.readings;
  return !!a && !!b && sameConfiguration(supportedConfiguration(offer.source, a, variant), supportedConfiguration(offer.source, b, variant));
}
const openLine = /^(?:현재\s*)?(?:공구|공동\s*구매)\s*(?:주문|구매)\s*가능(?:합니다)?[.!！。]*$/;
function ordersOpen(source: Capture, a: Reading, b: Reading) {
  if (offerSourceClosed(source.text) || !a.orders_open || !b.orders_open || a.orders_open.start !== b.orders_open.start ||
      a.orders_open.quote !== b.orders_open.quote || !a.price) return false;
  const quote = exactSpan(source, a.orders_open);
  if (!quote || !openLine.test(quote) && !/^\[주문 가능\] (?:공구 주문하기|구매하기|주문하기)$/.test(quote)) return false;
  const open = lineContext(source, a.orders_open), price = lineContext(source, a.price);
  if (open.line === price.line) return open.line === quote || open.line.split(' | ').includes(quote);
  return !price.line.startsWith(optionRow) && open.line === quote && open.item === price.item;
}

export function assessPriceEvidence(evidence: PriceEvidence): PriceResult {
  if (evidence.failed === 'provider_retryable' || !evidence.offer) return { outcome: evidence.failed ?? 'source_inaccessible' };
  const { offer, official } = evidence;
  const [a, b] = offer.readings;
  if (!a || !b || a.amount === null || b.amount === null) return { outcome: 'missing_offer_price' };
  if (a.amount !== b.amount || a.price?.start !== b.price?.start) return { outcome: 'offer_price_disagreement' };
  if (!labeledAmount(offer.source, a, false) || !labeledAmount(offer.source, b, false)) return { outcome: 'unsupported_offer_price' };
  if (!a.deadline || !b.deadline) return { outcome: 'missing_deadline' };
  const endA = writtenDeadline(a.deadline.quote.normalize('NFKC').trim()), endB = writtenDeadline(b.deadline.quote.normalize('NFKC').trim());
  if (endA && endB && !sameDeadline(endA, endB)) return { outcome: 'deadline_disagreement' };
  const checkedEnd = supportedDeadline(offer.source, a);
  if (!checkedEnd || !supportedDeadline(offer.source, b)) return { outcome: 'unsupported_deadline' };
  if (!official && evidence.failed) return { outcome: evidence.failed };
  const variant = evidence.official_approval?.variant;
  const config = supportedConfiguration(offer.source, a, variant);
  if (!config || !sameConfiguration(config, supportedConfiguration(offer.source, b, variant))) return { outcome: 'configuration_mismatch' };
  if (!official || !evidence.official_approval) return { outcome: evidence.failed ?? 'missing_official_coverage' };
  const [c, d] = official.readings;
  if (!c || !d || c.amount === null || d.amount === null) return { outcome: 'missing_list_price' };
  if (c.amount !== d.amount || c.price?.start !== d.price?.start) return { outcome: 'list_price_disagreement' };
  if (c.amount <= 0 || !labeledAmount(official.source, c, true) || !labeledAmount(official.source, d, true)) return { outcome: 'unsupported_list_price' };
  const officialConfig = supportedConfiguration(official.source, c, variant);
  if (!sameConfiguration(officialConfig, supportedConfiguration(official.source, d, variant)) ||
      !variant && !sameConfiguration(config, officialConfig)) return { outcome: 'configuration_mismatch' };
  return { outcome: 'verified', facts: {
    deal_price_krw: a.amount, list_price_krw: c.amount, ends_at: checkedEnd.timestamp,
    price_source_url: offer.source.url, list_price_source_url: official.source.url,
    price_checked_at: official.source.observed_at,
    configuration: variant?.configuration ?? config, orders_open: ordersOpen(offer.source, a, b),
  } };
}

export function displayExclusion(deal: number, list: number) {
  if (deal === list) return 'equal_price';
  if (deal > list) return 'above_list';
  return 100n * (BigInt(list) - BigInt(deal)) < BigInt(list) ? 'discount_below_one_percent' : null;
}
