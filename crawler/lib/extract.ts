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
// Only declared aliases contribute evidence. Seed frequency and unknown seed words
// never establish an identity. Each form lists the internal OCR breaks we allow.
type Role = 'distinctive' | 'ambiguous' | 'accessory' | 'variant' | 'phrase' | 'branded';
type Alias = { key: string; role: Role; forms: string[][]; version?: string; qualifier?: string };
const aliases: Alias[] = [];
function alias(key: string, role: Role, forms: (string | string[])[] = [], version?: string, qualifier?: string) {
  aliases.push({ key, role, forms: [key, ...forms].map(f => typeof f === 'string' ? [f] : f), version, qualifier });
}
alias('트립트랩', 'distinctive', [['트립', '트랩'], ['tripp', 'trapp']]);
alias('익스플로리', 'distinctive', ['explory'], undefined, 'x');
alias('프리암', 'distinctive', ['priam'], undefined, '4\\.0');
alias('미오스', 'distinctive', ['mios'], undefined, '3\\.0');
alias('멜리오', 'distinctive', ['melio'], undefined, '3\\.0');
alias('제로나', 'distinctive', ['zerona'], undefined, 'gi|t');
alias('피파', 'distinctive', ['pipa']);
alias('트리브', 'distinctive', ['triv']);
alias('아이스핀', 'distinctive', ['ispin'], undefined, '360');
alias('듀얼픽스', 'distinctive', ['dualfix']);
for (const [key, latin, version] of [
  ['요요', 'yoyo', '3'], ['폭스', 'fox', '5'], ['버터플라이', 'butterfly', '2'],
  ['에그', 'egg', '3'], ['리프', 'reef', '2'], ['듄', 'dune', '2'],
]) alias(key, 'ambiguous', [latin], version);
for (const [key, latin] of [
  ['드래곤플라이', 'dragonfly'], ['블리스', 'bliss'], ['밸런스', 'balance'],
  ['하모니', 'harmony'], ['이니셜', 'initial'], ['미카', 'mica'], ['타이탄', 'titan'],
  ['옴니', 'omni'], ['브리즈', 'breeze'], ['넥스트', 'next'], ['두나', 'doona'],
]) alias(key, 'ambiguous', [latin]);
for (const [key, latin] of [
  ['트레이', 'tray'], ['배시넷', 'bassinet'], ['범퍼바', 'bumper bar'], ['섀시', 'chassis'],
  ['뉴본', 'newborn'], ['프레임', 'frame'], ['시트', 'seat'], ['베이스', 'base'],
]) alias(key, 'accessory', [latin.split(' ')]);
alias('베이비세트', 'accessory', ['babyset', ['baby', 'set'], ['베이비', '세트']]);
for (const [key, latin] of [
  ['너도밤나무', 'beech'], ['오크', 'oak'], ['느와르', 'noir'], ['카본', 'carbon'],
  ['리뉴', 'renew'], ['리미티드', 'limited'], ['프로', 'pro'], ['메쉬', 'mesh'],
  ['소프트', 'soft'], ['미니', 'mini'], ['원', 'one'], ['에어', 'air'],
  ['LUX', 'lux'], ['STYLE', 'style'], ['CLASSIC', 'classic'],
]) alias(key, 'variant', [latin]);
alias('애스턴마틴', 'variant', [['애스턴', '마틴'], ['aston', 'martin']]);
alias('옴니 브리즈', 'phrase', [['옴니', '브리즈'], ['omni', 'breeze']]);
alias('피파넥스트', 'phrase', [['피파', '넥스트'], ['pipa', 'next']]);
alias('토들넥스트', 'phrase', [['토들', '넥스트'], ['todl', 'next']]);
alias('두나 카시트 겸용 유모차', 'phrase', [['두나', '카시트', '겸용', '유모차'], ['doona', 'car', 'seat', 'stroller']]);
alias('원 에어', 'branded', [['원', '에어'], ['one', 'air']]);

