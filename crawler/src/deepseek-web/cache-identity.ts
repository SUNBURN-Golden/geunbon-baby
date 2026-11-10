/** Read-only identity helpers shared with queue validation; no cache/store initialization. */
import { createHash } from 'node:crypto';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const codepoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => codepoint(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const cacheKey = (url: string, content: string, contract: string) => sha256(stableSerialize([url, content, contract]));
