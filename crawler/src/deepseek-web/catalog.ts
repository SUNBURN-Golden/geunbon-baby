import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PangpangProduct } from '../../lib/external/pangpang';
import type { ScopedCategory } from './types';

export type GeunbonProduct = {
  id: string;
  category: ScopedCategory;
  brand: string;
  product_line: string;
  brand_aliases: string[];
  ko_aliases: string[];
  en_aliases: string[];
  search_terms: string[];
};

export type GeunbonCatalog = {
  catalog_version: number;
  notes?: string;
  accessory_exclude_patterns: string[];
  category_rules: { blocked_first_segments: string[]; blocked_leaf_segments: string[] };
  products: GeunbonProduct[];
};

export type CatalogMatch = {
  product_id: string;
  category: ScopedCategory;
  brand: string;
  product_line: string;
  score: number;
};

export type ScopeVerdict =
  | { kind: 'catalog_match'; match: CatalogMatch }
  | { kind: 'accessory_or_broad' }
  | { kind: 'outside_scope' };

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '../../deepseek-web');

export function loadGeunbonCatalog(path = process.env.DEEPSEEK_GEUNBON_CATALOG ?? join(pkgRoot, 'geunbon-catalog.json')): GeunbonCatalog {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GeunbonCatalog;
  if (
    raw.catalog_version !== 2 || !Array.isArray(raw.products) || raw.products.length < 1
    || !raw.category_rules || !Array.isArray(raw.category_rules.blocked_first_segments) || !Array.isArray(raw.category_rules.blocked_leaf_segments)
    || raw.products.some(p => !Array.isArray(p.brand_aliases) || p.brand_aliases.length < 1)
  ) {
    throw new Error('invalid_geunbon_catalog');
  }
  return raw;
}

export function catalogSearchUrls(catalog: GeunbonCatalog): { url: string; product_id: string; category: ScopedCategory; term: string }[] {
  const rows: { url: string; product_id: string; category: ScopedCategory; term: string }[] = [];
  for (const p of catalog.products) {
    for (const term of p.search_terms) {
      rows.push({
        url: `https://09pangpang.com/search/r/${encodeURIComponent(term)}`,
        product_id: p.id,
        category: p.category,
        term,
      });
    }
  }
  return rows;
}

export function nextCatalogSearch(
  catalog: GeunbonCatalog,
  cursor: number,
): { url: string; product_id: string; category: ScopedCategory; term: string; next_cursor: number } | null {
  const rows = catalogSearchUrls(catalog);
  if (!rows.length) return null;
  const idx = ((cursor % rows.length) + rows.length) % rows.length;
  return { ...rows[idx], next_cursor: idx + 1 };
}

export const CATEGORY_ORDER: readonly ScopedCategory[] = ['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer'];

function accessoryHit(blob: string, catalog: GeunbonCatalog) {
  const patterns = catalog.accessory_exclude_patterns;
  return patterns.some(p => blob.includes(p));
}

