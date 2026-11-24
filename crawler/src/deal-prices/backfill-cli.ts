import { resolve } from 'node:path';
import { stateDir } from '../deepseek-web/config';
import { openRuntimeCollectorStore } from '../deepseek-web/runtime-store';
import { backfillApi, runPriceBackfill, sourceFetcher } from './backfill';
import { priceProviders, priceVerificationEnabled } from './providers';
import { syncPriceSources } from './source-sync';
import { priceRuntime, priceSourceAuthority } from './runtime';
import { fetchThreadsPost, threadsRegistry } from './threads';

async function main() {
  const endpoint = process.env.AGAMAJUNG_API_URL, token = process.env.ADMIN_TOKEN;
  if (!priceVerificationEnabled() || !endpoint || !token) throw new Error('backfill_not_activated');
  const api = backfillApi(endpoint, token);
  const store = process.env.COLLECTOR_DB ? openRuntimeCollectorStore() : undefined;
  const meter: Record<string, { attempts: number; responses: number; total: number }> = {};
  const complete = priceProviders((model, usage) => {
    const row = meter[model] ??= { attempts: 0, responses: 0, total: 0 };
    row.attempts++;
    if (usage) row.responses++;
    row.total += usage?.total_tokens ?? 0;
  });
  try {
    const scopes = priceSourceAuthority(store).scopes().map(({ scope }) => scope);
    await syncPriceSources(stateDir(), new URL(endpoint), token, scopes, false);
    const runtime = priceRuntime(complete, store);
    const registry = store ? threadsRegistry(store) : null;
    const fetchOffer = sourceFetcher(runtime.publicOffer, async url => {
      if (!registry) return null;
      const result = await fetchThreadsPost(url, registry);
      return result.outcome === 'captured' ? result.text : null;
    });
    const result = await runPriceBackfill({ api, fetchOffer, verify: runtime.verify,
      queue: resolve(stateDir()), dir: resolve(process.env.DEAL_PRICE_BACKFILL_DIR ?? '.local/deal-price-backfill') });
    console.log(JSON.stringify({ ...result, model_usage: meter }, null, 2));
    if (result.totals.retryable) process.exitCode = 1;
  } finally { store?.close(); }
}
main().catch(() => { console.error('price_backfill_unavailable'); process.exitCode = 1; });
