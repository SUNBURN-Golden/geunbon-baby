import { runDeepSeekWeb, type RunnerOptions } from './runner';
import { openRuntimeCollectorStore, assertDomainPolicyReadable } from './runtime-store';
import type { CollectorStore } from '../store';
import type { DeepSeekClient } from './types';
export type DeepSeekWebCliDeps = {
  store?: CollectorStore;
  client?: DeepSeekClient;
  fetchImpl?: typeof fetch;
  stateDir?: string;
};
function needsCollectorDb(command: string) {
  return command === 'once' || command === 'daemon';
}
export async function deepSeekWebCli(args: string[], deps: DeepSeekWebCliDeps = {}) {
  const [command, ...rest] = args;
  const withStore = async (mode: RunnerOptions['mode'], urls?: string[]) => {
    let owned: CollectorStore | undefined;
    const store = deps.store ?? (needsCollectorDb(command) ? (owned = openRuntimeCollectorStore()) : undefined);
    if (store) assertDomainPolicyReadable(store);
    try {
      return await runDeepSeekWeb({
        mode,
        urls,
        store,
        client: deps.client,
        fetchImpl: deps.fetchImpl,
        stateDir: deps.stateDir,
      });
    } finally {
      owned?.close();
    }
  };
  if (command === 'once') return withStore('once', rest.length ? rest : undefined);
  if (command === 'dry-run') {
    return runDeepSeekWeb({
      mode: 'dry_run',
      urls: rest.length ? rest : undefined,
      store: deps.store,
      client: deps.client,
      fetchImpl: deps.fetchImpl,
      stateDir: deps.stateDir,
    });
  }
  if (command === 'daemon') {
    const interval = Number(process.env.DEEPSEEK_WEB_DAEMON_MS ?? 600000);
    for (;;) {
      const report = await withStore('once');
      console.error(JSON.stringify({ event: 'deepseek_web_tick', ...report }));
      await new Promise(r => setTimeout(r, interval));
    }
  }
  throw new Error('usage: once [url...] | dry-run [url...] | daemon');
}
