import { createHash } from 'node:crypto';
import { canonicalUrl, filterText } from '../../../shared/privacy-rules';
import { parseHtml, selectAll, decodeEntities, type El } from '../../lib/external/parse';
import { ParseBudget } from '../../lib/external/parse-budget';
import { pangpangPost } from '../../lib/external/pangpang';

export const PREPARATION_VERSION = 1;
export const PAGE_TEXT_LIMIT = 12000;
// Changing these selectors/tokens requires a preparation/filter version bump.
const excludedTags = new Set(['nav', 'header', 'footer', 'aside', 'form']);
const excludedTokens = /(?:^|[\s_-])(?:related|recommendations?|recommended|upsell|crosssell|navigation|menu|private|sr-only|hidden)(?:$|[\s_-])|추천|관련상품/iu;
const excluded = (e: El) => excludedTags.has(e.tag) || excludedTokens.test(`${e.attrs.id ?? ''} ${e.attrs.class ?? ''} ${e.attrs.role ?? ''}`) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(e.attrs.style ?? '');
export type PreparedPage = Readonly<{
  url: string; text: string; content_hash: string; title: string; category: string;
  description: string; identity_description: string; deal_text: string; seller: string; schedule: string;
  pangpang: boolean; truncated: boolean;
  failure: 'candidate_listing' | 'candidate_empty' | 'candidate_ambiguous_product' | 'candidate_evidence_unavailable' | 'candidate_preparation_limit' | null;
}>;
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// Keep line boundaries until privacy/injection inspection, including literal newlines in text nodes.
function regionText(node: El | string): string {
  if (typeof node === 'string') return decodeEntities(node);
  if (excluded(node)) return '';
  const inner = node.children.map(regionText).join('');
  return /^(?:article|main|div|p|section|h[1-6]|li|tr|td|dt|dd|br)$/.test(node.tag) ? `\n${inner}\n` : inner;
}
export function normalizePageText(text: string) {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n')
    .map(line => filterText(line, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
function prune(node: El) {
  node.children = node.children.filter(c => typeof c === 'string' || !excluded(c));
  for (const child of node.children) if (typeof child !== 'string') prune(child);
}
export function preparePage(html: string, rawUrl: string): PreparedPage {
  const url = canonicalUrl(rawUrl), pangpang = !!pangpangPost(url);
  let title = '', category = '', description = '', deal_text = '', seller = '', schedule = '';
  let identity_description = '';
  let failure: PreparedPage['failure'] = null;
  try {
    const root = parseHtml(html, new ParseBudget());
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
      if (regions.length !== 1) failure = regions.length > 1 ? 'candidate_ambiguous_product' : html.trim() ? 'candidate_evidence_unavailable' : 'candidate_empty';
      else {
        const region = regions[0];
        const headings = selectAll(region, pangpang ? 'h1,h2' : 'h1,h2,[itemprop=name]');
        // A heading with itemprop=name is one element, not two identities.
        if (headings.length !== 1) failure = headings.length > 1 ? 'candidate_ambiguous_product' : 'candidate_evidence_unavailable';
        else {
          title = normalizePageText(regionText(headings[0]));
          category = normalizePageText(selectAll(region, '.text-category,[itemprop=category],[data-category]').map(e => e.attrs['data-category'] ?? regionText(e)).join('\n'));
          const sellerLink = selectAll(region, 'a[href]').find(e => { try { return /^\/account\/\d+$/.test(new URL(e.attrs.href, url).pathname); } catch { return false; } });
          seller = normalizePageText(sellerLink ? selectAll(sellerLink, 'p').map(regionText)[0] ?? '' : selectAll(region, 'p.truncate').map(regionText)[0] ?? '');
          const times = selectAll(region, 'time').filter(e => /\d{1,2}\/\d{1,2}/.test(regionText(e)));
          const scheduleEl = times[0]?.parent ?? selectAll(region, 'span').find(e => !selectAll(e, 'span').length && /\d{1,2}\/\d{1,2}/.test(regionText(e)));
          schedule = normalizePageText(scheduleEl ? regionText(scheduleEl) : '');
          const blocks = selectAll(region, '[itemprop=offers],.offer,.offers,.schedule,.conditions,[data-offer],[data-schedule],[data-conditions]');
          deal_text = normalizePageText([title, ...blocks.map(regionText)].join('\n'));
          description = normalizePageText(regionText(region));
          const identityText = (node: El | string): string => {
            if (typeof node === 'string') return decodeEntities(node);
            if (node === sellerLink || /^(?:seller|brand)$/.test(node.attrs.itemprop ?? '') || /(?:^|[\s_-])seller(?:$|[\s_-])/.test(node.attrs.class ?? '') || 'data-seller' in node.attrs || node.tag === 'p' && (node.attrs.class ?? '').split(/\s+/).includes('truncate')) return '';
            const content = node.children.map(identityText).join('');
            return /^(?:article|main|div|p|section|h[1-6]|li|tr|td|dt|dd|br)$/.test(node.tag) ? `\n${content}\n` : content;
          };
          identity_description = normalizePageText(identityText(region)).split('\n').filter(line => !/^(?:판매자|셀러|seller)\s*[:：]/i.test(line)).join('\n');
          if (!title || !description) failure = 'candidate_empty';
          else if (selectAll(region, 'img').length && !description.replace(title, '').trim() && !/공구|공동\s*구매/.test(title)) failure = 'candidate_evidence_unavailable';
        }
      }
    }
  } catch { failure = 'candidate_preparation_limit'; }
  // Fixed field order; offer fields are retained before the bounded description.
  const full = normalizePageText([title, category, seller, schedule, deal_text, description].filter(Boolean).join('\n'));
  const normalized = full.replace(/\s+/g, ' ').trim();
  const text = normalized.slice(0, PAGE_TEXT_LIMIT);
  return Object.freeze({ url, text, content_hash: sha256(text), title, category, description, identity_description, deal_text, seller, schedule, pangpang, truncated: normalized.length > PAGE_TEXT_LIMIT, failure });
}
