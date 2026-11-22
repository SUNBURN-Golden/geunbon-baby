import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { crawlerAdapter, currentTarget } from '../tools/auto-deploy/crawler';
import { command, type Command } from '../tools/auto-deploy/command';
import { identity } from '../crawler/src/process-identity';
import { readCrawlerEnv } from '../crawler/managed-env.mjs';

// The crawler adapter verifies local-worker readiness through site.probe.
// Substitute only that loopback call; the suite's socket ban stays in force.
const h = vi.hoisted(() => ({ readiness: vi.fn() }));
vi.mock('../tools/auto-deploy/site', async importOriginal => ({
  ...(await importOriginal<typeof import('../tools/auto-deploy/site')>()),
  probe: h.readiness,
}));

type Entry = { name: string; script: string; args: string[]; cron_restart?: string };
type FakeApp = Entry & {
  cwd: string; interpreter: string; node_args: string[]; autostart: boolean; autorestart: boolean;
  restart_delay?: number; env: Record<string, string>;
};
type FakeProcess = { name: string; pid: number; pm2_env: { name: string; status?: string; [key: string]: unknown } };
const ecosystem = createRequire(import.meta.url)('../crawler/ecosystem.all.config.cjs') as {
  inventory: Entry[]; app(entry: Entry, root?: string, preloadRoot?: string): FakeApp;
};

