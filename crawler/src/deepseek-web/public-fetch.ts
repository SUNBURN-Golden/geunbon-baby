import { PoliteFetcher, type BlockInfo, type ConditionalRequest } from '../../lib/external/fetch';
import type { DeepSeekWebConfig } from './types';
export function createPublicFetcher(config: DeepSeekWebConfig, deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number }, onBlock?: (info: BlockInfo) => void) {
  const now = deps?.now ?? Date.now;
  return new PoliteFetcher(
    { min_interval_ms: config.fetch.min_interval_ms, jitter_ms: config.fetch.jitter_ms, timeout_ms: config.fetch.timeout_ms, max_bytes: config.fetch.max_bytes },
    { fetch: deps?.fetch ?? fetch, sleep: deps?.sleep ?? (ms => new Promise(r => setTimeout(r, ms))), now, random: deps?.random ?? Math.random },
    onBlock,
  );
}
export async function fetchPublicText(fetcher: PoliteFetcher, url: string, conditional?: ConditionalRequest, beforeRequest?: (url: string) => void) {
  const origin = new URL(url).origin;
  const result = await fetcher.get(url, { origin, source: 'deepseek-web', conditional, allowNotModified: true, beforeRequest });
  if (!result) return { ok: false as const, reason: 'robots_or_policy' as const, block: fetcher.lastBlock };
  return { ok: true as const, text: result.text, finalUrl: result.url, status: result.status, etag: result.etag, last_modified: result.last_modified };
}
