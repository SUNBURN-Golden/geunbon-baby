import type { CycleBudget, DeepSeekWebConfig } from './types';
export function hostMatchesDenied(hostname: string, denied: string[]) {
  const host = hostname.toLowerCase();
  return denied.some(d => host === d || host.endsWith(`.${d}`));
}
export function isProhibitedUrl(url: string, _config: DeepSeekWebConfig) {
  void _config;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { blocked: true, reason: 'unsafe_url' as const }; }
  if (parsed.protocol !== 'https:') return { blocked: true, reason: 'unsafe_url' as const };
  if (parsed.username || parsed.password || parsed.port) return { blocked: true, reason: 'unsafe_url' as const };
  if (/instagram|threads/i.test(parsed.hostname)) return { blocked: true, reason: 'prohibited_domain' as const };
  return { blocked: false as const, reason: null };
}
export function perCallTokenReserve(config: DeepSeekWebConfig) {
  return config.budget.estimated_prompt_tokens + config.budget.max_completion_tokens;
}
export function admitCall(budget: CycleBudget, config: DeepSeekWebConfig) {
  if (budget.requests_spent + budget.requests_reserved >= config.budget.max_requests_per_run) {
    return { ok: false as const, reason: 'budget_requests' as const };
  }
  const reserve = perCallTokenReserve(config);
  if (budget.token_spent + budget.tokens_reserved + reserve > config.budget.max_tokens_per_run) {
    return { ok: false as const, reason: 'budget_tokens' as const };
  }
  return { ok: true as const, reserve };
}
export function holdCall(budget: CycleBudget, reserve: number) {
  budget.requests_reserved += 1;
  budget.tokens_reserved += reserve;
}
export function releaseCall(budget: CycleBudget, reserve: number) {
  budget.requests_reserved = Math.max(0, budget.requests_reserved - 1);
  budget.tokens_reserved = Math.max(0, budget.tokens_reserved - reserve);
}
export function settleCall(budget: CycleBudget, reserve: number, usageTokens: number) {
  releaseCall(budget, reserve);
  budget.requests_spent += 1;
  budget.token_spent += usageTokens;
}
export function budgetAllows(budget: CycleBudget, config: DeepSeekWebConfig, nextTokens = 0) {
  if (budget.requests_spent + budget.requests_reserved >= config.budget.max_requests_per_run) return { ok: false, reason: 'budget_requests' as const };
  const reserve = nextTokens || perCallTokenReserve(config);
  if (budget.token_spent + budget.tokens_reserved + reserve > config.budget.max_tokens_per_run) {
    return { ok: false, reason: 'budget_tokens' as const };
  }
  return { ok: true as const, reason: null };
}
