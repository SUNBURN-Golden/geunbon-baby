import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeepSeekClient, DeepSeekUsage } from './types';
export type ClientOptions = { apiKey: string; model: string; maxCompletionTokens: number; baseUrl?: string; fetchImpl?: typeof fetch; fixturePath?: string };
function usageFrom(data: { usage?: Partial<DeepSeekUsage> }, fallback = 0): DeepSeekUsage {
  const u = data.usage ?? {};
  const prompt = Number(u.prompt_tokens ?? fallback);
  const completion = Number(u.completion_tokens ?? fallback);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(u.total_tokens ?? prompt + completion) };
}
export function createDeepSeekClient(options: ClientOptions): DeepSeekClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? 'https://api.deepseek.com';
  if (options.apiKey === 'mock' || options.fixturePath) {
    return {
      async complete({ system, user }) {
        void system; void user;
        const fixture = options.fixturePath ?? join(process.cwd(), 'tests/fixtures/deepseek-web/mock-completion.json');
        const body = JSON.parse(await readFile(fixture, 'utf8')) as { content: string; usage?: DeepSeekUsage; model?: string };
        return { content: body.content, usage: usageFrom(body), model: body.model ?? options.model };
      },
    };
  }
  if (!options.apiKey || options.apiKey.length < 8) throw new Error('deepseek_api_key_missing');
  return {
    async complete({ system, user }) {
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxCompletionTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) throw new Error(`deepseek_http_${response.status}`);
      const data = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: DeepSeekUsage; model?: string };
      const content = data.choices?.[0]?.message?.content;
      if (!content?.trim()) throw new Error('deepseek_empty');
      return { content, usage: usageFrom(data), model: data.model ?? options.model };
    },
  };
}
