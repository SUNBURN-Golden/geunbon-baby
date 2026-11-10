import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeepSeekClient, DeepSeekUsage } from './types';
export type ClientOptions = { apiKey: string; model: string; maxCompletionTokens: number; baseUrl?: string; fetchImpl?: typeof fetch; fixturePath?: string };
export class DeepSeekHttpError extends Error {
  readonly reason: string;
  constructor(readonly status: number) {
    const reason = status === 402 ? 'deepseek_insufficient_balance' : status === 429 ? 'deepseek_rate_limited' : 'deepseek_http_failed';
    super(reason);
    this.reason = reason;
  }
}
export function usageFrom(data: { usage?: Partial<DeepSeekUsage> }): DeepSeekUsage {
  const valid = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  const u = data.usage ?? {};
  const prompt = valid(u.prompt_tokens), completion = valid(u.completion_tokens), reported = valid(u.total_tokens);
  const derived = prompt !== null && completion !== null ? valid(prompt + completion) : null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: reported ?? derived, total_source: reported !== null ? u.total_source === 'derived' && derived === reported ? 'derived' : 'reported' : derived !== null ? 'derived' : 'unknown' };
}
export function createDeepSeekClient(options: ClientOptions): DeepSeekClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? 'https://api.deepseek.com';
  if (options.apiKey === 'mock' || options.fixturePath) {
    return {
      async complete({ system, user, signal }) {
        void system; void user; void signal;
        const fixture = options.fixturePath ?? join(process.cwd(), 'tests/fixtures/deepseek-web/mock-completion.json');
        const body = JSON.parse(await readFile(fixture, 'utf8')) as { content: string; usage?: DeepSeekUsage; model?: string };
        return { content: body.content, usage: usageFrom(body), model: body.model ?? options.model };
      },
    };
  }
  if (!options.apiKey || options.apiKey.length < 8) throw new Error('deepseek_api_key_missing');
  return {
    async complete({ system, user, signal }) {
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]),
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxCompletionTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new DeepSeekHttpError(response.status);
      }
      const data = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: DeepSeekUsage; model?: string };
      const content = data.choices?.[0]?.message?.content;
      // A successful HTTP completion settles accounting even if content is unusable.
      if (typeof content !== 'string') return { content: '', usage: usageFrom(data), model: options.model };
      return { content, usage: usageFrom(data), model: data.model ?? options.model };
    },
  };
}
