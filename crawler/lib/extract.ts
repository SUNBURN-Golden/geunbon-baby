// 캡션·스토리 OCR 텍스트에서 모델·가격·공구 일정·링크를 뽑는 순수 함수 모음.
// 외부 I/O·Playwright 의존이 없어 단위 테스트(tests/extract.test.ts)로만 검증한다.
// 추출 결과는 어디까지나 검수 보조 '제안'이며, 사람이 원문을 확인하기 전에는 게시되지 않는다.
import { models as seedModels } from '../../seed/models.json';

export type ModelSuggestion = { model_id: string; brand: string; name: string; matched: string[]; confidence: number };
export type PriceSuggestion = { value: number; raw: string; confidence: number; source_line: string };
export type DateSuggestion = { starts_at: string | null; ends_at: string | null; raw: string; confidence: number };
export type LinkSuggestion = { url: string; kind: 'url' | 'link_in_bio'; confidence: number };
export type Extraction = { models: ModelSuggestion[]; price: PriceSuggestion | null; prices: PriceSuggestion[]; dates: DateSuggestion | null; links: LinkSuggestion[]; confidence: number };
export type Suggestions = { models: ModelSuggestion[]; price: { value: number; raw: string; confidence: number } | null; dates: DateSuggestion | null; links: LinkSuggestion[]; confidence: number };

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const stripUrls = (text: string) => text.replace(URL_RE, ' ');
// OCR 이슈로 숫자 중간에 공백/줄바꿈이 섞인 경우("390,0 00원") 숫자 실행 구간 안의 공백만 붙인다.
const collapseNumberRuns = (text: string) => text.replace(/\d[\d,][\d,\s]*\d/g, run => run.replace(/[^\S\r\n]+/g, ''));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── 모델 매칭 ────────────────────────────────────────────────────────────────
const BRAND_ALIASES: Record<string, string[]> = {
  Stokke: ['스토케', 'stokke'],
  BabyBjorn: ['베이비뵨', '베이비본', '베이비비욘', 'babybjorn', 'babybjörn'],
  Bugaboo: ['부가부', 'bugaboo'],
  Cybex: ['싸이벡스', '사이벡스', 'cybex'],
  Nuna: ['뉴나', 'nuna'],
  Joie: ['조이', 'joie'],
  Egg: ['에그', 'egg'],
  'D.THRONE': ['디트로네', 'd.throne', 'dthrone'],
  Britax: ['브리텍스', '브리탁스', 'britax'],
  'Maxi-Cosi': ['맥시코시', 'maxi-cosi', 'maxicosi'],
  'Silver Cross': ['실버크로스', 'silvercross'],
  Ergobaby: ['에르고베이비', '에르고', 'ergobaby'],
  Doona: ['두나', 'doona'],
};
// 모델명에서 토큰으로 삼기에 너무 일반적인 단어(단독으로는 모델을 특정하지 못한다).
const GENERIC_NAME_TOKENS = new Set(['하이체어', '유모차', '카시트', '바운서', '아기띠', '캐리어', '베이비', '세트', '프레임', '구성', '신생아', '이유식', '겸용', '회전형', '디럭스', '리뉴', '리미티드', '프로', '클래식', '스타일', '메쉬', '시트', '베이스', '시스템', '트래블', '바구니', '포함', '소프트', '미니', '에어']);
// 캡션에 로마자로 적힐 수 있는 모델명 별칭. 공백 제거 텍스트에서 찾는 소문자 기준.
const LATIN_MODEL_ALIASES: Record<string, string[]> = {
  트립트랩: ['tripptrapp'], 요요: ['yoyo'], 폭스: ['fox'], 버터플라이: ['butterfly'], 드래곤플라이: ['dragonfly'],
  프리암: ['priam'], 미오스: ['mios'], 멜리오: ['melio'], 제로나: ['zerona'], 피파: ['pipa'], 트리브: ['triv'],
  아이스핀: ['ispin'], 하모니: ['harmony'], 블리스: ['bliss'], 밸런스: ['balance'], 이니셜: ['initial'],
  듀얼픽스: ['dualfix'], 미카: ['mica'], 타이탄: ['titan'], 리프: ['reef'], 듄: ['dune'], 옴니: ['omni'],
  브리즈: ['breeze'], 애스턴마틴: ['astonmartin'], 익스플로리: ['explory'], 베이비세트: ['babyset'], 넥스트: ['next'],
};

