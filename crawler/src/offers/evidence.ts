import { threadsPost } from '../../../shared/threads-url';
import { threadsPostBody } from '../deal-prices/threads';
import { createHash } from 'node:crypto';
import { filterText } from '../../../shared/privacy-rules';
import { catalogIdentity, metadataFields, OFFER_CATEGORIES, offerImage, offerText, offerUrl, sellerHandle,
  type Availability, type MetadataReading, type OfferCategory, type OfferFacts } from '../../../shared/verified-offer';
import { offerSourceClosed, assessPriceEvidence, displayExclusion, filterOfferCapture, metadataStart, offerDeadlinePrecision, type PriceEvidence } from '../../../shared/deal-price-evidence';
import { decodeEntities, parseHtml, selectAll, type El } from '../../lib/external/parse';
import { ParseBudget } from '../../lib/external/parse-budget';
import { BUNDLE_HINT } from '../deepseek-web/page-content';
import type { GeunbonCatalog } from '../deepseek-web/catalog';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type CatalogRow = { id: string; brand: string; name: string; category: OfferCategory; source_url?: string };
export type CatalogSnapshot = { revision: string; models: CatalogRow[] };
export function catalogSnapshot(value: unknown): CatalogSnapshot | null {
  if (!Array.isArray(value) || !value.length) return null;
  const models: CatalogRow[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !offerText(item.id, 160) || !offerText(item.brand, 120) || !offerText(item.name, 160)
      || typeof item.category !== 'string' || ids.has(item.id)) return null;
    ids.add(item.id);
    if (OFFER_CATEGORIES.some(category => item.category === category))
      models.push({ id: item.id, brand: item.brand, name: item.name, category: item.category, source_url: offerUrl(item.source_url) ?? undefined });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models.length ? { revision: hash(catalogIdentity(models)), models } : null;
}

const norm = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const brandNames: Record<string, string[]> = { silvercross: ['실버크로스'], stokke: ['스토케'], babybjorn: ['베이비뵨'], artipoppe: ['아티포페'], habebriks: ['하베브릭스'] };
const matching = (text: string, aliases: string[]) => aliases.some(alias => norm(alias).length >= 2 && norm(text).includes(norm(alias)));
const ENDED = /^(?:공구\s*)?(?:종료|판매\s*종료|마감|품절|closed|sold out)(?:되었습니다)?[.!]?$/i;
const SCHEDULED = /(?:오픈\s*예정|판매\s*예정|coming soon)/i;
const ONGOING = /(?:상시\s*(?:공구|판매|구매|진행)|(?:공구|판매)\s*상시|until sold out)/i;
const OPEN = /^(?:공구\s*)?(?:오픈|진행\s*중|판매\s*중|open)[.!]?$/i;
export type ProductRegion = {
  locator: string; title: string; text: string; links: string[]; sellers: string[]; source: string;
  badge: { value: Availability; locator: string } | null;
  digest: string; truncated: boolean; image: string | null;
};