const temporary: string[] = [];
const children: ChildProcess[] = [];
beforeEach(() => {
  // KST 12:00 is outside every scheduled slot and its ±2 minute cutover guard.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T03:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'auto-deploy-crawler-')); temporary.push(root);
  const runtime = join(root, 'runtime'), state = join(root, 'state');
  const candidate = join(runtime, 'main-candidate'), legacy = join(root, 'legacy');
  const link = join(runtime, 'current'), dbDir = join(root, 'db'), raw = join(root, 'raw'), deep = join(root, 'deep');
  for (const dir of [runtime, state, join(candidate, 'crawler/deepseek-web'), join(legacy, 'crawler/deepseek-web'), dbDir, raw, deep]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const file of ['ecosystem.all.config.cjs', 'pm2-cron.cjs', 'load-managed-env.mjs', 'pm2-cron-gate.mjs', 'local-worker.mjs', 'deepseek-web/run.mjs']) {
    copyFileSync(join('crawler', file), join(candidate, 'crawler', file));
  }
  writeFileSync(join(legacy, 'crawler/local-worker.mjs'), '');
  writeFileSync(join(legacy, 'crawler/deepseek-web/run.mjs'), '');
  for (const dir of [candidate, legacy]) mkdirSync(join(dir, 'node_modules/node/bin'), { recursive: true });
  symlinkSync(process.execPath, join(candidate, 'node_modules/node/bin/node'));
  // savedRegistration requires a regular file, and verify compares /proc/exe
  // against it: a hardlink (or copy across devices) satisfies both.
  const legacyNode = join(legacy, 'node_modules/node/bin/node');
  try { linkSync(process.execPath, legacyNode); } catch { copyFileSync(process.execPath, legacyNode); }
  const db = join(dbDir, 'collector.sqlite');
  writeFileSync(db, '', { mode: 0o600 });
  const envFile = join(root, 'fixture.env');
  writeFileSync(envFile, [
    'COLLECTOR_DB=' + db, 'COLLECTOR_RAW_DIR=' + raw, 'DEEPSEEK_WEB_STATE_DIR=' + deep,
    'DEEPSEEK_API_KEY=fixture', 'COLLECTOR_INTAKE_TOKEN=' + 'i'.repeat(24),
    'COLLECTOR_REVIEW_TOKEN=' + 'r'.repeat(24), 'COLLECTOR_EXTENSION_ORIGIN=chrome-extension://' + 'a'.repeat(32),
  ].join('\n'), { mode: 0o600 });
  vi.stubEnv('PM2_HOME', state);
  return { root, state, candidate, legacy, link, db, deep, envFile, entries: ecosystem.inventory };
}

// Models the installed PM2 daemon (God.handleExit / Worker.registerCron /
// API.dump): gated cron apps exit 0 outside their slot and land at pid 0 with
// status 'waiting restart' whenever restart_delay is set, even though
// autorestart:false schedules no restart; save rotates dump.pm2 -> .bak.
function fakePm2(f: ReturnType<typeof fixture>, {
  poison = new Set<string>(), staleHeartbeat = false, dormantStatus = 'waiting restart', exercisePreloads = false,
}: { poison?: Set<string>; staleHeartbeat?: boolean; dormantStatus?: string; exercisePreloads?: boolean } = {}) {
  let inventory: FakeProcess[] = [];
  const starts: FakeApp[][] = [];
  const childByName = new Map<string, ChildProcess>();
  let saves = 0;
  const dumpPath = join(f.state, 'dump.pm2'), backupPath = join(f.state, 'dump.pm2.bak');
  function launch(app: FakeApp, env: Record<string, string>) {
    if (!exercisePreloads) return spawn(app.interpreter, ['-e', 'setInterval(() => {}, 1000)'], { cwd: app.cwd, stdio: 'ignore' });
    const args = [...app.node_args];
    const gate = args.indexOf(join(app.cwd, 'crawler/pm2-cron-gate.mjs'));
    // Observe the file values after the real preload and before the real time gate.
    args.splice(gate === -1 ? args.length : gate - 1, 0, '--import', join(f.root, 'verify-preload.mjs'));
    return spawn(app.interpreter, [...args, app.script, ...app.args], {
      cwd: app.cwd, env: { NODE_ENV: 'test', ...env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  }
  async function register(app: FakeApp) {
    const env: Record<string, string> = {
      HOME: process.env.HOME!, PATH: process.env.PATH!, PWD: app.cwd, PM2_HOME: f.state,
      PM2_USAGE: 'CLI', unique_id: randomUUID(), ...app.env,
      ...(poison.has(app.name) ? { COLLECTOR_DB: f.db } : {}),
    };
    const base = {
      name: app.name, pm_cwd: app.cwd, pm_exec_path: app.script, exec_interpreter: app.interpreter,
      args: app.args, node_args: app.node_args, cron_restart: app.cron_restart, exec_mode: 'fork_mode',
      autorestart: app.autorestart, autostart: app.autostart, restart_delay: app.restart_delay,
      pm_uptime: Date.now(), env,
    };
    const child = !app.cron_restart || exercisePreloads ? launch(app, env) : null;
    if (child) children.push(child);
    if (app.cron_restart) {
      if (child) await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('fixture cron preload or gate failed')));
      });
      inventory.push({ name: app.name, pid: 0, pm2_env: { ...base, status: dormantStatus, exit_code: 0 } });
      return;
    }
    childByName.set(app.name, child!);
    await new Promise<void>((resolve, reject) => {
      child!.once(exercisePreloads ? 'message' : 'spawn', () => resolve());
      child!.once('error', reject);
      child!.once('exit', () => reject(new Error('fixture process failed to start')));
    });
    if (app.name === 'agamajung-deepseek-web') {
      const owner = staleHeartbeat ? identity(process.pid) : identity(child!.pid!);
      if (app.cwd === f.link) {
        writeFileSync(join(f.deep, 'daemon-heartbeat.json'), JSON.stringify({ at: Date.now(), identity: owner }));
      } else {
        const db = new DatabaseSync(join(f.deep, 'writer-ownership.sqlite'));
        try {
          db.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, value TEXT)');
          db.prepare('INSERT OR REPLACE INTO owner (id, value) VALUES (1, ?)').run(JSON.stringify(owner));
        } finally { db.close(); }
      }
    }
    inventory.push({ name: app.name, pid: child!.pid!, pm2_env: { ...base, status: 'online' } });
  }
  const run: Command = async (exe, args, options) => {
    if (exe === 'pm2') {
      const [verb, target] = args;
      if (verb === 'jlist') return { code: 0, stdout: JSON.stringify(inventory) };
      if (verb === 'delete') {
        childByName.get(target)?.kill('SIGKILL'); childByName.delete(target);
        inventory = inventory.filter(p => p.name !== target);
        return { code: 0, stdout: '' };
      }
      if (verb === 'start') {
        const config = JSON.parse(readFileSync(target, 'utf8').replace(/^module\.exports = /, '')) as { apps: FakeApp[] };
        starts.push(config.apps);
        for (const app of config.apps) await register(app);
        return { code: 0, stdout: '' };
      }
      if (verb === 'save') {
        saves++;
        if (existsSync(dumpPath)) copyFileSync(dumpPath, backupPath);
        writeFileSync(dumpPath, JSON.stringify(inventory.map(p => p.pm2_env)));
        return { code: 0, stdout: '' };
      }
    }
    if (exe === 'systemctl') return args.includes('show')
      ? { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n' }
      : { code: 0, stdout: 'disabled' };
    if (exe === 'ln' || exe === process.execPath) return command(exe, args, options);
    throw new Error('unexpected command: ' + exe + ' ' + args.join(' '));
  };
  return {
    run, starts,
    saves: () => saves,
    inventory: () => inventory,
    pidOf: (name: string) => inventory.find(p => p.name === name)?.pid ?? 0,
    seed: (processes: FakeProcess[]) => { inventory = processes; },
    async resurrect() {
      for (const child of childByName.values()) child.kill('SIGKILL');
      childByName.clear();
      inventory = [];
      for (const saved of JSON.parse(readFileSync(dumpPath, 'utf8'))) {
        await register({
          name: saved.name, cwd: saved.pm_cwd, script: saved.pm_exec_path, interpreter: saved.exec_interpreter,
          args: saved.args, node_args: saved.node_args, cron_restart: saved.cron_restart, restart_delay: saved.restart_delay,
          autorestart: saved.autorestart, autostart: saved.autostart, env: saved.env,
        });
      }
    },
  };
}

