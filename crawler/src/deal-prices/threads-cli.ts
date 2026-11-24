import { openRuntimeCollectorStore } from '../deepseek-web/runtime-store';
import { fetchThreadsPost, threadsRegistry } from './threads';
import { stateDir } from '../deepseek-web/config';
import { registerThreadsPost } from './threads-schedule';

async function main() {
  const [, , mode, permalink] = process.argv;
  if ((mode !== 'check' && mode !== 'collect') || !permalink || process.argv.length !== 4) throw new Error('threads_arguments');
  const store = openRuntimeCollectorStore();
  try {
    const registry = threadsRegistry(store);
    if (mode === 'check') {
      const result = await fetchThreadsPost(permalink, registry);
      console.log(JSON.stringify({ outcome: result.outcome }));
      if (result.outcome !== 'captured') process.exitCode = 1;
      return;
    }
    await registerThreadsPost(stateDir(), registry, permalink);
    console.log(JSON.stringify({ outcome: 'registered' }));
  } finally { store.close(); }
}
main().catch(() => { console.error('threads_collection_unavailable'); process.exitCode = 1; });
