import { stateDir } from '../deepseek-web/config';
import { openRuntimeCollectorStore } from '../deepseek-web/runtime-store';
import { priceSourceAuthority } from './runtime';
import { syncPriceSources } from './source-sync';

async function main() {
  const endpoint = new URL(process.env.AGAMAJUNG_API_URL ?? '');
  const token = process.env.ADMIN_TOKEN ?? '';
  const store = openRuntimeCollectorStore();
  try {
    const authority = priceSourceAuthority(store);
    const receipt = await syncPriceSources(stateDir(), endpoint, token, authority.scopes().map(({ scope }) => scope), true);
    console.log(JSON.stringify({ ...receipt, uncovered: authority.uncovered() }));
  } finally { store.close(); }
}
main().catch(() => { console.error('price_sources_sync_failed'); process.exitCode = 1; });
