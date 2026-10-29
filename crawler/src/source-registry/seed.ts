import defaults from '../../config/source-registry.json';
import { validateEntry } from './policy';
import type { SourceRegistryEntry } from './types';

// Static migration input, independent of later legacy settings changes.
export function loadRegistrySeed(): SourceRegistryEntry[] {
  const entries=structuredClone(defaults) as SourceRegistryEntry[];
  if(new Set(entries.map(e=>e.source_id)).size!==entries.length)throw new Error('duplicate_registry_source');
  return entries.map(validateEntry);
}
