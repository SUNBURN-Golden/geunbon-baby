import type { FactField } from '../../../shared/collection-schema';
import type { SourcePolicy } from '../source-policy';
import type { SourceRegistryEntry, RegistryDecision } from '../source-registry/types';
import type { SourceRegistryStore } from '../source-registry/store';
import type { DeepSeekWebConfig, OfficialSourceConfig, RotationState, ScopedCategory } from './types';

export function enabledOfficialSources(config: DeepSeekWebConfig): OfficialSourceConfig[] {
  return (config.official_sources ?? []).filter(source => source.enabled);
}

export function effectiveRecheckMs(source: OfficialSourceConfig, config: DeepSeekWebConfig): number {
  return source.recheck_ms ?? config.selection.official_recheck_ms;
}

export function officialDue(rotation: RotationState, source: OfficialSourceConfig, now: number): boolean {
  const visit = rotation.official_visits[source.id];
  if (!visit) return true;
  return Date.parse(visit.next_due_at) <= now;
}

/** Read-only registry gate. This function never approves, seeds or mutates authority. */
export function admitOfficial(registry: SourceRegistryStore, source: OfficialSourceConfig): RegistryDecision {
  return registry.decide(source.registry_id, source.url, source.fields);
}

function slug(origin: string): string {
  return origin.replace(/^https:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

/**
 * Legacy `SourcePolicy` adapters required by `decide()`'s legacy intersection.
 * They exist only in memory for the DeepSeek runner: they are not added to
 * crawler/config/collector.json, persisted, or used to grant authority.
 */
export function officialLegacySources(config: DeepSeekWebConfig, registrySeed: readonly SourceRegistryEntry[]): SourcePolicy[] {
  const entries = new Map(registrySeed.map(entry => [entry.source_id, entry]));
  const groups = new Map<string, { entry: SourceRegistryEntry; sources: OfficialSourceConfig[] }>();
  for (const source of enabledOfficialSources(config)) {
    const entry = entries.get(source.registry_id);
    if (!entry?.origin) continue;
    const group = groups.get(entry.origin) ?? { entry, sources: [] };
    group.sources.push(source);
    groups.set(entry.origin, group);
  }
  return [...groups.values()].map(({ entry, sources }) => {
    const officialFields = [...new Set(sources.flatMap(source => source.fields))] as FactField[];
    return {
      id: `deepseek-official-${slug(entry.origin!)}`,
      origin: entry.origin!,
      brand: sources[0].brand,
      kind: 'manufacturer',
      paths: [...entry.allowed_path_prefixes],
      query_keys: [...entry.query_keys],
      entries: sources.map(source => source.url),
      adapter: 'links',
      browser: false,
      selector: '',
      official_fields: officialFields,
      full_text_allowed: false,
      recheck_ms: Math.min(...sources.map(source => effectiveRecheckMs(source, config))),
      max_pages: 1,
      enabled: true,
    };
  });
}

export function officialCandidatesByCategory(sources: readonly OfficialSourceConfig[]): Record<ScopedCategory, OfficialSourceConfig[]> {
  const out = {} as Record<ScopedCategory, OfficialSourceConfig[]>;
  for (const source of sources) (out[source.category] ??= []).push(source);
  return out;
}
