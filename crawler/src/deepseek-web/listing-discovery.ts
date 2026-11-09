import { pangpangPost } from '../../lib/external/pangpang';
import type { DeepSeekWebConfig, RunMemory } from './types';
import { isPangpangHost } from './source-select';

export type ListingDiscoveryRecord = {
  policy_version: number;
  last_at: string;
  last_enqueue_count: number;
};

export function isPangpangListingUrl(url: string) {
  try {
    const host = new URL(url).hostname;
    return isPangpangHost(host) && !pangpangPost(url);
  } catch {
    return false;
  }
}

export function listingPolicyVersion(config: DeepSeekWebConfig) {
  return config.selection.listing_discovery_policy_version;
}

export function listingRefreshMinMs(config: DeepSeekWebConfig) {
  return config.selection.listing_refresh_min_ms;
}

/** Migration or policy bump: never recorded at current policy, or older policy version. */
export function listingDiscoveryDue(memory: RunMemory, url: string, config: DeepSeekWebConfig, now = Date.now()) {
  if (!isPangpangListingUrl(url)) return false;
  const version = listingPolicyVersion(config);
  const rec = memory.listing_discovery?.[url];
  if (!rec || rec.policy_version < version) return true;
  if (memory.pending_urls.length > 0) return false;
  return now - Date.parse(rec.last_at) >= listingRefreshMinMs(config);
}

/** Skip entire work item (no fetch, no model). */
export function shouldDedupObservedSeed(memory: RunMemory, url: string, config: DeepSeekWebConfig, now = Date.now()) {
  if (!memory.observed_urls.includes(url)) return false;
  if (memory.pending_urls.includes(url)) return false;
  if (listingDiscoveryDue(memory, url, config, now)) return false;
  return true;
}

export function recordListingDiscovery(memory: RunMemory, url: string, config: DeepSeekWebConfig, enqueueCount: number, now = new Date()) {
  if (!memory.listing_discovery) memory.listing_discovery = {};
  memory.listing_discovery[url] = {
    policy_version: listingPolicyVersion(config),
    last_at: now.toISOString(),
    last_enqueue_count: enqueueCount,
  };
}