const BRAND_ALIASES: Record<string, (string | string[])[]> = {
  Stokke: ['스토케', '스토케코리아', 'stokke'],
  BabyBjorn: ['베이비뵨', '베이비본', '베이비비욘', ['baby', 'bjorn'], ['baby', 'björn']],
  Bugaboo: ['부가부', 'bugaboo'], Cybex: ['싸이벡스', '사이벡스', 'cybex'],
  Nuna: ['뉴나', 'nuna'], Joie: ['조이', 'joie'], Egg: ['에그', 'egg'],
  'D.THRONE': ['디트로네', 'd.throne', 'dthrone'], Britax: ['브리텍스', '브리탁스', 'britax'],
  'Maxi-Cosi': ['맥시코시', 'maxi-cosi', ['maxi', 'cosi']],
  'Silver Cross': ['실버크로스', ['silver', 'cross']],
  Ergobaby: ['에르고베이비', '에르고', 'ergobaby'], Doona: ['두나', 'doona'],
};
type Rule = { families: string[]; refiners: string[]; bundle: string[] };
const rules: Record<string, Rule> = {};
function rule(ids: number[], families: string[], refiners: string[] = [], bundle: string[] = []) {
  for (const id of ids) rules[`model-${id}`] = { families, refiners, bundle };
}
rule([1], ['트립트랩'], ['너도밤나무']); rule([2], ['트립트랩'], ['오크']);
rule([3], ['트립트랩'], ['베이비세트'], ['베이비세트']);
rule([4], ['트립트랩'], ['베이비세트', '트레이'], ['베이비세트', '트레이']);
rule([5], ['트립트랩'], ['뉴본', '베이비세트', '트레이'], ['뉴본', '베이비세트', '트레이']);
rule([6], ['익스플로리']); rule([7], ['요요'], ['프레임']);
rule([8], ['요요'], ['프레임', '시트'], ['프레임', '시트']);
rule([9], ['요요'], ['뉴본', '배시넷'], ['뉴본', '배시넷']);
rule([10], ['폭스'], ['리뉴']); rule([11], ['폭스'], ['느와르', '리미티드']);
rule([12], ['버터플라이'], ['범퍼바'], ['범퍼바']);
rule([13], ['드래곤플라이'], ['배시넷'], ['배시넷']);
rule([14], ['드래곤플라이'], ['섀시', '시트'], ['섀시', '시트']);
rule([15], ['프리암']); rule([16], ['미오스']); rule([17], ['멜리오'], ['카본']);
rule([18, 19], ['제로나']); rule([20], ['피파', '피파넥스트']);
rule([21], ['넥스트', '토들넥스트', '피파넥스트'], ['베이스']);
rule([22], ['트리브', '피파넥스트']); rule([23], ['아이스핀']); rule([24], ['아이스핀'], ['메쉬']);
rule([25], ['블리스']); rule([26], ['밸런스'], ['소프트']); rule([27], ['하모니']);
rule([28], ['원 에어'], ['원', '에어']); rule([29], [], ['미니']);
rule([30], ['에그']); rule([31], ['에그'], ['애스턴마틴']); rule([32], ['이니셜']);
rule([33], ['듀얼픽스'], ['프로', 'LUX']); rule([34], ['듀얼픽스'], ['프로', 'STYLE']);
rule([35], ['듀얼픽스'], ['프로', 'CLASSIC']); rule([36], ['미카'], ['프로']); rule([37], ['타이탄'], ['프로']);
rule([38], ['리프']); rule([39], ['듄']); rule([40], ['옴니', '브리즈', '옴니 브리즈']);
rule([41], ['두나', '두나 카시트 겸용 유모차']);
const MODEL_TABLE = seedModels.map((m, i) => ({ id: `model-${i + 1}`, brand: m.brand, name: m.model, rule: rules[`model-${i + 1}`] }));