const seed = (f: ReturnType<typeof fixture>, root: string): FakeProcess[] => f.entries.map(entry => {
  const app = ecosystem.app(entry, root);
  return {
    name: entry.name, pid: entry.cron_restart ? 0 : 4_000_001,
    pm2_env: {
      name: entry.name, pm_cwd: app.cwd, pm_exec_path: app.script, exec_interpreter: app.interpreter,
      args: app.args, node_args: app.node_args, cron_restart: entry.cron_restart, exec_mode: 'fork_mode',
      autorestart: app.autorestart, autostart: app.autostart,
      status: entry.cron_restart ? 'waiting restart' : 'online', env: { ...app.env },
    },
  };
});

function adapterFor(f: ReturnType<typeof fixture>, pm2: ReturnType<typeof fakePm2>) {
  h.readiness.mockImplementation(async () => JSON.stringify({
    data: { ready: true, identity: identity(pm2.pidOf('agamajung-local-worker')) },
  }));
  return crawlerAdapter(pm2.run, f.root, f.state, f.candidate, {
    readEnv: () => readCrawlerEnv(f.envFile), verifyTimezone: vi.fn(), sleep: async () => {},
  });
}

const legacySnapshot = (f: ReturnType<typeof fixture>) => ({
  link: f.legacy, apps: f.entries.map(entry => ({ name: entry.name, root: f.legacy, managed: false })), instagramRoot: null,
});

