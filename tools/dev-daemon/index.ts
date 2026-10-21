import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from './queue';
import { ProcessRunner } from './runner';
import { Daemon } from './daemon';
import type { ModelKey, ModelsConfig } from './types';

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
async function main(): Promise<void> {
  process.umask(0o077);
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`;
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run dev-daemon -- [--once]\n--once: process one task, or exit after persisting a quota pause. See tools/dev-daemon/README.md.');
    return;
  }
  if (args.some(arg => arg !== '--once')) throw new Error('Unknown argument; use --help');
  const queue = new Queue(resolve(process.env.DEV_DAEMON_QUEUE ?? '/workspace/agamajung/dev-queue'));
  await queue.init();
  const runner = new ProcessRunner(positiveInteger('DEV_DAEMON_TIMEOUT_MS', 45 * 60000));
  const abort = new AbortController();
  let stopping = false;
  const stop = () => { stopping = true; runner.stop(); abort.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const unlock = await queue.lock(() => { process.exitCode = 1; stop(); });
  try {
    const config = JSON.parse(await readFile(process.env.DEV_DAEMON_MODELS ?? new URL('./models.json', import.meta.url), 'utf8')) as ModelsConfig;
    for (const key of ['fable', 'astra6', 'opus55', 'sol61', 'sonnet', 'glm', 'swe2'] as ModelKey[]) {
      const model = config.models?.[key];
      if (!model || !['claude', 'codex', 'glm', 'devin'].includes(model.provider) || !model.id?.trim()) throw new Error(`Invalid model config: ${key}`);
    }
    const daemon = new Daemon({ repo: resolve(process.env.DEV_DAEMON_REPO ?? fileURLToPath(new URL('../../', import.meta.url))), queue,
      config, execute: runner.execute, blueprint: process.env.DEV_DAEMON_BLUEPRINT,
      unknownResetMs: positiveInteger('DEV_DAEMON_UNKNOWN_RESET_MS', 15 * 60000) });
    await daemon.init();
    console.log('agamajung-dev-daemon ready');
    let claimed = Boolean(daemon.state.active);
    while (!stopping) {
      const wait = await daemon.tick();
      claimed ||= Boolean(daemon.state.active);
      if (args.includes('--once') && ((claimed && !daemon.state.active) || wait > 0)) break;
      if (wait > 0) await delay(Math.min(wait, 30000), undefined, { signal: abort.signal });
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    runner.stop();
    await unlock();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
main().catch(() => {
  // Child outputs are recorded only in private, redacted task logs. Do not dump
  // Error objects: spawn errors can embed prompts, environment values, or URLs.
  console.error('Dev daemon stopped with an error. Check status.json, task logs, config, and queue lock.');
  process.exitCode = 1;
});
