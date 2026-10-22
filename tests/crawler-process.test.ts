import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { apps: [app] } = require('../crawler/ecosystem.config.cjs');

test.each(['login', 'challenge', 'blocked'])('halt %s exits the actual Node process with the pm2 stop code', reason => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { handleFailure } from './crawler/index.ts';
    import { HaltError } from './crawler/lib/browser.ts';
    setInterval(() => {}, 1000); // Simulate leaked browser handles after cleanup.
    await handleFailure(new HaltError(${JSON.stringify(reason)}));
  `], { cwd: root, encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(75);
  expect(app.stop_exit_codes).toContain(result.status);
  expect(result.stderr).not.toContain('TypeScript support unavailable');
});

test.each([app.script, 'crawler/index.ts'])('entrypoint %s with missing config exits before any browser/network work', script => {
  expect(extname(app.script)).toBe('.mjs');
  expect(realpathSync(app.interpreter)).toBe(realpathSync(resolve(root, 'node_modules/node/bin/node')));
  expect(app.node_args).toBe('--import tsx');
  const env = { ...process.env };
  delete env.AGAMAJUNG_API_URL;
  delete env.INGEST_TOKEN;
  const result = spawnSync(process.execPath, [...app.node_args.split(' '), script], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('크롤러 중단(unknown)');
  expect(result.stderr).toContain('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  expect(result.stderr).toContain('error_stack');
  expect(result.stderr).not.toContain('TypeScript support unavailable');
});

test('startup diagnostics reach stderr even if health initialization fails', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { initHealth } from './crawler/lib/health.ts';
    import { handleFailure } from './crawler/index.ts';
    await initHealth('/dev/null').catch(handleFailure);
  `], { cwd: root, encoding: 'utf8', timeout: 15000 });
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
