import { readFileSync } from 'node:fs';
import { PRICE_MODELS } from '../../../shared/deal-price-evidence';
import { providerModel } from '../../../shared/verified-offer';

export type Limit = number | null;
export type Budget = { calls: Limit; tokens: Limit; cost: Limit };
export const budgetScopes = ['run', 'cycle', 'day', 'cumulative'] as const;
export type BudgetScope = typeof budgetScopes[number];
export type ProviderName = 'extraction' | 'verification';
type Profile = { endpoint: string; model: string; max_output_tokens: number; estimated_input_tokens: number; budget: Record<BudgetScope, Budget>;
  rates?: { currency: string; basis: string; input_per_million: number; output_per_million: number } };
type Limits = { max_pages: Limit; max_depth: Limit; max_queue_urls: Limit; max_details_per_cycle: Limit };
export type OfferConfig = {
  idle_tick_ms: number; limits: Limits; source_limits: Record<string, Partial<Limits>>; providers: Record<ProviderName, Profile>;
  seed_urls: string[]; press: Record<string, { interval_ms: number }>;
};
const limits = ['max_pages', 'max_depth', 'max_queue_urls', 'max_details_per_cycle'] as const;
const unlimited = () => ({ calls: null, tokens: null, cost: null });
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const invalid = (): never => { throw new Error('invalid_offer_config'); };
export function configuredLimit(value: unknown, money = false): Limit {
  if (value === undefined || value === null) return null;
  if (money ? typeof value === 'number' && Number.isFinite(value) && value >= 0 : integer(value)) return value as number;
  return invalid();
}
export function parseOfferConfig(raw: Partial<OfferConfig>): OfferConfig {
  if (!raw || typeof raw !== 'object' || !raw.providers) return invalid();
  const profiles = {} as OfferConfig['providers'];
  for (const name of ['extraction', 'verification'] as const) {
    const profile = raw.providers[name];
    if (!profile || profile.model !== PRICE_MODELS[name === 'extraction' ? 0 : 1] || !integer(profile.max_output_tokens, 1) || !integer(profile.estimated_input_tokens, 1)) return invalid();
    const endpoint = new URL(profile.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.hash || endpoint.search || !endpoint.pathname.endsWith('/chat/completions')) return invalid();
    const budget = {} as Profile['budget'];
    for (const scope of budgetScopes) {
      const cap = profile.budget?.[scope] ?? unlimited();
      budget[scope] = { calls: configuredLimit(cap.calls), tokens: configuredLimit(cap.tokens), cost: configuredLimit(cap.cost, true) };
    }
    if (profile.rates && (!/^[A-Z]{3}$/.test(profile.rates.currency) || !providerModel(profile.rates.basis)
      || configuredLimit(profile.rates.input_per_million, true) === null || configuredLimit(profile.rates.output_per_million, true) === null)) return invalid();
    profiles[name] = { ...profile, budget };
  }
  if (profiles.extraction.model === profiles.verification.model) return invalid();
  const common = Object.fromEntries(limits.map(name => [name, configuredLimit(raw.limits?.[name])])) as Limits;
  for (const override of Object.values(raw.source_limits ?? {})) for (const name of limits)
    if (Object.hasOwn(override, name)) configuredLimit(override[name]);
  for (const interval of Object.values(raw.press ?? {})) if (!integer(interval.interval_ms)) return invalid();
  if (!Array.isArray(raw.seed_urls) || !raw.seed_urls.every(url => typeof url === 'string')) return invalid();
  if (raw.idle_tick_ms !== undefined && !integer(raw.idle_tick_ms, 1)) return invalid();
  return { idle_tick_ms: raw.idle_tick_ms ?? 1000, limits: common, source_limits: raw.source_limits ?? {}, providers: profiles, seed_urls: raw.seed_urls, press: raw.press ?? {} };
}
export function offerConfig() {
  const raw = JSON.parse(readFileSync(new URL('../../deepseek-web/offers.json', import.meta.url), 'utf8')) as OfferConfig;
  for (const [name, model, endpoint] of [
    ['extraction', process.env.DEEPSEEK_MODEL, process.env.DEEPSEEK_OFFER_ENDPOINT],
    ['verification', process.env.QWEN_MODEL, process.env.QWEN_OFFER_ENDPOINT],
  ] as const) {
    if (model) raw.providers[name].model = model;
    if (endpoint) raw.providers[name].endpoint = endpoint;
  }
  return parseOfferConfig(raw);
}
export const sourceLimits = (config: OfferConfig, source: string): Limits => Object.fromEntries(limits.map(name => [
  name, Object.hasOwn(config.source_limits[source] ?? {}, name) ? configuredLimit(config.source_limits[source][name]) : config.limits[name],
])) as Limits;
