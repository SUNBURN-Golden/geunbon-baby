import type { DeepSeekWebConfig, RunMemory } from './types';
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
export function perCallTokenReserve(config: DeepSeekWebConfig) {
  return config.budget.estimated_prompt_tokens + config.budget.max_completion_tokens;
}
export function admitCall(memory: RunMemory, config: DeepSeekWebConfig) {
  if (memory.requests_spent + memory.requests_reserved >= config.budget.max_requests_per_run) {
    return { ok: false as const, reason: 'budget_requests' as const };
  }
  const reserve = perCallTokenReserve(config);
  if (memory.token_spent + memory.tokens_reserved + reserve > config.budget.max_tokens_per_run) {
    return { ok: false as const, reason: 'budget_tokens' as const };
  }
  return { ok: true as const, reserve };
}
export function holdCall(memory: RunMemory, reserve: number) {
  memory.requests_reserved += 1;
  memory.tokens_reserved += reserve;
}
export function releaseCall(memory: RunMemory, reserve: number) {
  memory.requests_reserved = Math.max(0, memory.requests_reserved - 1);
  memory.tokens_reserved = Math.max(0, memory.tokens_reserved - reserve);
}
export function settleCall(memory: RunMemory, reserve: number, usageTokens: number) {
  releaseCall(memory, reserve);
  memory.requests_spent += 1;
  memory.token_spent += usageTokens;
}
/** @deprecated use admitCall; kept for unit tests of hard caps */
export function budgetAllows(memory: RunMemory, config: DeepSeekWebConfig, nextTokens = 0) {
  if (memory.requests_spent + memory.requests_reserved >= config.budget.max_requests_per_run) return { ok: false, reason: 'budget_requests' as const };
  const reserve = nextTokens || perCallTokenReserve(config);
  if (memory.token_spent + memory.tokens_reserved + reserve > config.budget.max_tokens_per_run) {
    return { ok: false, reason: 'budget_tokens' as const };
  }
  return { ok: true as const, reason: null };
}
