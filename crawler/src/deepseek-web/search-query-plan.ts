import { catalogSearchUrls, loadGeunbonCatalog, nextCatalogSearch } from './catalog';
import type { DeepSeekWebConfig, RunMemory } from './types';
import { isPangpangListingUrl } from './listing-discovery';

export function rememberSearchHints(memory: RunMemory, hints: string[]) {
  memory.next_search_hints = [...new Set(hints)].slice(0, catalogSearchUrls(loadGeunbonCatalog()).length);
}

export function pickNextPublicSearchUrl(memory: RunMemory, _config: DeepSeekWebConfig): string | null {
  const catalog = loadGeunbonCatalog();
  const picked = nextCatalogSearch(catalog, memory.catalog_search_cursor ?? 0);
  if (!picked) return null;
  if (!isPangpangListingUrl(picked.url)) return null;
  if (memory.pending_urls.includes(picked.url)) return null;
  memory.catalog_search_cursor = picked.next_cursor;
  memory.last_catalog_search = {
    product_id: picked.product_id,
    category: picked.category,
    term: picked.term,
    url: picked.url,
  };
  return picked.url;
}