function expectDormantCron(f: ReturnType<typeof fixture>, pm2: ReturnType<typeof fakePm2>, status: string) {
  const inventory = pm2.inventory();
  expect(inventory.map(p => p.name).sort()).toEqual(f.entries.map(entry => entry.name).sort());
  for (const entry of f.entries) {
    const p = inventory.find(row => row.name === entry.name)!;
    if (entry.cron_restart) {
      expect(p.pid).toBe(0);
      expect(p.pm2_env.status).toBe(status);
    } else {
      expect(p.pid).toBeGreaterThan(0);
      expect(p.pm2_env.status).toBe('online');
    }
  }
}

test.each(['waiting restart', 'stopped'])('cutover adopts gated cron apps dormant at pid 0 (%s) and saves a sanitized dump', async status => {
  const f = fixture(), pm2 = fakePm2(f, { dormantStatus: status });
  pm2.seed(seed(f, f.legacy));
  const adapter = adapterFor(f, pm2);
  const snapshot = await adapter.preflight(f.candidate, null);
  expect(snapshot).toMatchObject({ link: null, instagramRoot: null });
  expect(snapshot.apps).toHaveLength(f.entries.length);
  await adapter.cutover(f.candidate, snapshot);
  expect(currentTarget(f.link)).toBe(f.candidate);
  expectDormantCron(f, pm2, status);
  expect(pm2.starts).toHaveLength(1);
  for (const app of pm2.starts[0]) {
    expect(app.cwd).toBe(f.link);
    expect(app.node_args).toContain(join(f.link, 'crawler/load-managed-env.mjs'));
    if (app.cron_restart) expect(app.node_args).toContain(join(f.link, 'crawler/pm2-cron-gate.mjs'));
  }
  expect(h.readiness).toHaveBeenCalledWith('http://127.0.0.1:4318/v1/readiness', 'application/json', {
    Authorization: 'Bearer ' + 'r'.repeat(24),
  });
  // First adoption saves twice so the fallback dump is sanitized as well.
  expect(pm2.saves()).toBe(2);
  const secrets = Object.values(readCrawlerEnv(f.envFile));
  for (const file of ['dump.pm2', 'dump.pm2.bak']) {
    const text = readFileSync(join(f.state, file), 'utf8');
    expect(JSON.parse(text)).toHaveLength(f.entries.length);
    for (const value of secrets) expect(text).not.toContain(value);
  }
}, 20_000);

test('reordered candidate declarations pass and PM2 receives registrations from the installed inventory', async () => {
  const f = fixture(), pm2 = fakePm2(f);
  const config = join(f.candidate, 'crawler/ecosystem.all.config.cjs');
  writeFileSync(config, readFileSync(config, 'utf8') + `
module.exports = { apps: module.exports.apps.reverse().map(app => Object.fromEntries(Object.entries(app).reverse())),
  inventory: [], app() { throw new Error('candidate must not generate registrations'); } };
`);
  const adapter = adapterFor(f, pm2);
  await adapter.cutover(f.candidate, await adapter.preflight(f.candidate, null));
  expect(pm2.starts).toEqual([f.entries.map(entry => ecosystem.app(entry, f.link))]);
});

test.each([
  ['a missing app', 'apps.pop()'],
  ['a duplicate name', 'apps[1] = apps[0]'],
  ['an unapproved app', "apps[0].name = 'agamajung-dev-daemon'"],
  ['an unapproved script', "apps[0].script = '/tmp/unapproved.mjs'"],
  ['an unapproved cwd', "apps[0].cwd = '/tmp'"],
  ['an unapproved interpreter', "apps[0].interpreter = '/usr/bin/node'"],
  ['an unapproved argument', "apps[0].args.push('--dry-run')"],
  ['a missing preload', 'apps[0].node_args.splice(2)'],
  ['an unapproved schedule', "apps[1].cron_restart = '* * * * *'"],
  ['an unapproved execution setting', 'apps[0].instances = 2'],
])('preflight rejects %s before cutover', async (_, change) => {
  const f = fixture(), pm2 = fakePm2(f);
  const config = join(f.candidate, 'crawler/ecosystem.all.config.cjs');
  writeFileSync(config, readFileSync(config, 'utf8') + '\nconst { apps } = module.exports;\n' + change + '\n');
  await expect(adapterFor(f, pm2).preflight(f.candidate, null)).rejects.toThrow('crawler_ecosystem_mismatch');
  expect(pm2.starts).toHaveLength(0);
  expect(currentTarget(f.link)).toBeNull();
});

