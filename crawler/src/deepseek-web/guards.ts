import type { DeepSeekWebConfig, RunMemory } from './types';
import type { CollectorStore } from '../store';
export function hostMatchesDenied(hostname: string, denied: string[]) {
  const host = hostname.toLowerCase();
  return denied.some(d => host === d || host.endsWith(`.${d}`));
}
export function isProhibitedUrl(url: string, config: DeepSeekWebConfig) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { blocked: true, reason: 'unsafe_url' as const }; }
  if (parsed.protocol !== 'https:') return { blocked: true, reason: 'unsafe_url' as const };
  if (parsed.username || parsed.password || parsed.port) return { blocked: true, reason: 'unsafe_url' as const };
  if (hostMatchesDenied(parsed.hostname, config.prohibited_hosts)) return { blocked: true, reason: 'prohibited_domain' as const };
  if (/instagram|threads/i.test(parsed.hostname)) return { blocked: true, reason: 'prohibited_domain' as const };
  return { blocked: false as const, reason: null };
}
export function domainStopped(store: CollectorStore | undefined, hostname: string) {
  if (!store) return false;
  const d = store.get<{ stopped?: boolean }>('domain_state', hostname);
  return !!d?.stopped;
}
export function budgetAllows(memory: RunMemory, config: DeepSeekWebConfig, nextTokens = 0) {
  if (memory.requests_spent >= config.budget.max_requests_per_run) return { ok: false, reason: 'budget_requests' as const };
  if (memory.token_spent >= config.budget.max_tokens_per_run || memory.token_spent + nextTokens > config.budget.max_tokens_per_run) {
    return { ok: false, reason: 'budget_tokens' as const };
  }
  return { ok: true as const, reason: null };
}