const hidden = (node: El) => ['script', 'style', 'template', 'noscript', 'nav', 'aside', 'footer', 'form', 'head'].includes(node.tag)
  || 'hidden' in node.attrs || node.attrs['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.attrs.style ?? '')
  || /(?:^|[\s_-])(?:recommendations?|related|private|upsell)(?:$|[\s_-])/i.test(node.attrs.class ?? '');
function visible(node: El) {
  for (let parent: El | null = node; parent; parent = parent.parent) if (hidden(parent)) return false;
  return true;
}
function textOf(node: El | string): string {
  if (typeof node === 'string') return decodeEntities(node);
  if (hidden(node)) return '';
  const text = node.children.map(textOf).join('');
  return /^(?:div|h[1-6]|ul|li|p|br|td|tr|dd|dt|section|article|time|span)$/.test(node.tag) ? `\n${text}\n` : text;
}
const clean = (text: string, limit: number) => text.split(/\r?\n/).map(line => filterText(line, limit)).filter(line => line && !line.includes('[redacted]')).join(' ');
const classify = (text: string): Availability | null => ENDED.test(text) ? 'closed' : SCHEDULED.test(text) ? 'scheduled' : ONGOING.test(text) ? 'ongoing' : OPEN.test(text) ? 'open' : null;
const heading = 'h1,h2,h3,[itemprop=name]';
function safeLink(value: string | undefined, base: string) {
  try { return value ? offerUrl(new URL(value, base).href) : null; } catch { return null; }
}
function sellerUrl(url: string) {
  const target = new URL(url);
  if (/(?:^|\.)instagram\.com$/.test(target.hostname) && /^\/[a-z\d._]+$/i.test(target.pathname) &&
    !/^\/(?:stories|p|reels?|accounts|explore)$/i.test(target.pathname))
    return `https://www.instagram.com${target.pathname.toLowerCase()}`;
  if (/(?:^|\.)threads\.(?:com|net)$/.test(target.hostname) && /^\/@[a-z\d._]+$/i.test(target.pathname)) return `https://www.threads.net${target.pathname.toLowerCase()}`;
  if (target.hostname === 'smartstore.naver.com' && /^\/[a-z\d_-]+(?:\/products\/\d+)?$/i.test(target.pathname))
    return `https://smartstore.naver.com/${target.pathname.split('/')[1].toLowerCase()}`;
  if (target.origin === 'https://09pangpang.com' && /^\/account\/\d+$/.test(target.pathname)) return url;
  return null;
}
function region(source: string, locator: string, title: string, raw: string, nodes: El[], shared: El[], image: string | null): ProductRegion {
  const all = [...nodes, ...shared];
  const links = [...new Set(all.flatMap(node => selectAll(node, 'a[href]').filter(visible).map(link => safeLink(link.attrs.href, source))).filter((link): link is string => !!link))];
  const sellerNodes = all.flatMap(node => selectAll(node, 'a[href]').filter(visible));
  const sellers = [...new Set([sellerUrl(source), ...sellerNodes.flatMap(link => {
    const url = safeLink(link.attrs.href, source);
    if (!url) return [];
    if (/(?:^|\s)seller(?:\s|$)|publisher|merchant/i.test(`${link.attrs.rel ?? ''} ${link.attrs.itemprop ?? ''} ${link.attrs.class ?? ''}`) || 'data-seller' in link.attrs)
      return [sellerUrl(url) ?? url];
    return sellerUrl(url) ?? [];
  })].filter((seller): seller is string => !!seller))];
  const badges = all.flatMap((node, group) => selectAll(node, 'span,[data-offer-status],[itemprop=availability]').filter(item => visible(item) && (item.attrs.class?.includes('text-status') || 'data-offer-status' in item.attrs || item.attrs.itemprop === 'availability')).flatMap((item, index) => {
    const value = classify(clean(item.attrs['data-offer-status'] ?? textOf(item), 160));
    return value ? [{ value, locator: `${locator}:${group < nodes.length ? 'product' : 'shared'}:${group}:${index}` }] : [];
  }));
  const badge = badges.find(item => item.value === 'closed') ?? badges[0] ?? null;
  const evidence = clean([raw, ...shared.map(textOf)].join('\n'), 12_000);
  const lines = [raw, ...shared.map(textOf)].join('\n').split(/\r?\n/)
    .map(line => filterText(line, 3600)).filter(line => line && !line.includes('[redacted]'));
  if (badge?.value === 'closed' && !lines.includes('공구 종료')) lines.unshift('공구 종료');
  const text = filterOfferCapture(lines.join('\n').slice(0, 3600));
  return { locator, title, text, links, sellers, source, badge, truncated: evidence.length > 3600, image,
    digest: hash([text, locator, badge, links, sellers, image, 'product-region@1']) };
}

/** Walk explicit product containers first. A heading-delimited bundle assigns
 * each text node to exactly one region. Global facts require explicit scope. */
export function prepareProductRegions(html: string, source: string): ProductRegion[] {
  const thread = threadsPost(source);
  if (thread) {
    const text = threadsPostBody(html, thread);
    return text ? [socialRegion(source, thread.account, text, null)] : [];
  }
  const root = parseHtml(html, new ParseBudget());
  const select = (node: El, query: string) => selectAll(node, query).filter(visible);
  const scopes = select(root, '[data-product],[itemtype],.product-row,.deal-item').filter(node => 'data-product' in node.attrs || /(?:^|\/)Product$/.test(node.attrs.itemtype ?? '') || /(?:product-row|deal-item)/.test(node.attrs.class ?? ''));
  const articles = select(root, 'article');
  const main = select(root, 'main')[0] ?? root;
  const blocks = scopes.length ? scopes : articles;
  const regionSet = new Set(blocks);
  const parentInside = (node: El) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (regionSet.has(parent)) return true;
    return false;
  };
  const shared = select(root, '[data-scope=all-products],[data-shared-offer]').filter(node => !parentInside(node));
  const result: ProductRegion[] = [];
  const occurrences = new Map<string, number>();
  const add = (title: string, raw: string, nodes: El[]) => {
    const name = clean(title, 180).slice(0, 180);
    const key = hash(name).slice(0, 16);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const images = nodes.flatMap(node => select(node, 'img,[itemprop=image]')).map(node =>
      node.attrs['data-src'] ?? node.attrs.src ?? node.attrs.content);
    if (blocks.length <= 1 && nodes[0] === main) images.push(selectAll(root, 'meta[property="og:image"]')[0]?.attrs.content);
    const image = images.flatMap(item => {
      try { const safe = item && offerImage(new URL(item, source).href); return safe ? [safe] : []; } catch { return []; }
    })[0] ?? null;
    result.push(region(source, `product:${key}:${occurrence}`, name, raw, nodes, shared, image));
  };
  for (const block of blocks.length ? blocks.filter(block => !parentInside(block)) : [main]) {
    const headings = select(block, heading);
    const first = headings[0];
    const bundle = first && BUNDLE_HINT.test(clean(textOf(first), 400));
    const productHeadings = bundle ? headings.slice(1) : headings;
    if (bundle && productHeadings.length >= 1 || !scopes.length && productHeadings.length > 1 && !first?.tag.includes('1')) {
      const indexes = new Map(productHeadings.map((node, index) => [node, index]));
      const parts = productHeadings.map(node => ({ title: textOf(node), chunks: [] as string[], nodes: [] as El[] }));
      let current: typeof parts[number] | undefined;
      const walk = (node: El | string) => {
        if (typeof node === 'string') { current?.chunks.push(node); return; }
        if (hidden(node) || shared.includes(node)) return;
        const index = indexes.get(node);
        if (index !== undefined) current = parts[index];
        if (/^(?:a|span|time|div|p|h[1-6])$/.test(node.tag)) current?.chunks.push('\n');
        if (/^(?:a|time|span|img)$/.test(node.tag) || node.attrs['data-offer-status'] !== undefined)
          current?.nodes.push({ tag: 'scope', attrs: {}, children: [node], parent: null });
        for (const child of node.children) walk(child);
        current?.chunks.push('\n');
      };
      walk(block);
      for (const part of parts) add(part.title, decodeEntities(part.chunks.join('')), part.nodes);
    } else if (first || blocks.length) {
      add(first ? textOf(first) : '', textOf(block), [block]);
    }
  }
  return result;
}

