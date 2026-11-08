import { extractPangpang, pangpangIdentityAllowed, pangpangPost, pangpangQueryAllowed } from '../../lib/external/pangpang';
import type { LinkReason } from '../../lib/external/pangpang';
import { canonicalUrl } from '../../../shared/privacy-rules';
import type { DeepSeekWebConfig } from './types';
import { corePublicSearchUrls, scopeRollup } from './deepseek-scope';

export type PangpangListingDiagnosis = {
  kind: 'listing';
  raw_product_count: number;
  parser_outcome_counts: Record<string, number>;
  scope_counts: { core: number; accessory_or_broad: number; outside_scope: number };
  enqueue: string[];
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

export function planPangpangPage(html: string, pageUrl: string, now: Date, config: DeepSeekWebConfig): PangpangPlan {
  const maxDetail = config.selection.max_pangpang_detail_per_cycle;
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
  const page = extractPangpang(html, pageUrl, now, allowed);
  if (page.detail) return { kind: 'detail', productCount: page.products.length };
  const parser_outcome_counts = countOutcomes(page.outcomes);
  const { counts: scope_counts, core } = scopeRollup(page.products, config);
  const enqueue = [...new Set(core.map(p => {
    try { return canonicalUrl(new URL(p.source_url, pageUrl).href); } catch { return p.source_url; }
  }))].slice(0, maxDetail);
  const suggested_searches = corePublicSearchUrls(config);
  let zero_reason: PangpangListingDiagnosis['zero_reason'] = null;
  if (page.products.length === 0) zero_reason = 'parser_empty';
  else if (enqueue.length === 0) zero_reason = 'scope_no_core';
  return {
    kind: 'listing',
    raw_product_count: page.products.length,
    parser_outcome_counts,
    scope_counts,
    enqueue,
    scoped_candidate_count: core.length,
    zero_reason,
    suggested_searches,
  };
}
