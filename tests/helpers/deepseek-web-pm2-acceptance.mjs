// Standalone Linux acceptance; never connects to the operational PM2 daemon or collector state.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicState } from '../../crawler/src/deepseek-web/atomic-state.ts';
import { failBackoff, readBackoff } from '../../crawler/src/deepseek-web/backoff.ts';
const require = createRequire(import.meta.url);
const production = require('../../crawler/deepseek-web.ecosystem.config.cjs').apps[0];
const dir = mkdtempSync(join(tmpdir(), 'ds-pm2-acceptance-'));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, PM2_HOME: join(dir, 'pm2'), DEEPSEEK_WEB_DAEMON_MS: '1000' };
const pm2 = process.env.DEEPSEEK_TEST_PM2 ?? 'pm2';
const command = (...args) => execFileSync(pm2, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
const list = () => JSON.parse(command('jlist'));
const heartbeat = () => { try { return JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8')); } catch { return null; } };
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await delay(250); }
  throw new Error('acceptance_timeout');
}
try {
  const config = join(dir, 'ecosystem.config.cjs');
  const app = { ...production, name: 'deepseek-isolated-acceptance', cwd: process.cwd(), interpreter: process.execPath,
    script: resolve('tests/helpers/deepseek-web-child.mjs'), args: ['daemon', dir],
    out_file: join(dir, 'stdout.log'), error_file: join(dir, 'stderr.log'),
    env: { NODE_ENV: 'test', TZ: 'Asia/Seoul', DEEPSEEK_WEB_DAEMON_MS: '1000' } };
  writeFileSync(config, `module.exports = ${JSON.stringify({ apps: [app] })};\n`);
  command('start', config);
  await until(() => heartbeat()?.outcome === 'completed');
  const first = heartbeat();
  await until(() => heartbeat()?.cycle_id !== first.cycle_id && heartbeat()?.outcome === 'completed');
  const pid = list()[0].pid;
  assert(pid > 0); assert.equal(list().length, 1);
  // Park the real daemon on a valid durable backoff, then SIGKILL it during that wait.
  const control = failBackoff(dir, null, 402, Date.now());
  await delay(1500);
  atomicState(join(dir, 'heartbeat.json'), { ...heartbeat(), outcome: 'backoff', reason: control.reason, backoff: { ...control, state: 'scheduled' } });
  const before = readFileSync(join(dir, 'heartbeat.json'), 'utf8');
  process.kill(pid, 'SIGKILL');
  await until(() => { const p = list()[0]; return p.pid > 0 && p.pid !== pid && p.pm2_env.status === 'online'; }, 90000);
  const replacement = list()[0].pid;
  await until(() => Number(readFileSync(join(dir, 'ready-pid'), 'utf8')) === replacement);
  await delay(1500);
  assert.equal(list().length, 1);
  assert.equal(readFileSync(join(dir, 'heartbeat.json'), 'utf8'), before);
  assert.deepEqual(readBackoff(dir), control);
  // Ownership survives the kill and the replacement reclaims it after the real grace period.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'writer-ownership.sqlite'), { readOnly: true });
  const owner = JSON.parse(db.prepare('SELECT value FROM owner').get().value); db.close();
  assert.equal(owner.pid, replacement);
  // Status in a fresh process with no credentials/DB, against read-only state.
  chmodSync(dir, 0o500);
  const out = spawnSync(process.execPath, ['--import', 'tsx', 'crawler/deepseek-web/run.mjs', 'status', '--json'], { env: { PATH: process.env.PATH, DEEPSEEK_WEB_STATE_DIR: dir, DEEPSEEK_WEB_DAEMON_MS: '1000' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).freshness, 'stale');
  assert.equal(JSON.parse(out.stdout).backoff.state, 'scheduled');
  chmodSync(dir, 0o700);
  console.log('PASS: heartbeat cycles; SIGKILL → new PM2 PID; one writer; real ownership grace; persisted backoff; read-only status');
} finally {
  chmodSync(dir, 0o700);
  try { command('kill'); } catch { /* Cleanup is confined to this temporary PM2_HOME. */ }
  rmSync(dir, { recursive: true, force: true });
}
