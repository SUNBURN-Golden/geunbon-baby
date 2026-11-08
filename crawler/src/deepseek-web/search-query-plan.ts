import type { DeepSeekWebConfig, RunMemory } from './types';
import { corePublicSearchUrls } from './deepseek-scope';
import { isPangpangListingUrl } from './listing-discovery';

export function rememberSearchHints(memory: RunMemory, hints: string[]) {
  memory.next_search_hints = [...new Set(hints)].slice(0, 12);
}

export function pickNextPublicSearchUrl(memory: RunMemory, config: DeepSeekWebConfig): string | null {
  const hints = memory.next_search_hints?.length ? memory.next_search_hints : corePublicSearchUrls(config);
  for (const url of hints) {
    if (!isPangpangListingUrl(url)) continue;
    if (memory.pending_urls.includes(url)) continue;
    if (memory.observed_urls.includes(url) && memory.listing_discovery?.[url]) continue;
    return url;
  }
  return null;
}