export function socialRegion(source: string, seller: string, evidence: string, image: string | null): ProductRegion {
  const text = filterOfferCapture(evidence.slice(0, 3600));
  const thread = threadsPost(source);
  const sellers = [thread ? `https://www.threads.net/@${seller}` : `https://www.instagram.com/${seller}`];
  const badge = offerSourceClosed(text)
    ? { value: 'closed' as const, locator: 'caption:status' } : null;
  return { source, title: '', text, locator: 'caption', digest: hash([text, sellers, badge, image]), links: [], sellers, badge, truncated: evidence.length > 3600, image };
}

export function relevant(text: string, catalog: CatalogSnapshot | null, discovery: GeunbonCatalog) {
  return /공구|공동\s*구매|group\s*buy|모음전/.test(text)
    || (catalog?.models ?? []).some(row => matching(text, [row.name, row.brand, ...(brandNames[norm(row.brand)] ?? [])]))
    || discovery.products.some(row => matching(text, [...row.brand_aliases, ...row.search_terms, row.product_line]));
}

export type Assertion = { value: string; quote: string };
const fields = metadataFields;
export type Extraction = MetadataReading;
export const PROVIDER_SCHEMA = 'offer-extraction@1';
export function parseExtraction(content: string): Extraction | null {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length) return null;
  const facts = {} as Extraction;
  for (const field of fields) {
    const item = raw[field] as Partial<Assertion> | null | undefined;
    if (item !== null && (!item || typeof item !== 'object' || !offerText(item.value, 2048) || !offerText(item.quote, 500))) return null;
    facts[field] = item === null ? null : { value: item.value!, quote: item.quote! };
  }
  return facts;
}
function grounded(field: Assertion | null, text: string) {
  return field && text.includes(field.quote) ? field.value : null;
}
function exactGrounded(field: Assertion | null, text: string) {
  const value = grounded(field, text);
  return field && value && norm(field.quote).includes(norm(value)) ? value : null;
}
export function catalogMatch(extraction: Extraction, region: ProductRegion, snapshot: CatalogSnapshot | null, discovery: GeunbonCatalog) {
  const assertedBrand = grounded(extraction.brand, region.text), assertedModel = grounded(extraction.model, region.text);
  const configuration = exactGrounded(extraction.configuration, region.text);
  if (!snapshot || !assertedBrand || !assertedModel) return { model: null, failure: 'catalog_missing' };
  const rows = snapshot.models.filter(row => {
    const brand = norm(row.brand);
    const aliases = [row.brand, ...(brandNames[brand] ?? []), ...discovery.products.filter(p => norm(p.brand) === brand).flatMap(p => p.brand_aliases)];
    if (!aliases.some(alias => norm(alias) === norm(assertedBrand)) || !matching(extraction.brand!.quote, aliases)) return false;
    if (!norm(extraction.model!.quote).includes(norm(assertedModel))) return false;
    const name = norm(row.name), model = norm(assertedModel);
    return name === model || configuration && (name === norm(model + configuration) || name === norm(model + '세트' + configuration)
      || name.startsWith(model) && matching(row.name, [configuration]) && norm(region.title || extraction.model!.quote).includes(name));
  });
  if (rows.length === 1) return { model: rows[0], failure: null };
  const base = norm(assertedModel);
  const possibleVariants = snapshot.models.filter(row => norm(row.name).startsWith(base));
  return { model: null, failure: rows.length > 1 || possibleVariants.length > 0 ? 'configuration_ambiguous' : 'catalog_missing' };
}

