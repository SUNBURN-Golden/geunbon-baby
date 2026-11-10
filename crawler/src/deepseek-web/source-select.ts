import { ParseBudget } from '../../lib/external/parse-budget';
import { extractPangpang, pangpangIdentityAllowed, pangpangPost, pangpangQueryAllowed } from '../../lib/external/pangpang';
import type { LinkReason } from '../../lib/external/pangpang';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { catalogSearchUrls, loadGeunbonCatalog, rankListingCandidates } from './catalog';
import type { DeepSeekWebConfig, ScopedCategory } from './types';

export type PangpangListingDiagnosis = {
  kind: 'listing';
  raw_product_count: number;
  parser_outcome_counts: Record<string, number>;
  scope_counts: { core: number; accessory_or_broad: number; outside_scope: number };
  scoped_by_category: Partial<Record<ScopedCategory, number>>;
  enqueue: string[];
  enqueue_catalog: { url: string; catalog_product_id: string; category: ScopedCategory }[];
  scoped_candidate_count: number;
  zero_reason: 'parser_empty' | 'scope_no_core' | null;
  suggested_searches: string[];
};

export type PangpangPlan = PangpangListingDiagnosis | { kind: 'detail'; productCount: number };

export function isPangpangHost(hostname: string) {
  return hostname === '09pangpang.com' || hostname.endsWith('.09pangpang.com');
}

function countOutcomes(outcomes: { reason: LinkReason }[]) {
  return outcomes.reduce<Record<string, number>>((m, o) => {
    m[o.reason] = (m[o.reason] ?? 0) + 1;
    return m;
  }, {});
}

export function planPangpangPage(html: string, pageUrl: string, now: Date, config: DeepSeekWebConfig, options?: { categoryCursor?: number; categoryOrder?: readonly ScopedCategory[] }): PangpangPlan {
  const catalog = loadGeunbonCatalog();
  const listingContext = !pangpangPost(pageUrl);
  const allowed = (url: string) => {
    try {
      const resolved = new URL(url, pageUrl);
      if (resolved.origin !== 'https://09pangpang.com') return false;
      if (!pangpangQueryAllowed(resolved)) return false;
      const abs = resolved.href;
      if (pangpangPost(abs)) return listingContext || pangpangIdentityAllowed(pageUrl, abs);
      const target = canonicalUrl(abs);
      return pangpangIdentityAllowed(pageUrl, target) || canonicalUrl(pageUrl) === target;
    } catch { return false; }
  };
  const page = extractPangpang(html, pageUrl, now, allowed, new ParseBudget());
  if (page.detail) return { kind: 'detail', productCount: page.products.length };
  const parser_outcome_counts = countOutcomes(page.outcomes);
  const ranked = rankListingCandidates(page.products, catalog, config.selection.max_pangpang_detail_per_cycle, pageUrl, { categoryCursor: options?.categoryCursor, categoryOrder: options?.categoryOrder });
  const enqueue_catalog = ranked.enqueue.map(e => ({
    url: (() => { try { return canonicalUrl(new URL(e.url, pageUrl).href); } catch { return e.url; } })(),
    catalog_product_id: e.catalog_product_id,
    category: e.category,
  }));
  const enqueue = enqueue_catalog.map(e => e.url);
  const suggested_searches = [...new Set(catalogSearchUrls(catalog).map(r => r.url))].slice(0, 12);
  let zero_reason: PangpangListingDiagnosis['zero_reason'] = null;
  if (page.products.length === 0) zero_reason = 'parser_empty';
  else if (enqueue.length === 0) zero_reason = 'scope_no_core';
  return {
    kind: 'listing',
    raw_product_count: page.products.length,
    parser_outcome_counts,
    scope_counts: {
      core: ranked.rollup.scoped,
      accessory_or_broad: ranked.rollup.accessory_or_broad,
      outside_scope: ranked.rollup.outside_scope,
    },
    scoped_by_category: ranked.by_category,
    enqueue,
    enqueue_catalog,
    scoped_candidate_count: ranked.rollup.scoped,
    zero_reason,
    suggested_searches,
  };
}
