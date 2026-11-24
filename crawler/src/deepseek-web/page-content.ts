import { createHash } from 'node:crypto';
import { canonicalUrl, filterText } from '../../../shared/privacy-rules';
import { offerSourceClosed } from '../../../shared/deal-price-evidence';
import { parseHtml, selectAll, decodeEntities, type El } from '../../lib/external/parse';
import { ParseBudget } from '../../lib/external/parse-budget';
import { pangpangPost } from '../../lib/external/pangpang';

export const PREPARATION_VERSION = 3;
export const PAGE_TEXT_LIMIT = 12000;
const BUNDLE_PREAMBLE_LIMIT = 2000;
const BUNDLE_BODY_LIMIT = 1200;
const BUNDLE_MAX_ITEMS = 8;
const BUNDLE_MIN_ITEMS = 2;
export const BUNDLE_HINT = /(?:모음전|묶음전|패키지(?:\s*구성)?|여러\s*상품|(?:전체\s*)?\d+\s*종\s*(?:모음|구성|특가)|\d+\s*종\s*특가)/u;
// Changing these selectors/tokens requires a preparation/filter version bump.
const excludedTags = new Set(['nav', 'header', 'footer', 'aside', 'form', 'title']);
const excludedTokens = /(?:^|[\s_-])(?:related|recommendations?|recommended|upsell|crosssell|navigation|menu|private|sr-only|hidden)(?:$|[\s_-])|추천|관련상품/iu;
const excluded = (e: El) => excludedTags.has(e.tag) || excludedTokens.test(`${e.attrs.id ?? ''} ${e.attrs.class ?? ''} ${e.attrs.role ?? ''}`) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(e.attrs.style ?? '');
// The source's own status badge (text-status-*) is volatile run-state wording:
// it never enters prepared text or the content hash, only deal_status. It stays
// in the tree (prune keeps it) so dealStatus can still read it.
const statusBadge = (e: El) => (e.attrs.class ?? '').includes('text-status');
export type PreparedBundleRegion = { index: number; title: string; start: number; end: number };
export type PreparedBundle = { hint: string; title: string; regions: PreparedBundleRegion[] };
export type DealStatus = 'ended' | 'scheduled' | 'open' | null;
export type PreparedPage = Readonly<{
  url: string; text: string; content_hash: string; title: string; category: string;
  description: string; identity_description: string; deal_text: string; seller: string; schedule: string;
  deal_status: DealStatus; source_closure: string; price_capture: string;
  pangpang: boolean; truncated: boolean; bundle: PreparedBundle | null;
  failure: 'candidate_listing' | 'candidate_empty' | 'candidate_ambiguous_product' | 'candidate_evidence_unavailable' | 'candidate_preparation_limit' | 'candidate_bundle_unsupported' | null;
}>;
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// Keep line boundaries until privacy/injection inspection, including literal newlines in text nodes.
function regionText(node: El | string): string {
  if (typeof node === 'string') return decodeEntities(node);
  if (excluded(node) || statusBadge(node)) return '';
  const inner = node.children.map(regionText).join('');
  return /^(?:article|main|div|p|section|h[1-6]|li|tr|td|dt|dd|br)$/.test(node.tag) ? `\n${inner}\n` : inner;
}
// Keep heading and option-row boundaries in the price capture. Price labels
// and values come from visible cells, in their original order.
function priceRegionText(node: El | string): string {
  if (typeof node === 'string') return decodeEntities(node).replace(/\[(?:상품|항목|옵션 행|주문 가능)\]/g, '');
  if (excluded(node) || statusBadge(node) || 'hidden' in node.attrs || node.attrs['aria-hidden'] === 'true') return '';
  const text = () => node.children.map(priceRegionText).join('');
  if (node.tag === 'tr') {
    const cells = node.children.filter((child): child is El =>
      typeof child !== 'string' && ['td', 'th'].includes(child.tag) && !excluded(child) &&
      !('hidden' in child.attrs) && child.attrs['aria-hidden'] !== 'true').map(cell =>
      normalizePageText(cell.children.map(priceRegionText).join('')).replace(/[|\n]+/g, ' '));
    const labeled: string[] = [];
    for (const cell of cells) {
      if (labeled.at(-1)?.endsWith(':')) labeled[labeled.length - 1] += ' ' + cell;
      else if (cell) labeled.push(cell);
    }
    return labeled.length ? '\n[옵션 행] ' + labeled.join(' | ') + '\n' : '';
  }
  if (node.tag === 'button' && !('disabled' in node.attrs) && node.attrs['aria-disabled'] !== 'true' &&
      /^(?:공구 주문하기|구매하기|주문하기)$/.test(flat(text()))) return '[주문 가능] ' + flat(text());
  if (/^h[1-2]$/.test(node.tag)) return '\n[상품] ' + flat(text()) + '\n';
  if (/^h[3-6]$/.test(node.tag)) return '\n[항목] ' + flat(text()) + '\n';
  if (node.tag === 'li' && selectAll(node, 'p,div').length) return '\n[항목] ' + text().trim() + '\n';
  const content = text();
  return /^(?:article|main|div|p|section|li|dt|dd|br|table|caption)$/.test(node.tag) ? `\n${content}\n` : content;
}
export function normalizePageText(text: string) {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n')
    .map(line => filterText(line, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
const flat = (text: string) => normalizePageText(text).replace(/\s+/g, ' ').trim();
function prune(node: El) {
  node.children = node.children.filter(c => typeof c === 'string' || !excluded(c));
  for (const child of node.children) if (typeof child !== 'string') prune(child);
}
function isInside(node: El, ancestor: El): boolean {
  for (let up = node.parent; up; up = up.parent) if (up === ancestor) return true;
  return false;
}
type BundlePlan =
  | { kind: 'bundle'; title: string; hint: string; text: string; regions: PreparedBundleRegion[]; category: string; seller: string; schedule: string; deal_status: DealStatus; source_closure: string; description: string; identity_description: string; deal_text: string }
  | { kind: 'failure'; failure: 'candidate_bundle_unsupported' | 'candidate_preparation_limit' | 'candidate_evidence_unavailable' };

// Deal status comes only from the source's own status badge, classified by its
// text (never the class suffix or page-wide 마감 wording: "마감 2026-11-15" is a
// date label, not a status). Ended wins over any scheduled/open wording so a
// closed deal can never be queued. Badges are skipped by every text walk, so
// their labels are read through a raw walk of the still-attached node.
const rawText = (node: El | string): string => typeof node === 'string' ? decodeEntities(node) : node.children.map(rawText).join('');
function dealState(scope: El): { deal_status: DealStatus; source_closure: string } {
  const labels = selectAll(scope, 'span')
    .filter(e => (e.attrs.class ?? '').includes('text-status'))
    .map(e => normalizePageText(rawText(e)).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const source_closure = labels.find(offerSourceClosed) ?? '';
  const deal_status = labels.some(label => /종료/.test(label) || label === '마감') ? 'ended' :
    labels.some(label => /예정/.test(label)) ? 'scheduled' :
    labels.some(label => /오픈/.test(label)) ? 'open' : null;
  return { deal_status, source_closure };
}

function bundleMeta(scope: El, url: string) {
  const category = normalizePageText(selectAll(scope, '.text-category,[itemprop=category],[data-category]').map(e => e.attrs['data-category'] ?? regionText(e)).join('\n'));
  const sellerLink = selectAll(scope, 'a[href]').find(e => { try { return /^\/account\/\d+$/.test(new URL(e.attrs.href, url).pathname); } catch { return false; } });
  const seller = normalizePageText(sellerLink ? selectAll(sellerLink, 'p').map(regionText)[0] ?? '' : selectAll(scope, 'p.truncate').map(regionText)[0] ?? '');
  const times = selectAll(scope, 'time').filter(e => /\d{1,2}\/\d{1,2}/.test(regionText(e)));
  const scheduleEl = times[0]?.parent ?? selectAll(scope, 'span').find(e => !selectAll(e, 'span').length && /\d{1,2}\/\d{1,2}/.test(regionText(e)));
  const schedule = normalizePageText(scheduleEl ? regionText(scheduleEl) : '');
  return { category, seller, schedule, ...dealState(scope) };
}

function identityDescription(scope: El, url: string): string {
  const sellerLink = selectAll(scope, 'a[href]').find(e => { try { return /^\/account\/\d+$/.test(new URL(e.attrs.href, url).pathname); } catch { return false; } });
  const identityText = (node: El | string): string => {
    if (typeof node === 'string') return decodeEntities(node);
    if (statusBadge(node) || node === sellerLink || /^(?:seller|brand)$/.test(node.attrs.itemprop ?? '') || /(?:^|[\s_-])seller(?:$|[\s_-])/.test(node.attrs.class ?? '') || 'data-seller' in node.attrs || node.tag === 'p' && (node.attrs.class ?? '').split(/\s+/).includes('truncate')) return '';
    const content = node.children.map(identityText).join('');
    return /^(?:article|main|div|p|section|h[1-6]|li|tr|td|dt|dd|br)$/.test(node.tag) ? `\n${content}\n` : content;
  };
  return normalizePageText(identityText(scope)).split('\n').filter(line => !/^(?:판매자|셀러|seller)\s*[:：]/i.test(line)).join('\n');
}

/**
 * Assign every source text node to exactly one piece (preamble or one item).
 * The heading itself belongs to its item so a quote may include the product name.
 */
function partition(scope: El, regionBlocks: El[] | null, itemHeadings: El[]): { preamble: string; bodies: string[] } {
  const preambleParts: string[] = [], bodyParts: string[][] = itemHeadings.map(() => []);
  const headingIndex = new Map<El, number>(itemHeadings.map((h, i) => [h, i]));
  let current = -1;
  const emit = (text: string) => { if (current < 0) preambleParts.push(text); else bodyParts[current].push(text); };
  const visit = (node: El | string): void => {
    if (typeof node === 'string') { emit(decodeEntities(node)); return; }
    if (excluded(node) || statusBadge(node)) return;
    if (regionBlocks && regionBlocks.includes(node)) {
      current = -1;
      for (const child of node.children) visit(child);
      current = -1;
      return;
    }
    const idx = headingIndex.get(node);
    if (idx !== undefined) {
      current = idx;
      for (const child of node.children) visit(child);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(scope);
  return { preamble: flat(preambleParts.join('')), bodies: bodyParts.map(parts => flat(parts.join(''))) };
}

function buildBundle(scope: El, regionBlocks: El[] | null, itemHeadings: El[], hint: string, title: string, url: string): BundlePlan {
  if (itemHeadings.length < BUNDLE_MIN_ITEMS || itemHeadings.length > BUNDLE_MAX_ITEMS) return { kind: 'failure', failure: 'candidate_bundle_unsupported' };
  if (new Set(itemHeadings).size !== itemHeadings.length) return { kind: 'failure', failure: 'candidate_bundle_unsupported' };
  const { preamble, bodies } = partition(scope, regionBlocks, itemHeadings);
  if (bodies.some(body => !body)) return { kind: 'failure', failure: 'candidate_evidence_unavailable' };
  if (/\[\[상품/u.test(preamble) || bodies.some(body => /\[\[상품/u.test(body))) return { kind: 'failure', failure: 'candidate_bundle_unsupported' };
  if (preamble.length > BUNDLE_PREAMBLE_LIMIT || bodies.some(body => body.length > BUNDLE_BODY_LIMIT)) return { kind: 'failure', failure: 'candidate_preparation_limit' };
  let text = preamble;
  const regions: PreparedBundleRegion[] = [];
  for (let i = 0; i < bodies.length; i++) {
    text += `${text ? '\n' : ''}[[상품 ${i + 1}]]\n`;
    const start = text.length;
    text += bodies[i];
    regions.push({ index: i + 1, title: normalizePageText(regionText(itemHeadings[i])), start, end: text.length });
  }
  if (text.length > PAGE_TEXT_LIMIT) return { kind: 'failure', failure: 'candidate_preparation_limit' };
  const meta = bundleMeta(scope, url);
  return {
    kind: 'bundle', title, hint, text, regions, ...meta,
    description: normalizePageText(bodies.join('\n')),
    identity_description: identityDescription(scope, url),
    deal_text: normalizePageText([title, ...bodies].filter(Boolean).join('\n')),
  };
}

function headingText(heading: El) { return normalizePageText(regionText(heading)); }

export function preparePage(html: string, rawUrl: string): PreparedPage {
  const url = canonicalUrl(rawUrl), pangpang = !!pangpangPost(url);
  let title = '', category = '', description = '', deal_text = '', seller = '', schedule = '';
  let deal_status: DealStatus = null, source_closure = '';
  let identity_description = '', price_capture = '';
  let failure: PreparedPage['failure'] = null;
  let bundleText: string | null = null, bundle: PreparedBundle | null = null, bundleAttempted = false;
  try {
    const root = parseHtml(html, new ParseBudget());
    // <title> is never page text, but it remains a bundle-hint fallback.
    const titleEl = selectAll(root, 'title')[0];
    prune(root);
    const all = selectAll(root, '*');
    if (new URL(url).hostname === '09pangpang.com' && !pangpang) failure = 'candidate_listing';
    else {
      const articles = selectAll(root, 'article');
      const micro = all.filter(e => /(?:^|\/)Product$/.test(e.attrs.itemtype ?? '') && 'itemscope' in e.attrs);
      let regions: El[];
      if (pangpang) regions = articles;
      else if (micro.length) regions = micro;
      else if (articles.length) regions = articles;
      else regions = selectAll(root, 'main');
      // Bundle hint may come from a surviving page-level h1, the first region
      // heading (when the page title was pruned), or the <title> fallback.
      const regionOf = (el: El) => regions.some(region => region === el || isInside(el, region));
      const pageH1 = selectAll(root, 'h1').find(h => !regionOf(h));
      // regionText() drops excluded tags, so read the captured <title>'s children directly.
      const titleText = titleEl ? normalizePageText(titleEl.children.map(regionText).join('')) : '';
      const pageHint = pageH1 ? headingText(pageH1) : titleText;
      const selector = pangpang ? 'h1,h2' : 'h1,h2,[itemprop=name]';
      const firstHeadings = regions.length ? selectAll(regions[0], selector) : [];
      const hintSource = [pageHint, firstHeadings[0] ? headingText(firstHeadings[0]) : ''].filter(Boolean);
      const hasHint = hintSource.some(text => BUNDLE_HINT.test(text));

      if (regions.length > 1) {
        if (!hasHint) failure = 'candidate_ambiguous_product';
        else {
          bundleAttempted = true;
          const blockHeadings = regions.map(region => selectAll(region, selector));
          if (regions.length > BUNDLE_MAX_ITEMS || blockHeadings.some(headings => headings.length !== 1)) failure = 'candidate_bundle_unsupported';
          else {
            const itemHeadings = blockHeadings.map(headings => headings[0]);
            const plan = buildBundle(root, regions, itemHeadings, pageHint || headingText(itemHeadings[0]), pageHint || headingText(itemHeadings[0]), url);
            if (plan.kind === 'failure') failure = plan.failure;
            else {
              ({ title, category, seller, schedule, deal_status, source_closure, description, identity_description, deal_text } = plan);
              bundle = { hint: plan.hint, title: plan.title, regions: plan.regions };
              bundleText = plan.text;
            }
          }
        }
      } else if (regions.length === 0) {
        failure = html.trim() ? 'candidate_evidence_unavailable' : 'candidate_empty';
      } else {
        const region = regions[0];
        const headings = selectAll(region, selector);
        if (headings.length === 1) {
          // Existing single-product path: byte-for-byte preserved.
          title = normalizePageText(regionText(headings[0]));
          category = normalizePageText(selectAll(region, '.text-category,[itemprop=category],[data-category]').map(e => e.attrs['data-category'] ?? regionText(e)).join('\n'));
          const sellerLink = selectAll(region, 'a[href]').find(e => { try { return /^\/account\/\d+$/.test(new URL(e.attrs.href, url).pathname); } catch { return false; } });
          seller = normalizePageText(sellerLink ? selectAll(sellerLink, 'p').map(regionText)[0] ?? '' : selectAll(region, 'p.truncate').map(regionText)[0] ?? '');
          const times = selectAll(region, 'time').filter(e => /\d{1,2}\/\d{1,2}/.test(regionText(e)));
          const scheduleEl = times[0]?.parent ?? selectAll(region, 'span').find(e => !selectAll(e, 'span').length && /\d{1,2}\/\d{1,2}/.test(regionText(e)));
          schedule = normalizePageText(scheduleEl ? regionText(scheduleEl) : '');
          ({ deal_status, source_closure } = dealState(region));
          const blocks = selectAll(region, '[itemprop=offers],.offer,.offers,.schedule,.conditions,[data-offer],[data-schedule],[data-conditions]');
          deal_text = normalizePageText([title, ...blocks.map(regionText)].join('\n'));
          description = normalizePageText(regionText(region));
          price_capture = normalizePageText(priceRegionText(region));
          const identityText = (node: El | string): string => {
            if (typeof node === 'string') return decodeEntities(node);
            if (statusBadge(node) || node === sellerLink || /^(?:seller|brand)$/.test(node.attrs.itemprop ?? '') || /(?:^|[\s_-])seller(?:$|[\s_-])/.test(node.attrs.class ?? '') || 'data-seller' in node.attrs || node.tag === 'p' && (node.attrs.class ?? '').split(/\s+/).includes('truncate')) return '';
            const content = node.children.map(identityText).join('');
            return /^(?:article|main|div|p|section|h[1-6]|li|tr|td|dt|dd|br)$/.test(node.tag) ? `\n${content}\n` : content;
          };
          identity_description = normalizePageText(identityText(region)).split('\n').filter(line => !/^(?:판매자|셀러|seller)\s*[:：]/i.test(line)).join('\n');
          if (!title || !description) failure = 'candidate_empty';
          else if (selectAll(region, 'img').length && !description.replace(title, '').trim() && !/공구|공동\s*구매/.test(title)) failure = 'candidate_evidence_unavailable';
        } else if (headings.length === 0) {
          failure = 'candidate_evidence_unavailable';
        } else if (!hasHint) {
          failure = 'candidate_ambiguous_product';
        } else {
          bundleAttempted = true;
          const pageLevelHasHint = BUNDLE_HINT.test(pageHint);
          const firstText = headingText(headings[0]);
          const firstHasHint = BUNDLE_HINT.test(firstText);
          // A first heading that itself carries the hint is the bundle title,
          // unless a *structural* page-level heading already supplies a distinct
          // title. A <title>-only hint is a text fallback, so a differing title
          // string must not turn the in-region bundle heading into an item.
          const firstIsBundleTitle = firstHasHint && (!pageLevelHasHint || pageH1 === undefined || firstText === pageHint);
          const itemHeadings = firstIsBundleTitle ? headings.slice(1) : headings;
          const bundleTitle = firstIsBundleTitle ? firstText : pageHint || firstText;
          const plan = buildBundle(region, null, itemHeadings, pageHint || bundleTitle, bundleTitle, url);
          if (plan.kind === 'failure') failure = plan.failure;
          else {
            ({ title, category, seller, schedule, deal_status, source_closure, description, identity_description, deal_text } = plan);
            bundle = { hint: plan.hint, title: plan.title, regions: plan.regions };
            bundleText = plan.text;
          }
        }
      }
    }
  } catch { failure = 'candidate_preparation_limit'; }
  // Fixed field order; offer fields are retained before the bounded description.
  const full = normalizePageText([title, category, seller, schedule, deal_text, description].filter(Boolean).join('\n'));
  const normalized = full.replace(/\s+/g, ' ').trim();
  const text = bundleText ?? normalized.slice(0, PAGE_TEXT_LIMIT);
  // Bundle preparation never truncates: it fails closed above the caps instead.
  const truncated = bundleAttempted ? false : normalized.length > PAGE_TEXT_LIMIT;
  return Object.freeze({ url, text, content_hash: sha256(text), title, category, description, identity_description, deal_text, seller, schedule, deal_status, source_closure, price_capture, pangpang, truncated, bundle, failure });
}