test('recreates a missing app and resurrects all six with private preloads and gated schedules', async () => {
  const f = fixture(), pm2 = fakePm2(f, { exercisePreloads: true });
  symlinkSync(join(process.cwd(), 'node_modules/tsx'), join(f.candidate, 'node_modules/tsx'));
  writeFileSync(join(f.candidate, 'crawler/managed-env.mjs'), readFileSync('crawler/managed-env.mjs', 'utf8')
    .replace("'/home/box/.secrets/agamajung_crawler.env'", JSON.stringify(f.envFile)));
  // Force an off-slot time in the fixture children so the real gate must exit.
  writeFileSync(join(f.root, 'verify-preload.mjs'), `
    if (process.env.COLLECTOR_DB !== ${JSON.stringify(f.db)} || process.env.DEEPSEEK_API_KEY !== 'fixture') process.exit(41);
    globalThis.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-11-20T03:00:00Z'])); }
    };
  `);
  for (const script of ['local-worker.mjs', 'deepseek-web/run.mjs']) {
    writeFileSync(join(f.candidate, 'crawler', script), `
      if (process.env.AGAMAJUNG_PM2_JOB) process.exit(42);
      process.send('fixture-ready');
      setInterval(() => {}, 1000);
    `);
  }
  pm2.seed(seed(f, f.legacy).filter(p => p.name !== 'agamajung-collect'));
  const adapter = adapterFor(f, pm2);
  const snapshot = await adapter.preflight(f.candidate, null);
  expect(snapshot.apps).toHaveLength(5);
  await adapter.cutover(f.candidate, snapshot);
  expectDormantCron(f, pm2, 'waiting restart');
  const saved = readFileSync(join(f.state, 'dump.pm2'), 'utf8');
  for (const value of Object.values(readCrawlerEnv(f.envFile))) expect(saved).not.toContain(value);
  const localPid = pm2.pidOf('agamajung-local-worker');
  await pm2.resurrect();
  expect(pm2.pidOf('agamajung-local-worker')).not.toBe(localPid);
  expectDormantCron(f, pm2, 'waiting restart');
  for (const entry of f.entries) {
    const record = pm2.inventory().find(p => p.name === entry.name)!.pm2_env;
    expect(record.node_args).toEqual(ecosystem.app(entry, f.link).node_args);
    expect(record.cron_restart).toBe(entry.cron_restart);
  }
}, 20_000);

test('restore recovers legacy registrations with dormant cron apps and the controller preload', async () => {
  const f = fixture(), pm2 = fakePm2(f);
  symlinkSync(f.candidate, f.link);
  pm2.seed(seed(f, f.link));
  const adapter = adapterFor(f, pm2);
  await adapter.restore(f.candidate, legacySnapshot(f));
  expect(currentTarget(f.link)).toBe(f.legacy);
  expectDormantCron(f, pm2, 'waiting restart');
  expect(pm2.starts).toHaveLength(1);
  for (const app of pm2.starts[0]) {
    expect(app.cwd).toBe(f.legacy);
    expect(app.node_args).toContain(join(f.candidate, 'crawler/load-managed-env.mjs'));
    if (app.cron_restart) expect(app.node_args).toContain(join(f.candidate, 'crawler/pm2-cron-gate.mjs'));
  }
  expect(pm2.saves()).toBe(2);
  for (const file of ['dump.pm2', 'dump.pm2.bak']) {
    const records = JSON.parse(readFileSync(join(f.state, file), 'utf8')) as { pm_cwd: string }[];
    expect(records).toHaveLength(f.entries.length);
    for (const record of records) expect(record.pm_cwd).toBe(f.legacy);
  }
}, 20_000);