const WORD = String.raw`[\p{L}\p{M}\p{N}_]`;
const PARTICLE = '에서|으로|은|는|이|가|을|를|과|와|도|만|의|에|로';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const formsPattern = (forms: string[][]) => `(?:${forms.map(parts => parts.map(p => escape(p.normalize('NFKC').toLowerCase())).join('\\s*')).join('|')})`;
function bounded(pattern: string, korean: boolean) {
  return new RegExp(`(?<!${WORD})${pattern}(?:(?:공동구매|공구)${korean ? `|(?:${PARTICLE})` : ''})?(?!${WORD})`, 'gu');
}
function aliasPattern(a: Alias) {
  return `${formsPattern(a.forms)}${a.version ? `(?:\\s*${a.version})?` : ''}${a.qualifier ? `(?:\\s+(?:${a.qualifier}))?` : ''}`;
}
type Hit = { key: string; role: Role | 'brand'; start: number; end: number; raw: string; identified: boolean; qualified?: string };
const ALIAS_PATTERNS = aliases.flatMap(a => a.forms.flatMap(form => {
  const korean = /[가-힣]/u.test(form.join(''));
  const base = formsPattern([form]);
  const qualifier = a.qualifier ? `(?:\\s+(?:${a.qualifier}))?` : '';
  // A Latin family may take a Korean particle after its declared version,
  // but an unversioned Latin word still requires the normal boundary.
  return a.version && !korean
    ? [{ a, re: bounded(`${base}\\s*${a.version}`, true) }, { a, re: bounded(base, false) }]
    : [{ a, re: bounded(`${base}${a.version ? `(?:\\s*${a.version})?` : ''}${qualifier}`, korean) }];
}));
const BRAND_PATTERNS = Object.entries(BRAND_ALIASES).flatMap(([key, forms]) => forms.map(form => {
  const parts = typeof form === 'string' ? [form] : form;
  return { key, re: bounded(formsPattern([parts]), /[가-힣]/u.test(parts.join(''))) };
}));
// Concatenations are allowed only for these declared same-brand Korean pairs.
const COMPOUNDS = [
  ['스토케', 'Stokke', ['트립트랩', '익스플로리', '요요']], ['부가부', 'Bugaboo', ['폭스', '버터플라이', '드래곤플라이']],
  ['싸이벡스', 'Cybex', ['프리암', '미오스', '멜리오', '제로나']], ['사이벡스', 'Cybex', ['프리암', '미오스', '멜리오', '제로나']],
  ['뉴나', 'Nuna', ['피파', '트리브', '피파넥스트', '토들넥스트']],
] as const;
const COMPOUND_PATTERNS = COMPOUNDS.flatMap(([prefix, brand, keys]) => keys.map(key => {
  const a = aliases.find(a => a.key === key)!;
  return { prefix, brand, a, re: bounded(`${escape(prefix)}${aliasPattern(a)}`, true) };
}));
function modelHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const addAlias = (a: Alias, start: number, raw: string) => hits.push({ key: a.key, role: a.role, start, end: start + raw.length, raw,
    identified: a.role === 'distinctive' || a.role === 'phrase' || Boolean(a.version && /\d/u.test(raw)),
    qualified: a.qualifier ? new RegExp(`\\s+(${a.qualifier})(?:(?:${PARTICLE})|공동구매|공구)?$`, 'u').exec(raw)?.[1] : undefined });
  for (const { a, re } of ALIAS_PATTERNS) for (const m of text.matchAll(re)) addAlias(a, m.index!, m[0]);
  for (const { key, re } of BRAND_PATTERNS) for (const m of text.matchAll(re)) hits.push({ key, role: 'brand', start: m.index!, end: m.index! + m[0].length, raw: m[0], identified: false });
  for (const { prefix, brand, a, re } of COMPOUND_PATTERNS) for (const m of text.matchAll(re)) {
    hits.push({ key: brand, role: 'brand', start: m.index!, end: m.index! + prefix.length, raw: prefix, identified: false });
    addAlias(a, m.index! + prefix.length, m[0].slice(prefix.length));
  }
  // A complete phrase supersedes the words inside it, including a Doona brand
  // alias which otherwise would corroborate its own ambiguous family word.
  const unique = hits.filter((h, i) => hits.findIndex(p => p.key === h.key && p.role === h.role && p.start === h.start && p.end === h.end) === i);
  return unique.filter(h => !unique.some(p => p.role === 'phrase' && p !== h && p.start <= h.start && p.end >= h.end));
}
const isFamily = (h: Hit) => ['distinctive', 'ambiguous', 'phrase', 'branded'].includes(h.role);
const gap = (a: Hit, b: Hit) => Math.max(0, a.start - b.end, b.start - a.end);
const MENTION_SEPARATOR = /[\p{P}+&|]|(?:^|\s)(?:그리고|및|또는|혹은|and|or|vs)(?:\s|$)|(?:과|와)\s*$/u;
function connected(a: Hit, b: Hit, text: string, hits: Hit[], components = false): boolean {
  const left = a.start < b.start ? a : b, right = left === a ? b : a;
  const between = text.slice(left.end, right.start);
  // Declared components/variants can use bundle notation or parentheses, as in
  // the seed names. Another family/brand still stops that association below.
  const mention = components ? between.replace(/[+&()[\]]/gu, ' ') : between;
  if (MENTION_SEPARATOR.test(mention) || /(?:과|와)$/u.test(left.raw)) return false;
  return !hits.some(h => h !== a && h !== b && h.start >= left.end && h.end <= right.start &&
    (h.role === 'brand' || (isFamily(h) && h.key !== a.key && h.key !== b.key)));
}
function brandFor(h: Hit, text: string, hits: Hit[]): { brand?: Hit; conflict: boolean } {
  const nearby = hits.filter(b => b.role === 'brand' && (b.end <= h.start || b.start >= h.end) && connected(h, b, text, hits));
  const distance = Math.min(...nearby.map(b => gap(h, b)));
  const nearest = nearby.filter(b => gap(h, b) === distance);
  return { brand: nearest.length === 1 ? nearest[0] : undefined, conflict: nearest.length > 1 };
}