// Neutral-by-default category gate: only explicitly blocked breadcrumb segments are
// rejected. Neutral parenting labels (유아용품, 육아용품, 유모차/카시트, empty) pass
// through to brand/model matching.
export function categoryScopeBlocked(category_text: string, catalog: GeunbonCatalog): boolean {
  const segments = category_text.normalize('NFKC').split('>').map(s => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  const { blocked_first_segments, blocked_leaf_segments } = catalog.category_rules;
  if (blocked_first_segments.includes(segments[0])) return true;
  if (segments[0] === '키즈') return segments.slice(1).some(s => blocked_leaf_segments.includes(s));
  return segments.length === 1 && blocked_leaf_segments.includes(segments[0]);
}

function scoreProduct(blob: string, p: GeunbonProduct): number {
  let score = 0;
  for (const a of [...p.ko_aliases, ...p.en_aliases]) {
    if (a.length >= 2 && blob.includes(a)) score += a.length >= 4 ? 3 : 2;
  }
  if (p.product_line.length >= 3 && new RegExp(p.product_line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blob)) score += 4;
  return score;
}

export function matchCatalogProduct(product: Pick<PangpangProduct, 'title' | 'category_text' | 'text'>, catalog: GeunbonCatalog): CatalogMatch | null {
  const blob = `${product.title}\n${product.category_text}\n${product.text}`.normalize('NFKC');
  if (accessoryHit(blob, catalog)) return null;
  const lower = blob.toLowerCase();
  let best: CatalogMatch | null = null;
  for (const p of catalog.products) {
    // A catalog mapping requires the brand itself. Generic line words (플레이짐, 믹스…)
    // and brand words inside seller handles (@the_ergo_official) are not brand evidence.
    const brandHits = p.brand_aliases.filter(a => a.length >= 2 && lower.includes(a.toLowerCase()));
    if (!brandHits.length) continue;
    const score = scoreProduct(blob, p) + brandHits.length * 2;
    if (score < 2) continue;
    const m: CatalogMatch = { product_id: p.id, category: p.category, brand: p.brand, product_line: p.product_line, score };
    if (!best || m.score > best.score) best = m;
  }
  return best;
}

export function classifyCatalogScope(product: Pick<PangpangProduct, 'title' | 'category_text' | 'text'>, catalog: GeunbonCatalog): ScopeVerdict {
  if (categoryScopeBlocked(product.category_text, catalog)) return { kind: 'outside_scope' };
  const blob = `${product.title}\n${product.category_text}`;
  if (accessoryHit(blob, catalog)) return { kind: 'accessory_or_broad' };
  // Listing body text embeds seller handles and promo copy; only the card's own
  // title/category may establish a brand, so the body is deliberately dropped.
  const match = matchCatalogProduct({ title: product.title, category_text: product.category_text, text: '' }, catalog);
  if (match) return { kind: 'catalog_match', match };
  return { kind: 'outside_scope' };
}

export function rankListingCandidates(
  products: PangpangProduct[],
  catalog: GeunbonCatalog,
  maxDetail: number,
  _pageUrl: string,
  options?: { categoryCursor?: number; categoryOrder?: readonly ScopedCategory[]; isGone?: (url: string) => boolean },
) {
  const groups: Partial<Record<ScopedCategory, { product: PangpangProduct; match: CatalogMatch }[]>> = {};
  const rollup = { raw: products.length, scoped: 0, accessory_or_broad: 0, outside_scope: 0 };
  const byCategory: Partial<Record<ScopedCategory, number>> = {};
  for (const p of products) {
    const v = classifyCatalogScope(p, catalog);
    if (v.kind === 'accessory_or_broad') rollup.accessory_or_broad++;
    else if (v.kind === 'outside_scope') rollup.outside_scope++;
    else {
      rollup.scoped++;
      byCategory[v.match.category] = (byCategory[v.match.category] ?? 0) + 1;
      if (!options?.isGone?.(p.source_url)) (groups[v.match.category] ??= []).push({ product: p, match: v.match });
    }
  }
  for (const rows of Object.values(groups)) rows.sort((a, b) => b.match.score - a.match.score || a.product.title.localeCompare(b.product.title));
  // Round-robin across categories so one crowded category cannot take every detail slot.
  // Use the configured category order so listing rotation stays aligned with the planner
  // even when `scope_categories` is reordered.
  const order = options?.categoryOrder?.length ? options.categoryOrder : CATEGORY_ORDER;
  const cursor = options?.categoryCursor ?? 0;
  const start = ((cursor % order.length) + order.length) % order.length;
  const enqueue: { url: string; catalog_product_id: string; category: ScopedCategory }[] = [];
  while (enqueue.length < maxDetail) {
    let added = false;
    for (let i = 0; i < order.length && enqueue.length < maxDetail; i++) {
      const next = groups[order[(start + i) % order.length]]?.shift();
      if (next) { enqueue.push({ url: next.product.source_url, catalog_product_id: next.match.product_id, category: next.match.category }); added = true; }
    }
    if (!added) break;
  }
  return { enqueue, rollup, by_category: byCategory };
}

export function searchMetaForUrl(catalog: GeunbonCatalog, url: string): { product_id: string | null; category: ScopedCategory | null; term: string | null } {
  for (const row of catalogSearchUrls(catalog)) {
    if (row.url === url) return { product_id: row.product_id, category: row.category, term: row.term };
  }
  return { product_id: null, category: null, term: null };
}

export function postIdFromUrl(url: string): string | null {
  try {
    const m = /^\/post\/(\d+)\/?$/.exec(new URL(url).pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