test('a dormant --no-autostart scheduler is benign only without a pending restart', async () => {
  const f = fixture(), pm2 = fakePm2(f);
  const adapter = adapterFor(f, pm2);
  const scheduler = (overrides: Record<string, unknown> = {}): FakeProcess => ({
    name: 'agamajung-collector-scheduler', pid: 0,
    pm2_env: {
      name: 'agamajung-collector-scheduler', pm_cwd: f.legacy,
      pm_exec_path: join(f.legacy, 'crawler/collector-scheduler.mjs'), args: ['schedule'], exec_mode: 'fork_mode',
      autostart: false, autorestart: false, status: 'waiting restart', env: {}, ...overrides,
    },
  });
  pm2.seed([...seed(f, f.legacy), scheduler()]);
  await expect(adapter.preflight(f.candidate, null)).resolves.toMatchObject({ link: null });
  pm2.seed([...seed(f, f.legacy), scheduler({ status: 'stopped' })]);
  await expect(adapter.preflight(f.candidate, null)).resolves.toMatchObject({ link: null });
  for (const overrides of [{ status: 'online' }, { autorestart: true }, { autostart: true, status: 'stopped' }, { cron_restart: '20 9,15,21 * * *' }]) {
    pm2.seed([...seed(f, f.legacy), scheduler(overrides)]);
    await expect(adapter.preflight(f.candidate, null)).rejects.toThrow('crawler_competing_scheduler');
  }
  // The saved dump is held to the same rule before resurrection can adopt it.
  pm2.seed(seed(f, f.legacy));
  writeFileSync(join(f.state, 'dump.pm2'), JSON.stringify([scheduler().pm2_env]));
  await expect(adapter.preflight(f.candidate, null)).resolves.toMatchObject({ link: null });
  writeFileSync(join(f.state, 'dump.pm2'), JSON.stringify([scheduler({ status: 'online' }).pm2_env]));
  await expect(adapter.preflight(f.candidate, null)).rejects.toThrow('crawler_competing_scheduler');
}, 20_000);

test('cutover refuses a PM2 registration that leaked crawler secrets into its env', async () => {
  const f = fixture(), pm2 = fakePm2(f, { poison: new Set(['agamajung-collect']) });
  pm2.seed(seed(f, f.legacy));
  const adapter = adapterFor(f, pm2);
  const snapshot = await adapter.preflight(f.candidate, null);
  await expect(adapter.cutover(f.candidate, snapshot)).rejects.toThrow('crawler_verification_failed');
  expect(pm2.saves()).toBe(0);
}, 20_000);

test('a running cron job outside its slot keeps cutover waiting without touching the link', async () => {
  const f = fixture(), pm2 = fakePm2(f);
  const busy = seed(f, f.legacy);
  const discover = busy.find(p => p.name === 'agamajung-discover')!;
  discover.pid = 4_000_002; discover.pm2_env.status = 'online';
  pm2.seed(busy);
  const adapter = adapterFor(f, pm2);
  const snapshot = await adapter.preflight(f.candidate, null);
  await expect(adapter.cutover(f.candidate, snapshot)).rejects.toThrow('crawler_cutover_waiting_for_jobs');
  expect(currentTarget(f.link)).toBeNull();
  expect(pm2.starts).toHaveLength(0);
}, 20_000);

test('restore fails closed when the legacy DeepSeek writer identity does not match', async () => {
  const f = fixture(), pm2 = fakePm2(f, { staleHeartbeat: true });
  symlinkSync(f.candidate, f.link);
  pm2.seed(seed(f, f.link));
  const adapter = adapterFor(f, pm2);
  await expect(adapter.restore(f.candidate, legacySnapshot(f))).rejects.toThrow('crawler_restore_verify_failed');
  expect(pm2.saves()).toBe(0);
}, 20_000);
