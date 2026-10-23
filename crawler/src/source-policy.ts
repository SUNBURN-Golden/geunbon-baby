import defaults from '../config/collector.json';
import { canonicalUrl } from '../../shared/privacy-rules';
import { isHardBlockedPath, isDeniedHost } from '../lib/external/robots';
import { FACT_FIELDS, type FactField, type SourceKind } from '../../shared/collection-schema';
export type SourcePolicy = { id: string; origin: string; brand: string; kind: SourceKind; paths: string[]; query_keys: string[]; entries: string[]; adapter: 'rss'|'sitemap'|'links'|'cpsc'; browser: boolean; selector: string; official_fields: FactField[]; full_text_allowed: boolean; permission_basis?: string; recheck_ms: number; max_pages: number; enabled: boolean };
export type CollectorConfig = Omit<typeof defaults, 'sources'> & { sources: SourcePolicy[] };
export const config = defaults as CollectorConfig;
export function validateConfig(c: CollectorConfig): CollectorConfig {
  c.limits.failure_backoff_ms ??= 300000;
  if (![c.reservation_ms,c.execution_ms,c.submission_grace_ms,c.policy_version].every(n=>Number.isSafeInteger(n)&&n>0) || !/^[\w-]{1,80}$/.test(c.worker_id) || c.policy_version < 1 || c.limits.discovered > 500 || c.limits.new_body > 200 || c.limits.recheck > 200 || c.limits.min_interval_ms < 5000 || c.limits.max_depth > 2 || c.limits.max_bytes > 2097152 || Object.values(c.limits).some(n=>!Number.isSafeInteger(n)||n<1)) throw new Error('invalid_config');
  for (const s of c.sources) {
    if (!/^[\w-]{1,80}$/.test(s.id)||!/^[\w-]{1,80}$/.test(s.brand)||!['rss','sitemap','links','cpsc'].includes(s.adapter)||!Number.isSafeInteger(s.max_pages)||s.max_pages<1||!Number.isSafeInteger(s.recheck_ms)||s.recheck_ms<1||!s.official_fields.every(f=>FACT_FIELDS.includes(f))||new URL(s.origin).protocol!=='https:'||new URL(s.origin).origin !== s.origin || isDeniedHost(new URL(s.origin).hostname) || !s.paths.length || (s.browser && !s.selector) || (s.full_text_allowed && !s.permission_basis) || !s.entries.every(e=>visitAllowed(e,s))) throw new Error('invalid_source');
  }
  if(new Set(c.sources.map(s=>s.id)).size!==c.sources.length)throw new Error('duplicate_source');
  return c;
}
export function visitAllowed(raw: string, source: SourcePolicy): boolean {
  try {
    const u = new URL(raw); canonicalUrl(raw);
    return u.origin === source.origin && !isHardBlockedPath(u.pathname) && source.paths.some(p=>u.pathname===p || (p.endsWith('/')&&u.pathname.startsWith(p))) && [...u.searchParams.keys()].every(k=>source.query_keys.includes(k)) && !/\/(calendar|search)\//i.test(u.pathname) && ![...u.searchParams].some(([k,v])=> /^(page|p)$/i.test(k)&&(!/^\d+$/.test(v)||+v>source.max_pages));
  } catch { return false; }
}
export function sourceFor(url: string, c = config) { return c.sources.find(s=>visitAllowed(url,s)); }
