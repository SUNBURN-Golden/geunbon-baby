import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { apps: [app] } = require('../crawler/ecosystem.config.cjs');
const preload = ['--import', 'tsx', '--import', './tests/helpers/offline-child.mjs'];
const temporaryDirectories: string[] = [];

function childEnv(extra: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TZ']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function runChild(args: string[], extra: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [...preload, ...args], {
    cwd: root, env: childEnv(extra), encoding: 'utf8', timeout: 15000,
  });
}

async function envFile(contents: string) {
  const directory = await mkdtemp(join(tmpdir(), 'crawler-child-env-'));
  temporaryDirectories.push(directory);
  const path = join(directory, '.env.crawler');
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test('offline child blockers prevent browser, network, process launch and operator env access independently', () => {
  const result = runChild(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { chromium } from 'playwright';
    import { chromium as core } from 'playwright-core';
    import { spawn, execFile } from 'node:child_process';
    import net from 'node:net';
    import tls from 'node:tls';
    import dns from 'node:dns';
    assert.throws(() => chromium.launch(), /Browser launch forbidden in child tests/);
    assert.throws(() => chromium.launchPersistentContext('/unused'), /Browser launch forbidden in child tests/);
    assert.throws(() => core.launch(), /Browser launch forbidden in child tests/);
    assert.throws(() => spawn('chromium'), /Browser process spawn forbidden in child tests/);
    assert.throws(() => execFile('chromium'), /Browser process execFile forbidden in child tests/);
    assert.throws(() => fetch('https://www.instagram.com/'), /Network fetch forbidden in child tests/);
    assert.throws(() => net.connect(443, 'instagram.com'), /Network socket forbidden in child tests/);
    assert.throws(() => tls.connect(443, 'instagram.com'), /Network TLS forbidden in child tests/);
    assert.throws(() => dns.lookup('instagram.com', () => {}), /Network DNS forbidden in child tests/);
    assert.throws(() => dns.promises.lookup('instagram.com'), /Network DNS forbidden in child tests/);
    assert.throws(() => process.loadEnvFile(${JSON.stringify(resolve(root, '.env.crawler'))}), /Env file forbidden in child tests/);
    for (const key of ['AGAMAJUNG_IG_PASSWORD', 'INGEST_TOKEN', 'AGAMAJUNG_API_URL']) assert.equal(process.env[key], undefined);
    console.log('offline blockers verified');
  `]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('offline blockers verified');
  expect(result.stderr).not.toContain('forbidden');
});

test.each(['login', 'challenge', 'blocked'])('halt %s exits the actual Node process with the pm2 stop code', reason => {
  const result = runChild(['--input-type=module', '-e', `
    import { handleFailure } from './crawler/index.ts';
    import { HaltError } from './crawler/lib/browser.ts';
    setInterval(() => {}, 1000); // Simulate leaked browser handles after cleanup.
    await handleFailure(new HaltError(${JSON.stringify(reason)}));
  `]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(75);
  expect(app.stop_exit_codes).toContain(result.status);
  expect(result.stderr).not.toContain('TypeScript support unavailable');
});

test.each([app.script, 'crawler/index.ts'])('entrypoint %s with missing config exits before any browser/network work', script => {
  expect(extname(app.script)).toBe('.mjs');
  expect(realpathSync(app.interpreter)).toBe(realpathSync(resolve(root, 'node_modules/node/bin/node')));
  expect(app.node_args).toBe('--import tsx');
  const result = runChild([script]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('크롤러 중단(unknown)');
  expect(result.stderr).toContain('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  expect(result.stderr).toContain('error_stack');
  expect(result.stderr).not.toContain('TypeScript support unavailable');
  expect(result.stderr).not.toContain('forbidden');
});

test.each([app.script, 'crawler/index.ts'])('entrypoint %s with injected dry-run exits without API credentials', script => {
  const result = runChild([script], { AGAMAJUNG_EXTERNAL_DRY_RUN: '1' });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('외부 수집은 npm run collector:worker -- discover --dry-run 으로 이관되었습니다.');
  expect(result.stderr).not.toMatch(/크롤러 중단|forbidden/);
});

test.each([app.script, 'crawler/index.ts'])('entrypoint %s with env-file dry-run exits even with valid API configuration', async script => {
  const path = await envFile('AGAMAJUNG_EXTERNAL_DRY_RUN=1\nAGAMAJUNG_API_URL=https://ingest.invalid/\nINGEST_TOKEN=offline\n');
  const result = runChild([script], { AGAMAJUNG_TEST_ENV_FILE: path });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('외부 수집은 npm run collector:worker -- discover --dry-run 으로 이관되었습니다.');
  expect(result.stderr).not.toMatch(/크롤러 중단|forbidden/);
});

test.each([app.script, 'crawler/index.ts'])('entrypoint %s with env-file dry-run needs no API credentials', async script => {
  const path = await envFile('AGAMAJUNG_EXTERNAL_DRY_RUN=1\n');
  const result = runChild([script], { AGAMAJUNG_TEST_ENV_FILE: path });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('외부 수집은 npm run collector:worker -- discover --dry-run 으로 이관되었습니다.');
  expect(result.stderr).not.toMatch(/크롤러 중단|forbidden/);
});

const invalidCases = [app.script, 'crawler/index.ts'].flatMap(script =>
  (['injected', 'env-file'] as const).map(source => ({ script, source })));

test.each(invalidCases)('entrypoint $script rejects invalid dry-run from $source', async ({ script, source }) => {
  const extra = source === 'injected'
    ? { AGAMAJUNG_EXTERNAL_DRY_RUN: 'true' }
    : { AGAMAJUNG_TEST_ENV_FILE: await envFile('AGAMAJUNG_EXTERNAL_DRY_RUN=true\n') };
  const result = runChild([script], extra);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AGAMAJUNG_EXTERNAL_DRY_RUN은 0 또는 1이어야 합니다.');
  expect(result.stderr).toContain('크롤러 중단(unknown)');
  expect(result.stderr).not.toContain('forbidden');
});

test('startup diagnostics reach stderr even if health initialization fails', () => {
  const result = runChild(['--input-type=module', '-e', `
    import { initHealth } from './crawler/lib/health.ts';
    import { handleFailure } from './crawler/index.ts';
    await initHealth('/dev/null').catch(handleFailure);
  `]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOTDIR');
  expect(result.stderr).toContain('error_stack');
});

test('pm2 runs exactly twice daily in KST, once per launch, without other restart triggers', () => {
  expect(app.cron_restart).toBe('30 9,20 * * *');
  expect(app.env.TZ).toBe('Asia/Seoul');
  expect(app.env.AGAMAJUNG_ONCE).toBe('1');
  expect(app.env.AGAMAJUNG_QUIET_WINDOWS).toBe('06:45-08:00,13:00-14:00');
  expect(app.autorestart).toBe(false);
  expect(app.watch).toBe(false);
  expect(app.max_memory_restart).toBeUndefined();
  expect(app.restart_delay).toBeUndefined();
});
