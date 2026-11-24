import { health } from '../../lib/health';
import { openRuntimeCollectorStore } from '../deepseek-web/runtime-store';
import { priceProviders, priceVerificationEnabled } from './providers';
import { priceRuntime } from './runtime';
import type { PriceCompletion } from './verify';

// Per-post request budget owned by the Instagram collector. Provider calls and
// official-page fetches (including redirects and robots) are charged here so
// price verification cannot exceed the hourly caps in settings.json.
export type PriceBudget = { provider: () => boolean; fetch: () => boolean };

export async function instagramPriceEvidence(source: string, text: string, at: string, budget?: PriceBudget) {
  if (!priceVerificationEnabled()) return undefined;
  // The Instagram process keeps its existing session and browser ownership.
  const store = process.env.COLLECTOR_DB ? openRuntimeCollectorStore() : undefined;
  try {
    const providers = priceProviders((model, usage) => health('price_model_call', {
      model, units: usage?.total_tokens ?? null, response: usage !== null,
    }));
    const complete: PriceCompletion = async (index, input) => {
      if (budget && !budget.provider()) throw new Error('price_budget_exhausted');
      return providers(index, input);
    };
    return await priceRuntime(complete, store, undefined, undefined, {
      beforeRequest: () => { if (budget && !budget.fetch()) throw new Error('price_budget_exhausted'); },
    }).verify(source, text, at);
  } finally { store?.close(); }
}
