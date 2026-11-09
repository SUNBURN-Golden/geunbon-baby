import { loadGeunbonCatalog, catalogSearchUrls, classifyCatalogScope, rankListingCandidates, type GeunbonCatalog } from './catalog';
import type { PangpangProduct } from '../../lib/external/pangpang';
import type { DeepSeekWebConfig } from './types';

export { classifyCatalogScope as classifyCoreScope, rankListingCandidates, loadGeunbonCatalog, catalogSearchUrls };
export type CoreScopeVerdict = ReturnType<typeof classifyCatalogScope> extends infer T ? T : never;

export function corePublicSearchUrls(_config: DeepSeekWebConfig, limit = 12, catalog: GeunbonCatalog = loadGeunbonCatalog()) {
  return catalogSearchUrls(catalog).slice(0, limit).map(r => r.url);
}

export function scopeRollup(products: PangpangProduct[], catalog: GeunbonCatalog = loadGeunbonCatalog()) {
  const ranked = rankListingCandidates(products, catalog, products.length, '');
  return {
    counts: {
      core: ranked.rollup.scoped,
      accessory_or_broad: ranked.rollup.accessory_or_broad,
      outside_scope: ranked.rollup.outside_scope,
    },
    core: products.filter(p => {
      const v = classifyCatalogScope(p, catalog);
      return v.kind === 'catalog_match';
    }),
    by_category: ranked.by_category,
  };
}