function nameTokens(name: string): string[] {
  return name.replace(/[()+&/,.]/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2 && /\p{L}/u.test(t) && !GENERIC_NAME_TOKENS.has(t) && !/^[A-Za-z]{1,2}$/.test(t));
}

type ModelEntry = { id: string; brand: string; name: string; brandAliases: string[]; tokens: { display: string; keys: string[]; distinctive: boolean }[] };
const MODEL_TABLE: ModelEntry[] = (() => {
  const perModel = seedModels.map(m => nameTokens(m.model));
  const frequency = new Map<string, number>();
  for (const tokens of perModel) for (const token of new Set(tokens)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return seedModels.map((m, i) => ({
    id: `model-${i + 1}`,
    brand: m.brand,
    name: m.model,
    brandAliases: BRAND_ALIASES[m.brand] ?? [m.brand.toLowerCase()],
    tokens: perModel[i].map(token => ({ display: token, keys: [token, ...(LATIN_MODEL_ALIASES[token] ?? [])], distinctive: frequency.get(token) === 1 })),
  }));
})();

export function extractModels(text: string): ModelSuggestion[] {
  const compact = stripUrls(text).replace(/\s+/g, '').toLowerCase();
  if (compact.length < 2) return [];
  const out: ModelSuggestion[] = [];
  for (const m of MODEL_TABLE) {
    const brandHit = m.brandAliases.find(alias => compact.includes(alias));
    const hits = m.tokens.filter(token => token.keys.some(key => compact.includes(key)));
    if (!brandHit && !hits.length) continue;
    const distinctive = hits.some(token => token.distinctive);
    const confidence = brandHit && distinctive ? 0.95 : brandHit && hits.length ? 0.9 : distinctive ? 0.8 : hits.length ? 0.75 : 0.35;
    out.push({ model_id: m.id, brand: m.brand, name: m.name, matched: [brandHit, ...hits.map(h => h.display)].filter((v): v is string => Boolean(v)), confidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.model_id.localeCompare(b.model_id)).slice(0, 10);
}

// ── 가격 매칭 ────────────────────────────────────────────────────────────────
type PriceMatch = { value: number; raw: string; confidence: number; format: string; line: string; lineIndex: number; column: number; arrowTail: boolean };
const NOISE_LINE = /조회|좋아요|댓글|팔로워|영상|릴스|하트/;
const PRICE_KEYWORDS: [RegExp, number][] = [
  [/공구가|공동구매가|공동구매\s*가격/g, 3],
  [/공구|공동구매|이벤트가|쿠폰가|할인가|파격가|특가/g, 1.5],
  [/가격|판매가|구매가/g, 0.5],
  [/정가|원가/g, -1.5],
  [/배송비|배송료/g, -3],
];

export function extractPrices(text: string): { prices: PriceSuggestion[]; primary: PriceSuggestion | null } {
  const lines = collapseNumberRuns(stripUrls(text)).split(/\r?\n/);
  const matches: PriceMatch[] = [];
  lines.forEach((line, lineIndex) => {
    const push = (raw: string, value: number, confidence: number, format: string, column: number) => {
      if (Number.isSafeInteger(value) && value >= 0 && value <= 1e9 && raw.length <= 120) matches.push({ value, raw, confidence, format, line, lineIndex, column, arrowTail: false });
    };
    for (const m of line.matchAll(/(?<![\d.,])(?:(?:\d{1,3},)+\d{3}|\d{3,})\s*원/g)) push(m[0], Number(m[0].replace(/[,\s원]/g, '')), 0.9, 'won', m.index ?? 0);
    for (const m of line.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*만\s*원/g)) push(m[0], Math.round(Number(m[1].replace(/,/g, '')) * 10000), 0.9, 'man_won', m.index ?? 0);
    for (const m of line.matchAll(/(\d[\d,]*)\s*만\s*(\d{1,3})\s*천\s*원?/g)) push(m[0], Number(m[1].replace(/,/g, '')) * 10000 + Number(m[2]) * 1000, 0.85, 'man_cheon', m.index ?? 0);
    if (!NOISE_LINE.test(line)) {
      for (const m of line.matchAll(/(\d{1,3}(?:\.\d+)?)\s*만(?![\d원천])/g)) push(m[0], Math.round(Number(m[1]) * 10000), 0.6, 'man_bare', m.index ?? 0);
      const bare = /^\s*((?:\d{1,3},)+\d{3})\s*$/.exec(line);
      if (bare) push(bare[1], Number(bare[1].replace(/,/g, '')), 0.5, 'bare_line', 0);
    }
  });
  // 같은 줄에서 두 가격이 ~ · - · → 등으로 연결되면 범위/할인 화살표로 해석한다.
  const byLine = new Map<number, PriceMatch[]>();
  for (const m of matches) byLine.set(m.lineIndex, [...(byLine.get(m.lineIndex) ?? []), m]);
  for (const group of byLine.values()) {
    group.sort((a, b) => a.column - b.column);
    for (let i = 0; i + 1 < group.length; i++) {
      const gap = group[i].line.slice(group[i].column + group[i].raw.length, group[i + 1].column);
      if (/^[\s~∼～\-–—]*$/.test(gap) || /→|⇒|->/.test(gap)) group[i + 1].arrowTail = group[i + 1].arrowTail || /→|⇒|->/.test(gap);
    }
  }
  // 문맥 점수: 공구가/정가/배송비 같은 근처 키워드가 어떤 가격을 뜻하는지 가린다.
  const scored = matches.map(m => {
    let score = m.confidence;
    for (const [re, weight] of PRICE_KEYWORDS) {
      for (const keyword of m.line.matchAll(re)) {
        const keywordEnd = (keyword.index ?? 0) + keyword[0].length;
        const distance = keywordEnd <= m.column ? m.column - keywordEnd : (keyword.index ?? 0) - (m.column + m.raw.length);
        const bonus = weight * Math.max(0, 1 - Math.max(0, distance) / 40);
        if (weight > 0) score = Math.max(score, m.confidence + bonus);
        else score += bonus;
      }
    }
    if (m.arrowTail) score += 2;
    return { m, score };
  });
  const seen = new Set<string>();
  const prices = matches
    .sort((a, b) => a.lineIndex - b.lineIndex || a.column - b.column)
    .filter(m => { const key = `${m.lineIndex}:${m.value}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(m => ({ value: m.value, raw: m.raw, confidence: m.confidence, source_line: m.line.trim().slice(0, 80) }))
    .slice(0, 10);
  if (!scored.length) return { prices, primary: null };
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  const boost = best.score > best.m.confidence + 1 ? 0.05 : 0;
  const primary: PriceSuggestion = { value: best.m.value, raw: best.m.raw, confidence: round2(Math.min(0.95, best.m.confidence + boost)), source_line: best.m.line.trim().slice(0, 80) };
  return { prices, primary };
}

// ── 공구 일정 매칭(KST) ───────────────────────────────────────────────────────
type DateMatch = { year: number | null; month: number; day: number; hour?: number; minute?: number; start: number; end: number; raw: string };
const DATE_RE = /(?<![\d/])(?:(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/]))|(?<![\d/])(?:(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/]))|(?<!\d)(?:(\d{1,2})\s*월\s*(\d{1,2})\s*일(?!\d))/g;
const WEEKDAY = /(?:\(\s*[월화수목금토일](?:요일)?\s*\)|[월화수목금토일](?:요일)?)/;

function matchTimeAfter(text: string, index: number): { hour: number; minute: number; end: number } | null {
  const rest = text.slice(index, index + 28);
  const m = new RegExp(`^\\s*${WEEKDAY.source}?\\s*\\(?\\s*(오전|오후|아침|저녁|밤|am|pm)?\\s*(\\d{1,2})\\s*(?::(\\d{2})|시\\s*(?:(\\d{1,2})\\s*분)?)`, 'i').exec(rest);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = Number(m[3] ?? m[4] ?? 0);
  if (hour > 23 || minute > 59) return null;
  const meridiem = m[1]?.toLowerCase();
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if ((meridiem === '오후' || meridiem === '저녁' || meridiem === '밤' || meridiem === 'pm') && hour < 12) hour += 12;
  if ((meridiem === '오전' || meridiem === '아침' || meridiem === 'am') && hour === 12) hour = 0;
  return { hour, minute, end: index + m[0].length };
}

export function extractDates(text: string, now: Date = new Date()): DateSuggestion | null {
  const t = collapseNumberRuns(stripUrls(text));
  const dates: DateMatch[] = [];
  for (const m of t.matchAll(DATE_RE)) {
    const year = m[1] ? Number(m[1]) : null;
    const month = Number(m[1] ? m[2] : m[4] ?? m[6]);
    const day = Number(m[1] ? m[3] : m[5] ?? m[7]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    let end = (m.index ?? 0) + m[0].length;
    const time = matchTimeAfter(t, end);
    if (time) end = time.end;
    dates.push({ year, month, day, hour: time?.hour, minute: time?.minute, start: m.index ?? 0, end, raw: t.slice(m.index ?? 0, end).trim() });
  }
  if (!dates.length) return null;
  const nowKst = new Date(now.getTime() + 9 * 3_600_000);
  const resolveYear = (d: DateMatch): number => {
    if (d.year) return d.year;
    const year = nowKst.getUTCFullYear();
    const at = (y: number) => Date.UTC(y, d.month - 1, d.day);
    if (at(year) < nowKst.getTime() - 21 * 86_400_000) return year + 1;
    if (at(year) > nowKst.getTime() + 62 * 86_400_000 && at(year - 1) >= nowKst.getTime() - 21 * 86_400_000) return year - 1;
    return year;
  };
  for (const d of dates) {
    const calendar = new Date(Date.UTC(resolveYear(d), d.month - 1, d.day));
    if (calendar.getUTCMonth() !== d.month - 1 || calendar.getUTCDate() !== d.day) return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: DateMatch, endOfDay: boolean) => {
    const hour = d.hour ?? (endOfDay ? 23 : 0);
    const minute = d.minute ?? (endOfDay && d.hour === undefined ? 59 : 0);
    const second = endOfDay && d.hour === undefined ? 59 : 0;
    return `${resolveYear(d)}-${pad(d.month)}-${pad(d.day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;
  };
  const before = (i: number) => t.slice(Math.max(0, dates[i].start - 14), dates[i].start);
  const after = (i: number) => t.slice(dates[i].end, dates[i].end + 12);
  const isEndRole = (i: number) => /까지/.test(after(i)) || /마감|종료/.test(before(i)) || /마감|종료/.test(after(i));
  const isStartRole = (i: number) => /부터/.test(after(i)) || /오픈|시작/.test(before(i));
  const raw = (a: number, b: number) => t.slice(dates[a].start, dates[b].end).trim().slice(0, 60);
  // 두 날짜 토큰이 "~ · - · 부터/에서" 만으로 이어지면 기간 범위로 본다.
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < dates.length; i++) {
    const gap = t.slice(dates[i].end, dates[i + 1].start);
    if (gap.length <= 8 && /^[\s~∼～\-–—]*(?:부터|에서|까지)?[\s~∼～\-–—]*$/.test(gap)) pairs.push([i, i + 1]);
  }
  if (pairs.length) {
    const [a, b] = pairs[0];
    dates[a].year = resolveYear(dates[a]);
    dates[b].year ??= dates[a].year + (dates[b].month < dates[a].month ? 1 : 0);
    const period = /기간/.test(t.slice(Math.max(0, dates[a].start - 20), dates[a].start));
    return { starts_at: iso(dates[a], false), ends_at: iso(dates[b], true), raw: raw(a, b), confidence: period ? 0.95 : 0.85 };
  }
  const startIndex = dates.findIndex((_, i) => isStartRole(i) && !isEndRole(i));
  const endIndex = dates.findIndex((_, i) => isEndRole(i) && !isStartRole(i));
  if (startIndex >= 0 && endIndex >= 0) return { starts_at: iso(dates[startIndex], false), ends_at: iso(dates[endIndex], true), raw: raw(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)), confidence: 0.85 };
  const first = startIndex >= 0 ? startIndex : endIndex >= 0 ? endIndex : 0;
  const explicit = startIndex >= 0 || endIndex >= 0;
  return explicit
    ? endIndex >= 0 && startIndex < 0
      ? { starts_at: null, ends_at: iso(dates[first], true), raw: dates[first].raw, confidence: 0.75 }
      : { starts_at: iso(dates[first], false), ends_at: null, raw: dates[first].raw, confidence: 0.75 }
    : { starts_at: iso(dates[first], false), ends_at: null, raw: dates[first].raw, confidence: 0.5 };
}

// ── 링크 매칭 ────────────────────────────────────────────────────────────────
export function extractLinks(text: string): LinkSuggestion[] {
  const links: LinkSuggestion[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      const parsed = new URL(url);
      if (url.length > 2048 || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    } catch { continue; }
    const window = text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + url.length + 30);
    links.push({ url, kind: 'url', confidence: /공구|구매|오픈|예약|신청|주문|판매|폼|shop|store|link/i.test(window) ? 0.9 : 0.6 });
    if (links.length >= 10) break;
  }
  if (/프로필[^\n]{0,8}(링크|바이오)|링크[^\n]{0,6}(바이오|bio|클립)|바이오[^\n]{0,4}(링크|에)|link\s*in\s*bio/i.test(text)) links.push({ url: '', kind: 'link_in_bio', confidence: 0.85 });
  return links;
}

// ── 통합 ─────────────────────────────────────────────────────────────────────
export function extract(text: string, options: { now?: Date } = {}): Extraction {
  const links = extractLinks(text);
  const { prices, primary } = extractPrices(text);
  const dates = extractDates(text, options.now ?? new Date());
  const models = extractModels(text);
  const confidences = [models[0]?.confidence, primary?.confidence, dates?.confidence, links[0]?.confidence].filter((c): c is number => typeof c === 'number' && c > 0);
  return { models, price: primary, prices, dates, links, confidence: confidences.length ? round2(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0 };
}

// 수집 API 스키마에 맞는 형태로만 좁힌다(전체 후보 목록 등은 검수 화면에 보내지 않음).
export function toSuggestions(extraction: Extraction): Suggestions {
  const suggestions: Suggestions = { models: extraction.models.map(model => ({ ...model, matched: model.matched.slice(0, 8) })), price: extraction.price && { value: extraction.price.value, raw: extraction.price.raw, confidence: extraction.price.confidence }, dates: extraction.dates, links: extraction.links.slice(0, 10), confidence: extraction.confidence };
  // The review API limits suggestions to 8KB. Keep complete URLs, dropping excess hints.
  while (JSON.stringify(suggestions).length > 8000 && suggestions.links.length) suggestions.links.pop();
  return suggestions;
}
