import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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
  expect(app.interpreter).toBe('node');
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
  expect(result.stderr).not.toContain('TypeScript support unavailable');
});
