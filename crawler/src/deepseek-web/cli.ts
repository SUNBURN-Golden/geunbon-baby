import type { CollectorStore } from '../store';
import type { CollectionReport, DeepSeekClient } from './types';
import { cycleInterval, DEFAULT_INTERVAL_MS, stateDir } from './config';
import { heartbeatStatus } from './heartbeat';
export type DeepSeekWebCliDeps = {
  store?: CollectorStore;
  client?: DeepSeekClient;
  fetchImpl?: typeof fetch;
  stateDir?: string;
  urls?: string[];
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};
export function deepSeekWebCli(args: ['status', ...string[]], deps?: DeepSeekWebCliDeps): ReturnType<typeof heartbeatStatus>;
export function deepSeekWebCli(args: string[], deps?: DeepSeekWebCliDeps): Promise<CollectionReport>;
export async function deepSeekWebCli(args: string[], deps: DeepSeekWebCliDeps = {}) {
  const [command, ...rest] = args;
  // No runner, store or SQLite runtime import on the status path.
  if (command === 'status') return heartbeatStatus(deps.stateDir ?? stateDir(), deps.now?.());
  if (!['once', 'dry-run', 'daemon'].includes(command)) throw new Error('usage: once [url...] | dry-run [url...] | daemon | status [--json]');
  const { runDeepSeekWeb } = await import('./runner');
  if (command !== 'daemon') return runDeepSeekWeb({ ...deps, mode: command === 'once' ? 'once' : 'dry_run', urls: rest.length ? rest : undefined });
  const { acquireWriter } = await import('./writer-ownership');
  const { waitFor } = await import('./lifecycle');
  const ownership = acquireWriter(deps.stateDir ?? stateDir());
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let last: CollectionReport | undefined;
  try {
    while (!signal.aborted) {
      try {
        last = await runDeepSeekWeb({ ...deps, stateDir: ownership.dir, ownership, signal, mode: 'daemon_tick' });
        console.error(JSON.stringify({ event: 'deepseek_web_tick', ...last }));
      } catch {
        // Storage/ownership write failures cannot guarantee a heartbeat. Never leak raw errors.
        console.error('deepseek_web_state_unavailable');
      }
      if (signal.aborted) break;
      let interval = DEFAULT_INTERVAL_MS;
      try { interval = cycleInterval(); } catch { /* diagnostic cycles retry without spinning */ }
      const now = deps.now?.() ?? Date.now();
      const deadline = last?.backoff ? Date.parse(last.backoff.next_attempt_at) : 0;
      await (deps.wait ?? waitFor)(deadline > now ? deadline - now : interval, signal);
    }
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    ownership.release();
  }
  return last;
}
