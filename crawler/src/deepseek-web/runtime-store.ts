import { resolve } from 'node:path';
import { CollectorStore } from '../store';
export function openRuntimeCollectorStore(): CollectorStore {
  const file = process.env.COLLECTOR_DB?.trim();
  if (!file) throw new Error('collector_db_required');
  try {
    return new CollectorStore(resolve(file));
  } catch {
    throw new Error('collector_db_unavailable');
  }
}
export function assertDomainPolicyReadable(store: CollectorStore) {
  try {
    store.list<{ stopped?: boolean }>('domain_state');
  } catch {
    throw new Error('domain_state_unavailable');
  }
}