// Rank independently assessed spans without ever joining their OCR text. Evidence
// from separate mentions/fields cannot accumulate into a stronger identity.
export function rankModels(models: ModelSuggestion[]): ModelSuggestion[] {
  const sorted = models.slice().sort((a, b) => b.confidence - a.confidence || b.matched.length - a.matched.length || a.model_id.localeCompare(b.model_id));
  return sorted.filter((m, i) => sorted.findIndex(other => other.model_id === m.model_id) === i).slice(0, 10);
}
export function extractModels(input: string): ModelSuggestion[] {
  const text = stripUrls(input).normalize('NFKC').toLowerCase();
  const hits = modelHits(text), out: ModelSuggestion[] = [];
  for (const m of MODEL_TABLE) {
    if (!m.rule) continue;
    const { families, refiners, bundle } = m.rule;
    for (const h of hits) {
      const family = families.includes(h.key);
      const weak = refiners.includes(h.key);
      if (!family && !weak) continue;
      if (family && !h.identified && hits.some(b => b.role === 'brand' && b.key === m.brand && b.start === h.start && b.end === h.end)) continue;
      const association = brandFor(h, text, hits);
      const brand = association.brand, matching = brand?.key === m.brand;
      const conflict = association.conflict || Boolean(brand && !matching);
      if (h.role === 'branded' && !matching) continue;
      // Mini is a supported carrier phrase only when a matching brand is local.
      const brandedCarrier = matching && ((m.id === 'model-29' && h.key === '미니') || h.role === 'branded');
      if (!family && !matching) continue;
      const established = (family && (h.identified || matching) && h.role !== 'branded') || brandedCarrier;
      const local = hits.filter(r => refiners.includes(r.key) && connected(h, r, text, hits, true));
      const variant = local.some(r => r.role === 'variant' && (r.start < h.start || r.end > h.end));
      const complete = bundle.length > 0 && bundle.every(key => local.some(r => r.key === key));
      const qualifier = h.qualified && ((m.id === 'model-18' && h.qualified === 'gi') || (m.id === 'model-19' && h.qualified === 't'));
      // An explicit Gi/T must not rank the other variant as equally supported.
      if (h.key === '제로나' && h.qualified && ['model-18', 'model-19'].includes(m.id) && !qualifier) continue;
      let confidence = established ? variant || complete || qualifier ? 0.95 : matching ? 0.90 : 0.80 : family ? 0.50 : 0.60;
      if (conflict) confidence = Math.min(confidence, 0.60);
      out.push({ model_id: m.id, brand: m.brand, name: m.name,
        matched: [...new Set([matching ? brand?.raw : undefined, h.key, ...local.map(r => r.key), qualifier ? h.qualified : undefined].filter((v): v is string => Boolean(v)))], confidence });
    }
    for (const brand of hits.filter(h => h.role === 'brand' && h.key === m.brand)) {
      out.push({ model_id: m.id, brand: m.brand, name: m.name, matched: [brand.raw], confidence: 0.35 });
    }
  }
  return rankModels(out);
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
export function extractionConfidence(extraction: Pick<Extraction, 'models' | 'price' | 'dates' | 'links'>): number {
  const confidences = [extraction.models[0]?.confidence, extraction.price?.confidence, extraction.dates?.confidence, extraction.links[0]?.confidence].filter((c): c is number => typeof c === 'number' && c > 0);
  return confidences.length ? round2(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0;
}
export function extract(text: string, options: { now?: Date } = {}): Extraction {
  const links = extractLinks(text);
  const { prices, primary } = extractPrices(text);
  const dates = extractDates(text, options.now ?? new Date());
  const models = extractModels(text);
  const result = { models, price: primary, prices, dates, links };
  return { ...result, confidence: extractionConfidence(result) };
}

// 수집 API 스키마에 맞는 형태로만 좁힌다(전체 후보 목록 등은 검수 화면에 보내지 않음).
export function toSuggestions(extraction: Extraction): Suggestions {
  const suggestions: Suggestions = { models: extraction.models.map(model => ({ ...model, matched: model.matched.slice(0, 8) })), price: extraction.price && { value: extraction.price.value, raw: extraction.price.raw, confidence: extraction.price.confidence }, dates: extraction.dates, links: extraction.links.slice(0, 10), confidence: extraction.confidence };
  // The review API limits suggestions to 8KB. Keep complete URLs, dropping excess hints.
  while (JSON.stringify(suggestions).length > 8000 && suggestions.links.length) suggestions.links.pop();
  return suggestions;
}