export const emptyExtraction = Object.fromEntries(fields.map(field => [field, null])) as Extraction;
export function evaluateProduct(input: {
  region: ProductRegion; extraction: Extraction | null; verification: Extraction | null; catalog: CatalogSnapshot | null;
  discovery: GeunbonCatalog; checkedAt: string; live: 'live' | 'changed' | 'unavailable'; now: number; priceEvidence: PriceEvidence | null;
}) {
  const { region, catalog, discovery, priceEvidence } = input;
  const reading = (metadata: Extraction | null) => {
    const r = metadata ?? emptyExtraction;
    const match = catalogMatch(r, region, catalog, discovery);
    return { ...match, seller: r.seller && region.sellers.includes(r.seller.value) &&
      (r.seller.quote === r.seller.value || region.text.includes(r.seller.quote)) ? r.seller.value : null,
      offer: r.offer?.value === region.source && (r.offer.quote === region.source || region.text.includes(r.offer.quote)) ? region.source : null,
      start: r.start && region.text.includes(r.start.quote) ? metadataStart(r.start.quote) : null };
  };
  const first = reading(input.extraction), second = reading(input.verification);
  const { seller, offer, start, model } = first;
  const assessed = priceEvidence ? assessPriceEvidence(priceEvidence) : null;
  const prices = assessed?.facts;
  const variant = priceEvidence?.official_approval?.variant;
  const failures = new Set<string>();
  if (!input.extraction) failures.add('deepseek_unavailable');
  if (!input.verification) failures.add('qwen_unavailable');
  if (first.failure) failures.add(first.failure);
  if (!seller) failures.add('seller_unverified');
  if (!offer || input.live !== 'live') failures.add(input.live === 'changed' ? 'source_changed' : 'source_unavailable');
  if (input.extraction?.start && !start || input.verification?.start && !second.start) failures.add('start_unverified');
  if (input.verification && (second.model?.id !== model?.id || second.seller !== seller || second.offer !== offer || second.start !== start)) failures.add('qwen_disagrees');
  if (region.truncated) failures.add('capture_truncated');
  if (priceEvidence?.offer) {
    if (priceEvidence.offer.readings.some(r => r?.amount == null || !r.price)) failures.add('missing_offer_price');
    if (priceEvidence.offer.readings.some(r => !r?.deadline)) failures.add('missing_deadline');
  }
  if (!priceEvidence?.official && model) failures.add('missing_official_coverage');
  if (assessed && assessed.outcome !== 'verified') failures.add(assessed.outcome);
  if (prices) {
    const exclusion = displayExclusion(prices.deal_price_krw, prices.list_price_krw);
    if (exclusion) failures.add(exclusion);
    if (model && (variant?.site_model_id !== model.id || norm(prices.configuration.model) !== norm(model.name))) failures.add('configuration_mismatch');
    if (start && start >= prices.ends_at) failures.add('schedule_unproven');
  }
  if (region.badge?.value === 'closed' || prices && Date.parse(prices.ends_at) < input.now) failures.add('ended');
  const deadline = offerDeadlinePrecision(priceEvidence?.offer?.readings[0] ?? null);
  const facts: OfferFacts | null = model && seller && offer && prices && deadline ? {
    ...prices, model_id: model.id, brand: model.brand, model: model.name, category: model.category,
    title: [model.brand, model.name].join(' ').slice(0, 200), seller_url: seller, seller_handle: sellerHandle(seller), source_url: offer,
    starts_at: start, deadline_precision: deadline, availability: start && start > input.checkedAt ? 'scheduled' : prices.orders_open ? 'open' : 'unknown',
    image_url: region.image,
  } : null;
  return { failures: [...failures], facts };
}

export function discoveryLinks(html: string, source: string) {
  const root = parseHtml(html, new ParseBudget());
  return selectAll(root, 'a[href],loc,link').filter(visible).flatMap((node, index) => {
    const destination = safeLink(node.attrs.href ?? (node.tag === 'loc' || node.tag === 'link' ? clean(textOf(node), 2048) : undefined), source);
    if (!destination || destination === source) return [];
    const label = clean(textOf(node), 400);
    const relation = node.tag === 'loc' ? 'sitemap' : node.tag === 'link' ? 'feed' :
      /(?:^|\s)(?:seller|publisher|merchant)(?:\s|$)/i.test(node.attrs.rel ?? '') || 'data-seller' in node.attrs ? 'seller' : 'link';
    return [{ destination, label, locator: `link:${index + 1}`, relation }];
  });
}
