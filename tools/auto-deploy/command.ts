import { spawn } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { DeployError } from './state';

export type Environment = Record<string, string | undefined>;

export const hostEnv = () => {
  const env: Environment = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PM2_HOME', 'SSH_AUTH_SOCK']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
};

export const nodeEnv = (node: string) => {
  const { HOME, USER, LOGNAME, LANG, LC_ALL, PATH } = hostEnv();
  return {
    HOME, USER, LOGNAME, LANG, LC_ALL, PATH: dirname(node) + delimiter + (PATH ?? '/usr/bin:/bin'),
    CI: 'true', NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  };
};

export type Command = (file: string, args: string[], options: {
  cwd?: string; env?: Environment; timeout?: number; lockFile?: string;
}) => Promise<{ code: number; stdout: string }>;

export const command: Command = (file, args, { cwd, env = hostEnv(), timeout = 120_000, lockFile }) => new Promise((resolve, reject) => {
  // Captured output is never included in an exception, audit or service log.
  // A separate operation lock protects reconciliation from a still-running
  // command after an interrupted controller. It does not delay PM2 startup.
  const executable = lockFile ? '/usr/bin/flock' : file;
  const argv = lockFile ? ['--no-fork', '--timeout', String(Math.ceil(timeout / 1000)), lockFile, file, ...args] : args;
  const child = spawn(executable, argv, {
    cwd, env: env as NodeJS.ProcessEnv, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  function stop() {
    failed = true;
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
  const timer = setTimeout(stop, timeout);
  child.stdout!.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) stop();
    else chunks.push(chunk);
  });
  child.once('error', () => { clearTimeout(timer); reject(new DeployError('command_unavailable')); });
  child.once('close', code => {
    clearTimeout(timer);
    if (failed || code === null) reject(new DeployError('command_interrupted'));
    else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
  });
});

export async function checked(run: Command, code: string, ...args: Parameters<Command>) {
  let result;
  try { result = await run(...args); } catch { throw new DeployError(code); }
  if (result.code !== 0) throw new DeployError(code);
  return result.stdout;
}
