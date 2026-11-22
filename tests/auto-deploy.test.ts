import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { deployer, type Adapters } from '../tools/auto-deploy/deploy';
import { command, type Command } from '../tools/auto-deploy/command';
import { crawlerAdapter, currentTarget, quietWindow, switchRuntime } from '../tools/auto-deploy/crawler';
import { gitAdapter, runtimePath } from '../tools/auto-deploy/git';
import { siteAdapter, siteProbe, uploadVersion } from '../tools/auto-deploy/site';
import { atomicWrite, DeployError, readState } from '../tools/auto-deploy/state';
import { loadCrawlerEnv, readCrawlerEnv } from '../crawler/managed-env.mjs';

const first = 'a'.repeat(40), second = 'b'.repeat(40);
const previous = 'aabbccdd-1122-3344-5566-778899001122', candidate = 'aabbccdd-1122-3344-5566-778899001123';
const upload = (version = candidate, worker = 'agamajung') => JSON.stringify({ type: 'version-upload', version_id: version, worker_name: worker }) + '\n';
const temporary: string[] = [];
const tmp = () => { const root = mkdtempSync(join(tmpdir(), 'auto-deploy-test-')); temporary.push(root); return root; };
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = tmp(), runtime = join(root, 'runtime');
  mkdirSync(runtime);
  let sha = first, version = previous, now = 10;
  const snapshot = { link: null, apps: [], instagramRoot: null };
  const ops = {
    fetch: vi.fn(async () => sha),
    prepare: vi.fn<Adapters['prepare']>(async () => {}),
    verify: vi.fn<Adapters['verify']>(async () => {}),
    remove: vi.fn<Adapters['remove']>(async () => {}),
    validate: vi.fn(async (_path: string, report: (step: string) => void) => { report('tests'); }),
    copy: vi.fn<Adapters['copy']>(async () => '\nChanged copy\n'),
    serving: vi.fn(async () => version),
    pending: vi.fn(async () => [{ name: '0001_test.sql', destructive: true }]),
    migrate: vi.fn(async () => {}),
    upload: vi.fn(async (_path: string, output: string) => { writeFileSync(output, upload()); }),
    promote: vi.fn<Adapters['promote']>(async (_, promoted) => { version = promoted; }),
    health: vi.fn<Adapters['health']>(async () => true),
    rollback: vi.fn(async () => { version = previous; }),
    preflight: vi.fn(async () => snapshot),
    current: vi.fn<Adapters['current']>(() => null),
    cutover: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
  } satisfies Adapters;
  const log = vi.fn();
  return {
    root, runtime, ops, log, deployment: () => deployer(root, runtime, ops, log, () => now),
    advance: () => { now += 7_200_000; }, setHead: (value: string) => { sha = value; },
    state: () => readState(root),
    events: () => readFileSync(join(root, 'deploys.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('deploys once and fetches without reopening a completed SHA', async () => {
  const f = fixture();
  await f.deployment().poll();
  await f.deployment().poll();
  expect(f.ops.fetch).toHaveBeenCalledTimes(2);
  expect(f.ops.prepare).toHaveBeenCalledTimes(1);
  expect(f.ops.migrate).toHaveBeenCalledTimes(1);
  expect(f.ops.cutover).toHaveBeenCalledTimes(1);
  expect(f.state()).toMatchObject({ lastSite: first, lastCrawler: first, lastDeployed: first });
  expect(f.ops.copy).toHaveBeenCalledWith(null, first);
  expect(f.events()).toMatchObject([{ sha: first, ok: true, rollback: null, migrations: [{ destructive: true }] }]);
});

test('two merges between polls produce one validation and deployment of the fetched tip', async () => {
  const f = fixture();
  await f.deployment().poll();
  f.setHead(second);
  const tip = 'c'.repeat(40);
  f.setHead(tip);
  const path = runtimePath(f.runtime, tip);
  const version = 'aabbccdd-1122-3344-5566-778899001124';
  f.ops.upload.mockImplementationOnce(async (_, output) => { writeFileSync(output, upload(version)); });
  await f.deployment().poll();
  await f.deployment().poll();
  expect(f.ops.prepare.mock.calls.map(([, sha]) => sha)).toEqual([first, tip]);
  expect(f.ops.validate).toHaveBeenCalledTimes(2);
  expect(f.ops.validate).toHaveBeenLastCalledWith(path, expect.any(Function));
  expect(f.ops.migrate.mock.calls).toHaveLength(2);
  expect(f.ops.promote).toHaveBeenLastCalledWith(path, version);
  expect(f.ops.cutover).toHaveBeenCalledTimes(2);
  expect(f.events().map(event => event.sha)).toEqual([first, tip]);
});

test.each(['typecheck_failed', 'tests_failed', 'worker_build_failed', 'worker_bundle_failed'])('%s rejects before D1 until main moves', async code => {
  const f = fixture();
  f.ops.validate.mockRejectedValueOnce(new DeployError(code));
  await f.deployment().poll();
  expect(f.state().rejected).toBe(first);
  expect(f.ops.preflight).not.toHaveBeenCalled();
  expect(f.ops.migrate).not.toHaveBeenCalled();
  expect(f.ops.promote).not.toHaveBeenCalled();
  await f.deployment().poll();
  expect(f.ops.validate).toHaveBeenCalledTimes(1);
  f.setHead(second);
  await f.deployment().poll();
  expect(f.state().lastDeployed).toBe(second);
  expect(f.events().map(event => event.ok)).toEqual([false, true]);
});

test('records a D1 apply failure and retries with backoff without promoting', async () => {
  const f = fixture();
  f.ops.migrate.mockRejectedValueOnce(new DeployError('migration_apply_failed'));
  await f.deployment().poll();
  expect(f.events()[0]).toMatchObject({ status: 'failed', migrations: [{ name: '0001_test.sql' }] });
  expect(f.ops.upload).not.toHaveBeenCalled();
  await f.deployment().poll();
  expect(f.ops.validate).toHaveBeenCalledTimes(1);
  f.advance();
  await f.deployment().poll();
  expect(f.state().lastDeployed).toBe(first);
});

test('an incompatible crawler inventory blocks production preflight', async () => {
  const f = fixture();
  f.ops.preflight.mockRejectedValueOnce(new DeployError('crawler_ecosystem_mismatch'));
  await f.deployment().poll();
  expect(f.ops.serving).not.toHaveBeenCalled();
  expect(f.ops.migrate).not.toHaveBeenCalled();
  expect(f.ops.promote).not.toHaveBeenCalled();
  expect(f.events()[0]).toMatchObject({ ok: false, steps: expect.arrayContaining([
    { name: 'prepare', outcome: 'crawler_ecosystem_mismatch' },
  ]) });
});

test('uses the exact upload record and rejects missing, duplicate, or invalid IDs', () => {
  expect(uploadVersion(upload(previous, 'another-worker') + upload())).toBe(candidate);
  expect(() => uploadVersion(upload() + upload())).toThrow('upload_record_invalid');
  expect(() => uploadVersion(upload(previous, 'another-worker'))).toThrow('upload_record_invalid');
  expect(() => uploadVersion(upload('malformed'))).toThrow('upload_record_invalid');
});

test('records a corrupt upload without promoting any version', async () => {
  const f = fixture();
  f.ops.upload.mockImplementationOnce(async (_, output) => { writeFileSync(output, upload() + upload()); });
  await f.deployment().poll();
  expect(f.ops.promote).not.toHaveBeenCalled();
  expect(f.events()[0]).toMatchObject({ status: 'failed', steps: expect.arrayContaining([{ name: 'upload', outcome: 'upload_record_invalid' }]) });
});

test('failed candidate health rolls back to the predecessor and verifies the legacy contract', async () => {
  const f = fixture();
  f.ops.health.mockImplementation(async (_, __, legacy) => legacy);
  await f.deployment().poll();
  expect(f.ops.rollback).toHaveBeenCalledWith(expect.any(String), previous);
  expect(f.ops.health.mock.calls.map(([, version, legacy]) => [version, legacy])).toEqual([[candidate, false], [previous, true]]);
  expect(f.ops.cutover).not.toHaveBeenCalled();
  expect(f.state()).toMatchObject({ lastSite: null, rejected: first });
  expect(f.events()).toMatchObject([{ sha: first, ok: false, rollback: { command: 'ok', verified: true } }]);
});

test('an unverified rollback reconciles before the next SHA', async () => {
  const f = fixture();
  f.ops.health.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  await f.deployment().poll();
  expect(f.state().attempt?.phase).toBe('rollback');
  f.setHead(second);
  f.advance();
  await f.deployment().poll();
  expect(f.ops.prepare).toHaveBeenCalledTimes(1);
  expect(f.ops.rollback).toHaveBeenCalledTimes(1);
  expect(f.events()[0].rollback).toEqual({ command: 'ok', verified: true });
  await f.deployment().poll();
  expect(f.state().lastDeployed).toBe(second);
});

test('recovers a promotion whose command completed before interruption', async () => {
  const f = fixture();
  const promote = f.ops.promote.getMockImplementation()!;
  f.ops.promote.mockImplementationOnce(async (...args) => { await promote(...args); throw new DeployError('command_interrupted'); });
  await f.deployment().poll();
  expect(f.state().attempt?.phase).toBe('promote');
  f.advance();
  f.ops.fetch.mockRejectedValueOnce(new Error('offline'));
  await f.deployment().poll();
  expect(f.ops.promote).toHaveBeenCalledTimes(1);
  expect(f.state().lastDeployed).toBe(first);
  expect(f.events()).toHaveLength(1);
});

test('a crawler failure restores the prior runtime while keeping the site healthy and retries only the crawler', async () => {
  const f = fixture();
  f.ops.cutover.mockRejectedValueOnce(new DeployError('crawler_pm2_start_failed'));
  f.ops.restore.mockRejectedValueOnce(new DeployError('crawler_restore_verify_failed'));
  await f.deployment().poll();
  expect(f.state()).toMatchObject({ lastSite: first, lastDeployed: null, attempt: { phase: 'restore' } });
  f.advance();
  await f.deployment().poll();
  expect(f.events()[0]).toMatchObject({ status: 'partial', ok: false, rollback: null });
  f.advance();
  await f.deployment().poll();
  expect(f.ops.prepare).toHaveBeenCalledTimes(1);
  expect(f.ops.promote).toHaveBeenCalledTimes(1);
  expect(f.ops.rollback).not.toHaveBeenCalled();
  expect(f.ops.cutover).toHaveBeenCalledTimes(2);
  expect(f.state().lastDeployed).toBe(first);
});

test('retains the current and three previous successful runtimes and removes only recorded paths', async () => {
  const f = fixture(), state = f.state();
  const releases = ['a', 'b', 'c', 'd', 'e'].map(character => character.repeat(40));
  const paths = releases.map(sha => runtimePath(f.runtime, sha));
  state.lastSite = first;
  state.lastCrawler = first;
  state.lastDeployed = first;
  state.successful = paths.slice(0, 4);
  for (const [i, path] of paths.entries()) state.owned[path] = releases[i];
  f.ops.current.mockReturnValue(paths[0]);
  atomicWrite(join(f.root, 'state.json'), state);
  await f.deployment().poll();
  expect(f.ops.remove.mock.calls).toEqual([[paths[4], releases[4]]]);
});

test.each([0, 5, 200])('recovers a staged audit append without duplication (%i bytes)', async count => {
  const f = fixture(), state = f.state();
  state.lastSite = first;
  state.lastCrawler = first;
  state.lastDeployed = first;
  const old = '{"id":"old"}\n', line = '{"id":"new","text":"아가마중"}\n';
  const review = '## 아가마중\n+새 문구\n';
  const log = join(f.root, 'deploys.jsonl'), copy = join(f.root, 'COPY_REVIEW.md');
  writeFileSync(log, old);
  appendFileSync(log, Buffer.from(line).subarray(0, count));
  writeFileSync(copy, Buffer.from(review).subarray(0, count));
  state.event = { text: line, append: { offset: Buffer.byteLength(old), text: line } };
  state.copy = [{ before: null, after: first, append: { offset: 0, text: review } }];
  atomicWrite(join(f.root, 'state.json'), state);
  await f.deployment().poll();
  await f.deployment().poll();
  expect(readFileSync(log, 'utf8')).toBe(old + line);
  expect(readFileSync(copy, 'utf8')).toBe(review);
  expect(f.ops.copy).not.toHaveBeenCalled();
});

test('atomically switches current while leaving the old link in place until the rename', async () => {
  const root = tmp(), link = join(root, 'current'), old = join(root, 'old'), next = join(root, 'new');
  mkdirSync(old); mkdirSync(next); symlinkSync(old, link);
  await switchRuntime(async (file, args, options) => {
    const result = await command(file, args, options);
    expect(file).toBe('ln');
    expect(readlinkSync(link)).toBe(old);
    expect(readlinkSync(args.at(-1)!)).toBe(next);
    return result;
  }, link, next);
  expect(currentTarget(link)).toBe(next);
  expect(readdirSync(root).sort()).toEqual(['current', 'new', 'old']);
  await switchRuntime(command, link, old);
  expect(currentTarget(link)).toBe(old);
  expect(quietWindow(new Date('2026-11-20T00:20:00Z'), false)).toBe(false);
  expect(quietWindow(new Date('2026-11-20T00:30:00Z'), false)).toBe(true);
});

test('loads crawler env as private data and gives file values precedence', () => {
  const root = tmp(), file = join(root, 'fixture.env');
  vi.stubEnv('COLLECTOR_FIXTURE', 'inherited');
  writeFileSync(file, 'COLLECTOR_FIXTURE=literal=$oops # text\n', { mode: 0o600 });
  loadCrawlerEnv(file);
  expect(process.env.COLLECTOR_FIXTURE).toBe('literal=$oops # text');
  symlinkSync(file, join(root, 'alias'));
  expect(() => readCrawlerEnv(join(root, 'alias'))).toThrow('crawler_env_unavailable');
  writeFileSync(join(root, 'public.env'), 'KEY=value\n');
  chmodSync(join(root, 'public.env'), 0o644);
  expect(() => readCrawlerEnv(join(root, 'public.env'))).toThrow('crawler_env_unavailable');
});

test('crawler preflight scopes PM2 to the known inventory and blocks a competing scheduler or watchdog', async () => {
  const root = tmp(), state = join(root, 'state'), path = join(root, 'candidate'), legacy = join(root, 'legacy');
  for (const dir of [state, legacy, join(path, 'crawler/deepseek-web'), join(root, 'db'), join(root, 'raw'), join(root, 'deep')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const file of ['ecosystem.all.config.cjs', 'pm2-cron.cjs', 'load-managed-env.mjs', 'pm2-cron-gate.mjs', 'local-worker.mjs', 'deepseek-web/run.mjs']) {
    copyFileSync(join('crawler', file), join(path, 'crawler', file));
  }
  mkdirSync(join(legacy, 'crawler'));
  mkdirSync(join(legacy, 'node_modules/node/bin'), { recursive: true });
  writeFileSync(join(legacy, 'crawler/local-worker.mjs'), '');
  writeFileSync(join(legacy, 'node_modules/node/bin/node'), '');
  const db = join(root, 'db/collector.sqlite');
  writeFileSync(db, '', { mode: 0o600 });
  const file = join(root, 'fixture.env');
  writeFileSync(file, [
    'COLLECTOR_DB=' + db, 'COLLECTOR_RAW_DIR=' + join(root, 'raw'), 'DEEPSEEK_WEB_STATE_DIR=' + join(root, 'deep'),
    'DEEPSEEK_API_KEY=fixture', 'COLLECTOR_INTAKE_TOKEN=' + 'i'.repeat(24),
    'COLLECTOR_REVIEW_TOKEN=' + 'r'.repeat(24), 'COLLECTOR_EXTENSION_ORIGIN=chrome-extension://' + 'a'.repeat(32),
  ].join('\n'), { mode: 0o600 });
  vi.stubEnv('PM2_HOME', state);
  const entry = (name: string) => ({ name, pm2_env: { name, pm_cwd: legacy, pm_exec_path: join(legacy, 'crawler/local-worker.mjs'), args: ['serve'], exec_mode: 'fork_mode' } });
  let inventory = [entry('agamajung-local-worker'), entry('agamajung-dev-daemon'), entry('glkg-unrelated')];
  let enabled = false;
  const run = vi.fn<Command>(async (exe, args, options) => {
    if (exe === process.execPath) return command(exe, args, options);
    if (exe === 'pm2' && args[0] === 'jlist') return { code: 0, stdout: JSON.stringify(inventory) };
    if (exe === 'systemctl') return args.includes('show')
      ? { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n' }
      : { code: 0, stdout: enabled ? 'enabled' : 'disabled' };
    throw new Error('unexpected command');
  });
  const adapter = crawlerAdapter(run, root, state, path, { readEnv: () => readCrawlerEnv(file), verifyTimezone: vi.fn() });
  expect(await adapter.preflight(path, null)).toEqual({
    link: null, instagramRoot: null, apps: [{ name: 'agamajung-local-worker', root: legacy, managed: false }],
  });
  inventory = [...inventory, entry('agamajung-collector-scheduler')];
  await expect(adapter.preflight(path, null)).rejects.toThrow('crawler_competing_scheduler');
  inventory.pop();
  enabled = true;
  await expect(adapter.preflight(path, null)).rejects.toThrow('crawler_competing_watchdog');
});

test('Wrangler gets credentials only for authenticated commands and reports pending D1 SQL', async () => {
  const dir = tmp(), file = join(dir, 'token'), output = join(dir, 'upload.jsonl');
  writeFileSync(file, 'fixture-only-token\n', { mode: 0o600 });
  copyFileSync('wrangler.jsonc', join(dir, 'wrangler.jsonc'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations/0001_old.sql'), 'CREATE TABLE old (id TEXT);');
  writeFileSync(join(dir, 'migrations/0002_new.sql'), 'ALTER TABLE old ADD COLUMN name TEXT;');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'inherited-token');
  vi.stubEnv('COLLECTOR_REVIEW_TOKEN', 'inherited-crawler-token');
  const run = vi.fn<Command>(async (_, args, options) => {
    expect(options.env?.COLLECTOR_REVIEW_TOKEN).toBeUndefined();
    expect(options.env?.WRANGLER_WRITE_LOGS).toBe('false');
    expect(args.slice(-2)).toEqual(['--config', join(dir, 'wrangler.jsonc')]);
    if (args.includes('--dry-run')) {
      expect(options.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
      return { code: 0, stdout: '' };
    }
    expect(options.env?.CLOUDFLARE_API_TOKEN).toBe('fixture-only-token');
    expect(options.env?.CLOUDFLARE_ACCOUNT_ID).toMatch(/^[a-f0-9]{32}$/);
    if (args.includes('status')) {
      expect(options.env?.WRANGLER_LOG).toBe('log');
      return { code: 0, stdout: JSON.stringify({ versions: [{ version_id: previous, percentage: 100 }] }) };
    }
    if (args.includes('execute')) {
      const sql = args[args.indexOf('--command') + 1];
      const name = sql.includes('sqlite_schema') ? 'd1_migrations' : '0001_old.sql';
      return { code: 0, stdout: JSON.stringify([{ success: true, results: [{ name }] }]) };
    }
    if (args.includes('upload')) expect(options.env?.WRANGLER_OUTPUT_FILE_PATH).toBe(output);
    return { code: 0, stdout: '' };
  });
  const site = siteAdapter(run, dir, { tokenFile: file, locked: false });
  await site.bundle(dir);
  expect(await site.serving(dir)).toBe(previous);
  expect(await site.pending(dir)).toEqual([{ name: '0002_new.sql', destructive: true }]);
  await site.migrate(dir);
  await site.upload(dir, output);
  await site.promote(dir, candidate);
  await site.rollback(dir, previous);
  expect(run.mock.calls.map(([, args]) => args.slice(1, -2))).toEqual([
    ['versions', 'upload', '--dry-run', '--name', 'agamajung'],
    ['deployments', 'status', '--name', 'agamajung', '--json'],
    ['d1', 'execute', 'agamajung', '--remote', '--json', '--command', expect.stringContaining('sqlite_schema')],
    ['d1', 'execute', 'agamajung', '--remote', '--json', '--command', 'SELECT name FROM d1_migrations'],
    ['d1', 'migrations', 'apply', 'agamajung', '--remote'],
    ['versions', 'upload', '--name', 'agamajung'],
    ['versions', 'deploy', candidate + '@100%', '--name', 'agamajung', '--yes'],
    ['rollback', previous, '--name', 'agamajung', '--yes'],
  ]);
});

test('candidate and rollback probes validate their distinct homepage contracts and deals JSON', async () => {
  const send = vi.fn<typeof fetch>(async (url, request) =>
    String(url).endsWith('/api/v1/deals?limit=5') ? Response.json({ data: [], next_cursor: null }) :
      new Headers(request?.headers).get('Accept') === 'application/json' ? Response.json({ ok: true }) :
        new Response('<html>success</html>', { headers: { 'Content-Type': 'text/html' } }));
  expect(await siteProbe(false, send)).toBe(true);
  expect(await siteProbe(true, send)).toBe(true);
  expect(send.mock.calls).toHaveLength(4);
  send.mockResolvedValueOnce(Response.json({ ok: false }));
  expect(await siteProbe(false, send)).toBe(false);
  send.mockResolvedValueOnce(Response.redirect('https://example.com/'));
  expect(await siteProbe(false, send)).toBe(false);
});

test('copy audit includes changed Korean text, removed files, and the first snapshot', async () => {
  const root = tmp(), git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('fixture git command failed');
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(root, 'lib/copy'), { recursive: true });
  writeFileSync(join(root, 'lib/copy/기존.ts'), 'export const copy = "첫 문구";\n');
  writeFileSync(join(root, 'lib/auth-copy.ts'), 'export const previous = "이전 문구";\n');
  git('add', '.'); git('commit', '-qm', 'fixture initial');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'lib/copy/기존.ts', 'lib/copy/이동.ts');
  rmSync(join(root, 'lib/auth-copy.ts'));
  writeFileSync(join(root, 'lib/site-copy.ts'), 'export const next = "새 문구";\n');
  git('add', '.'); git('commit', '-qm', 'fixture update');
  const head = git('rev-parse', 'HEAD'), adapter = gitAdapter(command, join(root, '.git'), join(root, 'runtime'));
  const diff = await adapter.copy(base, head);
  for (const item of [base, head, 'rename from lib/copy/기존.ts', 'rename to lib/copy/이동.ts', '이전 문구', '새 문구']) expect(diff).toContain(item);
  expect(await adapter.copy(null, head)).toContain('First snapshot (no previous site SHA)');
  const release = runtimePath(join(root, 'runtime'), head);
  await adapter.prepare(release, head);
  expect(readFileSync(join(release, 'lib/site-copy.ts'), 'utf8')).toContain('새 문구');
  await expect(adapter.verify(release, base)).rejects.toThrow('worktree_identity_mismatch');
  await adapter.remove(release, head);
  expect(existsSync(release)).toBe(false);
});

test('install dry run needs neither a repository nor a reachable PM2', () => {
  const root = tmp(), bin = join(root, 'bin');
  mkdirSync(bin);
  const script = join(root, 'install.sh');
  copyFileSync('tools/auto-deploy/install.sh', script);
  for (const name of ['git', 'pm2', 'npm', 'mkdir', 'flock', 'curl', 'node']) {
    writeFileSync(join(bin, name), '#!/bin/sh\n/usr/bin/touch "$HOME/side-effect"\nexit 99\n', { mode: 0o700 });
  }
  const result = spawnSync('/bin/bash', [script, '--dry-run'], { cwd: root, env: { PATH: bin + ':/usr/bin:/bin', HOME: root, NODE_ENV: 'test' }, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('agamajung-auto-deploy');
  expect(result.stdout).toContain('pm2 save');
  expect(readdirSync(root).sort()).toEqual(['bin', basename(script)]);
  expect(existsSync(join(root, 'side-effect'))).toBe(false);
});

test('reinstalling the same healthy controller preserves its PID and still saves PM2', () => {
  const root = tmp(), bin = join(root, 'bin'), source = join(root, 'source');
  const state = join(root, 'auto-deploy'), archive = join(root, 'archive');
  const shellFiles = 'tools/auto-deploy';
  for (const dir of [bin, join(source, shellFiles), join(archive, shellFiles), join(source, 'node_modules/node/bin')]) {
    mkdirSync(dir, { recursive: true });
  }
  const script = join(source, shellFiles, 'install.sh');
  // Relocate only the installation root. The fixture runs the installer with
  // real filesystem operations and spies for Git, npm and PM2.
  writeFileSync(script, readFileSync('tools/auto-deploy/install.sh', 'utf8')
    .replace(/^root=\/workspace\/agamajung\/auto-deploy$/m, 'root=' + JSON.stringify(state)));
  writeFileSync(join(archive, shellFiles, 'run.sh'), '#!/bin/sh\n', { mode: 0o700 });
  const tar = spawnSync('tar', ['-cf', join(root, 'controller.tar'), '-C', archive, '.']);
  expect(tar.status).toBe(0);
  symlinkSync(join(process.cwd(), 'node_modules/node/bin/node'), join(source, 'node_modules/node/bin/node'));
  writeFileSync(join(bin, 'git'), `#!/bin/sh
shift 2
case "$1" in
  rev-parse) echo ${first} ;;
  config) echo https://github.com/SUNBURN-Golden/geunbon-baby.git ;;
  merge-base) test "$4" = refs/remotes/origin/main ;;
  archive) cat "$HOME/controller.tar" ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
set -eu
test "$*" = "ci --include=dev"
echo ci >> "$HOME/npm-calls"
mkdir -p node_modules/node/bin
ln -s "$HOME/source/node_modules/node/bin/node" node_modules/node/bin/node
`, { mode: 0o700 });
  writeFileSync(join(bin, 'pm2'), `#!/bin/sh
set -eu
echo "$1" >> "$HOME/pm2-calls"
case "$1" in
  jlist) if test -f "$HOME/jlist"; then cat "$HOME/jlist"; else echo '[]'; fi ;;
  start)
    cwd=${'$'}{2%/tools/auto-deploy/ecosystem.config.cjs}
    printf '[{"name":"agamajung-auto-deploy","pid":4242,"pm2_env":{"pm_cwd":"%s","pm_exec_path":"%s/tools/auto-deploy/run.sh","status":"online"}}]\n' "$cwd" "$cwd" > "$HOME/jlist"
    ;;
  delete) rm "$HOME/jlist" ;;
  save) ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  const install = () => spawnSync('/bin/bash', [script], {
    env: { HOME: root, PATH: bin + ':/usr/bin:/bin', NODE_ENV: 'test' }, encoding: 'utf8',
  });
  const firstRun = install();
  expect(firstRun.status, firstRun.stderr).toBe(0);
  const registration = readFileSync(join(root, 'jlist'), 'utf8');
  expect(JSON.parse(registration)[0]).toMatchObject({ pid: 4242, pm2_env: { pm_cwd: join(state, 'controllers', first) } });
  const secondRun = install();
  expect(secondRun.status, secondRun.stderr).toBe(0);
  expect(readFileSync(join(root, 'pm2-calls'), 'utf8').trim().split('\n')).toEqual(['jlist', 'start', 'jlist', 'save', 'jlist', 'save']);
  expect(readFileSync(join(root, 'jlist'), 'utf8')).toBe(registration);
  expect(readFileSync(join(root, 'npm-calls'), 'utf8')).toBe('ci\n');
});
