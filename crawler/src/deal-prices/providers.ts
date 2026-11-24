import { readFile } from 'node:fs/promises';
import { PRICE_MODELS } from '../../../shared/deal-price-evidence';
import { createDeepSeekClient, readCompletion } from '../deepseek-web/client';
import type { DeepSeekClient } from '../deepseek-web/types';
import { directHttps } from './direct-https';
import type { PriceCompletion, PriceUsage } from './verify';

const qwenEndpoint = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
export const priceVerificationEnabled = () => process.env.DEAL_PRICE_VERIFICATION === '1';

export function qwenClient(fetchImpl: typeof fetch | typeof directHttps = directHttps, readKey = () => readFile('/home/box/.qwen/token_plan_key', 'utf8')): DeepSeekClient {
  return {
    async complete({ system, user, signal }) {
      const key = (await readKey().catch(() => '')).trim();
      if (key.length < 8 || /\s/.test(key)) throw new Error('qwen_key_unavailable');
      const response = await fetchImpl(qwenEndpoint, {
        method: 'POST', redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: PRICE_MODELS[1], messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 8192 }),
      });
      if (response.redirected || !response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error('qwen_http_failed');
      }
      return readCompletion(response, PRICE_MODELS[1]);
    },
  };
}

export function priceProviders(account: PriceUsage, fetchImpl?: typeof fetch): PriceCompletion {
  const qwen = qwenClient(fetchImpl);
  return async (index, input) => {
    const model = PRICE_MODELS[index];
    let response;
    try {
      const client = index ? qwen : createDeepSeekClient({
        apiKey: process.env.DEEPSEEK_API_KEY ?? '', model, maxCompletionTokens: 8192, fetchImpl,
      });
      response = await client.complete(input);
      return response;
    } finally {
      account(model, response?.usage ?? null);
    }
  };
}
