import { openRuntimeCollectorStore } from '../deepseek-web/runtime-store';
import { sourceLane } from '../offers/transport';
import { enqueueSource } from '../offers/frontier';
import { offerConfig } from '../offers/config';
import { offerUrl } from '../../../shared/verified-offer';

async function main() {
  const [, , mode, permalink] = process.argv;
  if ((mode !== 'check' && mode !== 'collect') || !permalink || process.argv.length !== 4) throw new Error('threads_arguments');
  const store = openRuntimeCollectorStore();
  try {
    const destination = offerUrl(permalink);
    if (!destination || sourceLane(destination) !== 'threads') throw new Error('threads_arguments');
    store.transaction(() => enqueueSource(store, offerConfig(), { destination, parent: '', relation: mode,
      locator: 'cli', source: new URL(destination).hostname, category: '', depth: 0 }));
    console.log(JSON.stringify({ outcome: 'registered' }));

  } finally { store.close(); }
}
main().catch(() => { console.error('threads_collection_unavailable'); process.exitCode = 1; });
