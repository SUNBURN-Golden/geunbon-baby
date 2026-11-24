import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACT_FIELDS } from '../../../shared/collection-schema';
import { isPriceVariant } from '../../../shared/deal-price-evidence';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { loadRegistrySeed } from '../source-registry/seed';
import { registryUrl, staticEntryReason } from '../source-registry/policy';
import type { SourceRegistryEntry } from '../source-registry/types';
import { isProhibitedUrl } from './guards';
import type { DeepSeekWebConfig, OfficialSourceConfig, ScopedCategory } from './types';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../deepseek-web');
const allowed = new Set<ScopedCategory>(['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer']);
const HARD_FORBIDDEN = /(?:^|\.)(?:instagram\.com|threads\.net|threads\.com|facebook\.com|momcalendar\.com)$/i;
const SOURCE_ID = /^[\w-]{1,80}$/;
const BRAND = /^[\p{L}\p{N} .&+_-]{1,80}$/u;
const MIN_OFFICIAL_RECHECK_MS = 3600000;

function invalid(): never {
  throw new Error('invalid_deepseek_web_config');
}

function validateOfficialSources(raw: DeepSeekWebConfig): OfficialSourceConfig[] {
  const sources = raw.official_sources ?? [];
  if (!Array.isArray(sources)) invalid();
  const seed = new Map<string, SourceRegistryEntry>(loadRegistrySeed().map(e => [e.source_id, e]));
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== 'object') invalid();
    if (!SOURCE_ID.test(source.id) || ids.has(source.id)) invalid();
    if (typeof source.brand !== 'string' || !BRAND.test(source.brand)) invalid();
    if (!allowed.has(source.category)) invalid();
    if (typeof source.enabled !== 'boolean') invalid();
    if (source.price_model !== undefined && (typeof source.price_model !== 'string' || !source.price_model.trim() ||
        source.price_model.length > 100 || !source.fields.includes('official_msrp'))) invalid();
    if (source.price_variants !== undefined && (!Array.isArray(source.price_variants) || !source.price_variants.length ||
        !source.price_variants.every(variant => isPriceVariant({ ...variant, brand_aliases: [], model_aliases: [] })) ||
        new Set(source.price_variants.map(variant => variant.id)).size !== source.price_variants.length ||
        !source.fields?.includes('official_msrp'))) invalid();
    if (!Array.isArray(source.fields) || source.fields.length < 1 || new Set(source.fields).size !== source.fields.length) invalid();
    if (source.fields.some(f => typeof f !== 'string' || !(FACT_FIELDS as readonly string[]).includes(f))) invalid();
    const recheck = source.recheck_ms ?? raw.selection.official_recheck_ms;
    // The per-source override must respect the same floor as the global default.
    if (!Number.isSafeInteger(recheck) || recheck < MIN_OFFICIAL_RECHECK_MS) invalid();
    if (typeof source.url !== 'string' || source.url.length > 2048) invalid();
    let parsed: URL;
    try { parsed = new URL(source.url); } catch { invalid(); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) invalid();
    if (HARD_FORBIDDEN.test(parsed.hostname) || isProhibitedUrl(source.url, raw).blocked) invalid();
    const entry = seed.get(source.registry_id);
    if (!entry) invalid();
    let registryTarget: URL;
    try { registryTarget = registryUrl(source.url); } catch { invalid(); }
    if (registryTarget.origin !== entry.origin) invalid();
    if (staticEntryReason(entry, registryTarget, source.fields) !== undefined) invalid();
    if (source.fields.some(f => !entry.collectable_fields.includes(f as typeof FACT_FIELDS[number]))) invalid();
    try { canonicalUrl(source.url); } catch { invalid(); }
    if (urls.has(source.url)) invalid();
    ids.add(source.id);
    urls.add(source.url);
  }
  return sources;
}

export function loadDeepSeekWebConfig(path = join(root, 'config.json')): DeepSeekWebConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as DeepSeekWebConfig;
  if (raw.profile_id !== 'deepseek-web' || raw.profile_version !== 1) invalid();
  if (!Array.isArray(raw.prohibited_hosts) || raw.prohibited_hosts.length < 1) invalid();
  if (!raw.scope_categories.every(c => allowed.has(c.id))) invalid();
  for (const cap of [raw.budget.max_tokens_per_run, raw.budget.max_requests_per_run, raw.budget.max_completion_tokens, raw.budget.estimated_prompt_tokens]) {
    if (!Number.isInteger(cap) || cap < 0) invalid();
  }
  if (raw.budget.estimated_prompt_tokens + raw.budget.max_completion_tokens > raw.budget.max_tokens_per_run) invalid();
  if (!raw.selection || !Number.isInteger(raw.selection.max_pangpang_detail_per_cycle) || raw.selection.max_pangpang_detail_per_cycle < 0) invalid();
  if (!Number.isInteger(raw.selection.listing_discovery_policy_version) || raw.selection.listing_discovery_policy_version < 1) invalid();
  if (!Number.isInteger(raw.selection.listing_refresh_min_ms) || raw.selection.listing_refresh_min_ms < 0) invalid();
  const maxPages = raw.selection.max_pages_per_cycle ?? Math.min(raw.budget.max_requests_per_run, raw.memory.max_queue_urls);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > raw.memory.max_queue_urls) invalid();
  const quota = raw.selection.category_quota_per_cycle ?? 1;
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > maxPages) invalid();
  const legacyBudget = raw.selection.legacy_budget_per_cycle ?? Math.min(1, maxPages - 1);
  if (!Number.isSafeInteger(legacyBudget) || legacyBudget < 0 || legacyBudget > maxPages - 1) invalid();
  const officialRecheck = raw.selection.official_recheck_ms ?? 21600000;
  if (!Number.isSafeInteger(officialRecheck) || officialRecheck < MIN_OFFICIAL_RECHECK_MS) invalid();
  raw.selection.max_pages_per_cycle = maxPages;
  raw.selection.category_quota_per_cycle = quota;
  raw.selection.legacy_budget_per_cycle = legacyBudget;
  raw.selection.official_recheck_ms = officialRecheck;
  raw.official_sources = validateOfficialSources(raw);
  return raw;
}
export function stateDir() {
  return process.env.DEEPSEEK_WEB_STATE_DIR ?? join(process.cwd(), '.local/deepseek-web');
}

export const DEFAULT_INTERVAL_MS = 600000;
export function cycleInterval(value = process.env.DEEPSEEK_WEB_DAEMON_MS): number {
  const interval = value === undefined ? DEFAULT_INTERVAL_MS : Number(value);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 86400000) throw new Error('invalid_cycle_interval');
  return interval;
}

/** No legacy model name is assumed to be Flash. Operators register verified aliases. */
export function modelProfile(config: DeepSeekWebConfig, selector = process.env.DEEPSEEK_MODEL ?? config.model.default_model) {
  const profiles = config.model?.profiles;
  const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(v);
  if (config.model?.provider !== 'deepseek' || !Array.isArray(profiles) || profiles.length < 1 || profiles.some(p => !p || !id(p.id) || !id(p.provider_model) || !Array.isArray(p.aliases) || !p.aliases.every(id) || p.thinking?.type !== 'disabled' || p.max_completion_tokens !== config.budget.max_completion_tokens)) throw new Error('deepseek_model_profile_unverified');
  const matches = profiles.filter(p => p.id === selector || p.provider_model === selector || p.aliases.includes(selector));
  const p = matches[0];
  if (matches.length !== 1 || !p) throw new Error('deepseek_model_profile_unverified');
  return Object.freeze({ ...p, thinking: Object.freeze({ type: 'disabled' as const }) });
}
