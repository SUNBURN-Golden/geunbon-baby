import { ExternalFetchError, PoliteFetcher, type BlockInfo, type FetchContext, type FetchFailure } from '../../lib/external/fetch';
import type { DeepSeekWebConfig } from './types';

export type FetchPageResult =
  | { ok: true; text: string; finalUrl: string; status?: number; etag?: string | null; last_modified?: string | null }
  | { ok: false; reason: string; block?: BlockInfo | null; failure?: FetchFailure };

export function createPublicFetcher(config: DeepSeekWebConfig, deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number }, onBlock?: (info: BlockInfo) => void) {
  const now = deps?.now ?? Date.now;
  return new PoliteFetcher(
    { min_interval_ms: config.fetch.min_interval_ms, jitter_ms: config.fetch.jitter_ms, timeout_ms: config.fetch.timeout_ms, max_bytes: config.fetch.max_bytes },
    { fetch: deps?.fetch ?? fetch, sleep: deps?.sleep ?? (ms => new Promise(r => setTimeout(r, ms))), now, random: deps?.random ?? Math.random },
    onBlock,
  );
}
export async function fetchPublicText(fetcher: PoliteFetcher, url: string, options: Pick<FetchContext, 'conditional' | 'beforeRequest' | 'signal'>): Promise<FetchPageResult> {
  const origin = new URL(url).origin;
  fetcher.lastBlock = null;
  try {
    const result = await fetcher.get(url, { ...options, origin, source: 'deepseek-web', allowNotModified: true, reportRobotsFailure: true });
    if (!result) return { ok: false, reason: 'robots_or_policy', block: fetcher.lastBlock };
    return { ok: true, text: result.text, finalUrl: result.url, status: result.status, etag: result.etag, last_modified: result.last_modified };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof ExternalFetchError)) throw error;
    return { ok: false, reason: 'external_fetch_failed', failure: error.failure };
  }
}
