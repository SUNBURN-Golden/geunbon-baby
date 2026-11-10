import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeepSeekWebConfig, ScopedCategory } from './types';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../deepseek-web');
const allowed = new Set<ScopedCategory>(['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer']);
export function loadDeepSeekWebConfig(path = join(root, 'config.json')): DeepSeekWebConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as DeepSeekWebConfig;
  if (raw.profile_id !== 'deepseek-web' || raw.profile_version !== 1) throw new Error('invalid_deepseek_web_config');
  if (!Array.isArray(raw.prohibited_hosts) || raw.prohibited_hosts.length < 1) throw new Error('invalid_deepseek_web_config');
  if (!raw.scope_categories.every(c => allowed.has(c.id))) throw new Error('invalid_deepseek_web_config');
  for (const cap of [raw.budget.max_tokens_per_run, raw.budget.max_requests_per_run, raw.budget.max_completion_tokens, raw.budget.estimated_prompt_tokens]) {
    if (!Number.isInteger(cap) || cap < 0) throw new Error('invalid_deepseek_web_config');
  }
  if (raw.budget.estimated_prompt_tokens + raw.budget.max_completion_tokens > raw.budget.max_tokens_per_run) {
    throw new Error('invalid_deepseek_web_config');
  }
  if (!raw.selection || !Number.isInteger(raw.selection.max_pangpang_detail_per_cycle) || raw.selection.max_pangpang_detail_per_cycle < 0) {
    throw new Error('invalid_deepseek_web_config');
  }
  if (!Number.isInteger(raw.selection.listing_discovery_policy_version) || raw.selection.listing_discovery_policy_version < 1) {
    throw new Error('invalid_deepseek_web_config');
  }
  if (!Number.isInteger(raw.selection.listing_refresh_min_ms) || raw.selection.listing_refresh_min_ms < 0) {
    throw new Error('invalid_deepseek_web_config');
  }
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
