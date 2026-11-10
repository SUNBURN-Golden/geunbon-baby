import { checkExternalRegion, externalValues, sanitizedRegion } from './checked';
import type { FactCheck } from '../deal-fact-check';
// 외부 목록 HTML 파서. 의존성 없는 소형 태그 스캐너 + 단순 셀렉터 + 범용 휴리스틱.
// 순수 함수라 합성 픽스처로만 검증한다. 이미지·미디어 URL은 아예 읽지 않는다.
import { type DateSuggestion } from '../extract';
import { decide } from './robots';
import type { ParseBudget } from './parse-budget';
const budgets = new WeakMap<El, ParseBudget>();

export type El = { tag: string; attrs: Record<string, string>; children: (El | string)[]; parent: El | null };
export type ParsedItem = {
  source_url: string; title: string; text: string; category_text: string;
  price: { value: number; raw: string } | null; dates: DateSuggestion | null;
  fact_checks?: FactCheck[];
  seller_handle: string | null; seller_url: string | null;
};

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'textarea', 'select']);
const BLOCK = new Set(['address', 'article', 'aside', 'br', 'dd', 'div', 'dl', 'dt', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'th', 'tr', 'ul']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
  if (name[0] === '#') {
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return ENTITIES[name.toLowerCase()] ?? match;
});

export function parseHtml(html: string, budget?: ParseBudget): El {
  budget?.preflight(html);
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null };
  if (budget) budgets.set(root, budget);
  let node = root;
  let nesting = 0;
  const depths = new WeakMap<El, number>(); depths.set(root, 0);
  const tag = /<\?[^>]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!(?:doctype|[^>]*)>|<\/([a-z][\w:-]*)\s*>|<([a-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let last = 0;
  const pushText = (value: string) => { if (value) { budget?.node(); node.children.push(value); } };
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html))) {
    budget?.node();
    pushText(html.slice(last, match.index));
    last = tag.lastIndex;
    if (match[1]) {
      const name = match[1].toLowerCase();
      for (let up: El | null = node; up && up.parent; up = up.parent) { budget?.spend(); if (up.tag === name) { node = up.parent; break; } }
    } else if (match[2]) {
      const name = match[2].toLowerCase();
      const attrs: Record<string, string> = {};
      for (const attr of match[3].matchAll(/([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) { budget?.node(); attrs[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''); }
      const excluded = (!!budget && name === 'form') || SKIP.has(name) || name === 'input' || attrs.contenteditable !== undefined || attrs.hidden !== undefined || attrs['aria-hidden']?.toLowerCase() === 'true' || attrs['data-private'] !== undefined;
      const closed = VOID.has(name) || match[3].trim().endsWith('/');
      if (excluded) {
        if (!closed) {
          // Raw-text elements do not contain HTML nesting. Other excluded regions
          // must consume the matching close, including nested tags of the same name.
          if (['script', 'style', 'textarea'].includes(name)) {
            const close = new RegExp(`</${name}\\s*>`, 'gi');
            close.lastIndex = last;
            const end = close.exec(html);
            last = end ? close.lastIndex : html.length;
          } else {
            let depth = 1, nested: RegExpExecArray | null;
            while (depth && (nested = tag.exec(html))) {
              budget?.node(); if (budget && depth > 128) throw new Error('preparation_limit');
              if (nested[2] && ['script','style','textarea'].includes(nested[2].toLowerCase())) {
                const rawClose=new RegExp(`</${nested[2]}\\s*>`,'gi');rawClose.lastIndex=tag.lastIndex;
                tag.lastIndex=rawClose.exec(html)?rawClose.lastIndex:html.length;
              } else if (nested[1]?.toLowerCase() === name) depth--;
              else if (nested[2]?.toLowerCase() === name && !nested[3].trim().endsWith('/')) depth++;
            }
            last = depth ? html.length : tag.lastIndex;
          }
          tag.lastIndex = last;
        }
        continue;
      }
      const element: El = { tag: name, attrs, children: [], parent: node };
      nesting = (depths.get(node) ?? 0) + 1;
      if (budget && nesting > 128) throw new Error('preparation_limit');
      depths.set(element, nesting); if (budget) budgets.set(element, budget);
      node.children.push(element);
      if (!closed) node = element;
    }
  }
  pushText(html.slice(last));
  return root;
}

export function textOf(el: El | string): string {
  if (typeof el === 'string') return decodeEntities(el).replace(/[ \t\f\r\n]+/g, ' ');
  const budget = budgets.get(el); budget?.spend(el.children.length + 1);
  if (SKIP.has(el.tag)) return '';
  const inner = el.children.map(textOf).join('');
  return BLOCK.has(el.tag) ? `\n${inner}\n` : inner;
}
// 줄 단위로 정리한 텍스트.
export const linesOf = (el: El) => textOf(el).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

function* walk(el: El): Generator<El> {
  for (const child of el.children) { budgets.get(el)?.spend(); if (typeof child !== 'string') { yield child; yield* walk(child); } }
}

// ── 단순 셀렉터: tag, .class, #id, [attr], [attr=value], 쉼표 목록, 공백(자손) 결합자 ───────────────
type Simple = { tag?: string; id?: string; classes: string[]; attrs: [string, string | null][] };
function parseSimple(token: string): Simple {
  const simple: Simple = { classes: [], attrs: [] };
  const re = /^([a-z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/gi;
  let consumed = 0;
  for (const m of token.matchAll(re)) {
    if (m.index !== consumed) throw new Error(`지원하지 않는 셀렉터: ${token}`);
    consumed += m[0].length;
    if (m[1] && m[1] !== '*') simple.tag = m[1].toLowerCase();
    if (m[2]) simple.id = m[2];
    if (m[3]) simple.classes.push(m[3]);
    if (m[4]) simple.attrs.push([m[4].toLowerCase(), m[5] ?? m[6] ?? m[7] ?? null]);
  }
  if (consumed !== token.length || !token) throw new Error(`지원하지 않는 셀렉터: ${token}`);
  return simple;
}
const matchSimple = (el: El, s: Simple) =>
  (!s.tag || el.tag === s.tag) && (!s.id || el.attrs.id === s.id) &&
  s.classes.every(name => (el.attrs.class ?? '').split(/\s+/).includes(name)) &&
  s.attrs.every(([name, value]) => name in el.attrs && (value === null || el.attrs[name] === value));
export function selectAll(root: El, selector: string): El[] {
  const chains = selector.split(',').map(part => part.trim().split(/\s+/).map(parseSimple));
  const out: El[] = [];
  for (const el of walk(root)) {
    if (chains.some(chain => {
      if (!matchSimple(el, chain[chain.length - 1])) return false;
      let up = el.parent;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (up && !matchSimple(up, chain[i])) { budgets.get(root)?.spend(); up = up.parent; }
        if (!up) return false;
        up = up.parent;
      }
      return true;
    })) out.push(el);
  }
  return out;
}

/** Remove unrelated descendants before establishing a product evidence scope. */
export function pruneProductRegion(region: El): void {
  region.children = region.children.filter(child => typeof child === 'string' || !['aside','nav','header','footer','form'].includes(child.tag) && !/(?:^|\s)(?:related|recommendations?|recommended|upsell|crosssell|navigation|menu|private|hidden)(?:$|[\s_-])|추천|관련상품/iu.test(`${child.attrs.id ?? ''} ${child.attrs.class ?? ''} ${child.attrs.role ?? ''}`) && !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(child.attrs.style ?? ''));
  for (const child of region.children) if (typeof child !== 'string') pruneProductRegion(child);
}

// ── 항목 추출 ───────────────────────────────────────────────────────────────
const SIGNAL = /\d[\d,]*\s*원|\d+(?:\.\d+)?\s*만\s*원|공구|공동\s*구매|오픈|마감|특가|\d{1,2}\s*[/월]\s*\d{1,2}/;
const NOT_HANDLES = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'direct']);
const hasLink = (el: El) => el.tag === 'a' && Boolean(el.attrs.href) || [...walk(el)].some(child => child.tag === 'a' && child.attrs.href);

function itemElements(root: El, selector: string): El[] {
  if (selector) return selectAll(root, selector);
  const qualifying = [...walk(root)].filter(el => ['a', 'li', 'article', 'tr', 'div', 'section'].includes(el.tag) && hasLink(el) && SIGNAL.test(textOf(el)));
  // 가장 안쪽 후보(leaf)만 남기고, 형제 항목과 섞이지 않는 가장 큰 카드 컨테이너까지 올라간다.
  const leaves = qualifying.filter(el => !qualifying.some(other => other !== el && contains(el, other)));
  const cards = new Set<El>();
  for (const leaf of leaves) {
    let card = leaf;
    while (card.parent && !['html', 'body', 'main', 'ul', 'ol', 'table', 'tbody', '#root'].includes(card.parent.tag) &&
      leaves.filter(other => contains(card.parent!, other) || other === card.parent).length === 1 && textOf(card.parent).length <= 600) card = card.parent;
    cards.add(card);
  }
  return [...cards];
}
function contains(ancestor: El, el: El) {
  for (let up = el.parent; up; up = up.parent) { budgets.get(el)?.spend(); if (up === ancestor) return true; }
  return false;
}

export const EXTERNAL_PARSER_VERSION = 'generic-3';
export type CandidateOutcome = { candidate_index:number } & (
  { reason:'parsed'; item_index:number } | { reason:'no_text'|'no_allowed_link' }
);
export type DetailedParse = { items:ParsedItem[]; selected:number; outcomes:CandidateOutcome[] };

export function parseItemsDetailed(html: string, pageUrl: string, origin: string, selector = '', now: Date = new Date()): DetailedParse {
  const root = parseHtml(html);
  const items: ParsedItem[] = [];
  const outcomes:CandidateOutcome[]=[];
  const candidates=itemElements(root,selector);
  for (const [candidate_index,el] of candidates.entries()) {
    pruneProductRegion(el);
    const lines = linesOf(el);
    if (!lines.length) {outcomes.push({candidate_index,reason:'no_text'});continue;}
    const text = sanitizedRegion(lines.join('\n'));
    let sourceUrl: string | null = null;
    let scopeTitle = lines[0];
    const productLinks = new Set<string>(), productTitles = new Set<string>();
    let sellerHandle: string | null = null;
    let sellerUrl: string | null = null;
    for (const link of [...(el.tag === 'a' ? [el] : []), ...[...walk(el)].filter(child => child.tag === 'a')]) {
      const href = link.attrs.href;
      if (!href || /^(javascript|mailto|tel):/i.test(href)) continue;
      let url: URL;
      try { url = new URL(href, pageUrl); } catch { continue; }
      if (['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) {
        const handle = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(url.pathname)?.[1];
        if (handle && !NOT_HANDLES.has(handle.toLowerCase()) && !sellerHandle) { sellerHandle = handle.toLowerCase(); sellerUrl = `https://www.instagram.com/${sellerHandle}/`; }
        continue;
      }
      url.hash = '';
      if (decide(url, origin).allowed) {
        const label = sanitizedRegion(textOf(link));
        productLinks.add(url.href); if (label) productTitles.add(label);
        if (!sourceUrl) { sourceUrl = url.href; scopeTitle = label; }
      }
    }
    // 같은 origin 링크가 없는 항목은 고유한 출처 URL이 없으므로 쓰지 않는다.
    if (!sourceUrl) {outcomes.push({candidate_index,reason:'no_allowed_link'});continue;}
    if (!sellerHandle) {
      const mention = /(?<![\w.])@([A-Za-z0-9._]{2,30})/.exec(text)?.[1].replace(/\.+$/, '');
      if (mention) { sellerHandle = mention.toLowerCase(); sellerUrl = `https://www.instagram.com/${sellerHandle}/`; }
    }
    const scoped = productLinks.size === 1 && productTitles.size <= 1 && selectAll(el,'h1,h2,h3,[itemprop=name]').length <= 1;
    const fact_check = checkExternalRegion(text, pageUrl, now, scoped ? undefined : {gonggu_price:null,period:null}, scopeTitle);
    const checked = externalValues([fact_check]);
    const category = [el, ...walk(el)].filter(child => /(^|[-_\s])(cate|category)/i.test(child.attrs.class ?? '') || 'data-category' in child.attrs)
      .map(child => child.attrs['data-category'] ?? textOf(child)).join(' ').replace(/\s+/g, ' ').trim();
    outcomes.push({candidate_index,reason:'parsed',item_index:items.length});
    items.push({
      source_url: sourceUrl, title: sanitizedRegion(lines[0], 200), text, category_text: sanitizedRegion(category, 100),
      ...checked, fact_checks: [fact_check],
      seller_handle: sellerHandle, seller_url: sellerUrl,
    });
  }
  return {items,selected:candidates.length,outcomes};
}

// The array API and URL selection remain compatible; facts use the checked contract.
export function parseItems(html: string, pageUrl: string, origin: string, selector = '', now: Date = new Date()): ParsedItem[] {
  return parseItemsDetailed(html,pageUrl,origin,selector,now).items;
}

// 상세 페이지에서 목록에 없던 가격·일정만 보충한다(follow_detail_links).
export function parseDetail(html: string, now: Date = new Date(), source = 'https://detail.invalid/product', expectedTitle?: string): Pick<ParsedItem, 'price' | 'dates' | 'fact_checks'> {
  const root = parseHtml(html);
  const productRegions = selectAll(root, '[itemtype],article,main').filter(el => el.tag === 'article' || el.tag === 'main' || /(?:^|\/)Product$/.test(el.attrs.itemtype ?? ''));
  // Nested main/article is a single scope only when it contains one identifying heading.
  const leaves = productRegions.filter(el => !productRegions.some(other => other !== el && contains(el, other)));
  if (leaves.length !== 1) return { price: null, dates: null, fact_checks: [] };
  const region = leaves[0]; pruneProductRegion(region);
  const headings = selectAll(region, 'h1,h2,h3,[itemprop=name]');
  if (headings.length !== 1 || expectedTitle && sanitizedRegion(textOf(headings[0])) !== sanitizedRegion(expectedTitle)) return { price: null, dates: null, fact_checks: [] };
  const text = sanitizedRegion(linesOf(region).join('\n'));
  const check = checkExternalRegion(text, source, now, undefined, textOf(headings[0]));
  return { ...externalValues([check]), fact_checks: [check] };
}
/** Preserve listing/detail source provenance and enrich each missing endpoint independently. */
export function enrichDetail(item: ParsedItem, detail: ReturnType<typeof parseDetail>): ParsedItem {
  const fact_checks = [...(item.fact_checks ?? []), ...(detail.fact_checks ?? [])];
  return { ...item, ...externalValues(fact_checks), fact_checks };
}
