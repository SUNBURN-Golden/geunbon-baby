import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { readCrawlerEnv } from '../../crawler/managed-env.mjs';
import { identity, inspectIdentity, type Identity } from '../../crawler/src/process-identity';
import { ownerOf, readLock } from '../../crawler/src/run-lock';
import { checked, hostEnv, nodeEnv, type Command } from './command';
import { probe } from './site';
import { DeployError, syncDirectory, type CrawlerSnapshot, type Registration } from './state';

type Entry = { name: string; script: string; args: string[]; cron_restart?: string };
type App = Entry & { cwd: string; interpreter: string; node_args: string[]; autostart: boolean; autorestart: boolean; env: Record<string, string> };
type PM2Env = {
  name: string; pm_cwd: string; pm_exec_path: string; args?: string[]; cron_restart?: string;
  exec_interpreter: string; node_args?: string[]; autorestart: boolean; autostart: boolean; status?: string;
  env?: Record<string, string>; pm_uptime?: number; exec_mode?: string;
};
type Process = { name: string; pid: number; pm2_env: PM2Env };
const require = createRequire(import.meta.url);
const ecosystem = require('../../crawler/ecosystem.all.config.cjs') as {
  apps: App[]; inventory: Entry[]; instagram: Entry; app(entry: Entry, root?: string, preloadRoot?: string): App;
};
const schedule = require('../../crawler/pm2-cron.cjs') as {
  kstMinute(now: Date): number; slotMinutes(name: string): number[];
};
const entries = [...ecosystem.inventory, ecosystem.instagram];
const known = new Map(entries.map(entry => [entry.name, entry]));
const approvedApps = new Map(ecosystem.apps.map(app => [app.name, app]));
const sameList = (left: unknown, right: string[]) => JSON.stringify(left ?? []) === JSON.stringify(right);
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

export function currentTarget(link: string) {
  const entry = lstatSync(link, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isSymbolicLink()) throw new DeployError('runtime_link_invalid');
  return resolve(dirname(link), readlinkSync(link));
}

export async function switchRuntime(run: Command, link: string, target: string | null) {
  const previous = currentTarget(link);
  if (previous === target) return;
  if (target === null) {
    unlinkSync(link);
  } else {
    if (realpathSync(target) !== target || !statSync(target).isDirectory()) throw new DeployError('runtime_target_invalid');
    const temporary = join(dirname(link), '.current-' + randomUUID());
    try {
      await checked(run, 'runtime_symlink_failed', 'ln', ['-sfn', '--', target, temporary], {});
      if (currentTarget(link) !== previous) throw new DeployError('crawler_runtime_drift');
      renameSync(temporary, link);
    } finally { rmSync(temporary, { force: true }); }
  }
  syncDirectory(dirname(link));
}

function validRoot(root: string, workspace: string) {
  if (!isAbsolute(root) || !within(workspace, root) || root === workspace || realpathSync(root) !== root) {
    throw new DeployError('crawler_root_invalid');
  }
  return root;
}

function matches(p: PM2Env, app: App) {
  return p.pm_cwd === app.cwd && p.pm_exec_path === app.script && p.exec_interpreter === app.interpreter &&
    sameList(p.args, app.args) && sameList(p.node_args, app.node_args) &&
    (!p.cron_restart && !app.cron_restart || p.cron_restart === app.cron_restart) &&
    p.exec_mode === 'fork_mode' && p.autorestart === app.autorestart && p.autostart === app.autostart &&
    Object.entries(app.env).every(([key, value]) => p.env?.[key] === value);
}

function assertEnvironment(p: PM2Env, app: App, secrets: Record<string, string>) {
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'PATH', 'PM2_HOME', ...Object.keys(app.env), 'PWD', 'PM2_USAGE', 'PM2_JSON_PROCESSING', 'PM2_INTERACTOR_PROCESSING', 'PM2_DISCRETE_MODE', 'unique_id', app.name]);
  if (!p.env || Object.keys(p.env).some(key => !allowed.has(key)) ||
    Object.entries(secrets).some(([key, value]) =>
      (Object.hasOwn(p, key) || Object.hasOwn(p.env!, key)) &&
      (!Object.hasOwn(app.env, key) || value === p.env![key] && value !== app.env[key]))) throw new DeployError('crawler_pm2_environment_invalid');
}

export function quietWindow(now: Date, instagram: boolean) {
  const minute = schedule.kstMinute(now);
  return entries.filter(entry => entry.cron_restart && (instagram || entry !== ecosystem.instagram))
    .every(entry => schedule.slotMinutes(entry.name).every(slot => Math.abs(minute - slot) > 2));
}

export function crawlerAdapter(run: Command, workspace: string, stateRoot: string, stableRoot: string, {
  readEnv = readCrawlerEnv, verifyTimezone, sleep = (ms: number) => setTimeout(ms),
}: { readEnv?: typeof readCrawlerEnv; verifyTimezone?: () => void; sleep?: (ms: number) => Promise<void> } = {}) {
  const link = join(workspace, 'runtime/current');
  const pmHome = process.env.PM2_HOME ?? join(homedir(), '.pm2');
  const pmEnv = () => {
    const { HOME, USER, LOGNAME, LANG, LC_ALL, PATH, PM2_HOME } = hostEnv();
    return { HOME, USER, LOGNAME, LANG, LC_ALL, PATH, PM2_HOME };
  };
  const pm2 = (code: string, ...args: string[]) => checked(run, code, 'pm2', args, { env: pmEnv(), timeout: 180_000, lockFile: join(stateRoot, 'pm2.lock') });
  const currentApps = async () => {
    const data: Process[] = JSON.parse(await pm2('pm2_inventory_failed', 'jlist'));
    if (!Array.isArray(data) || data.some(p => !p.pm2_env || p.name !== p.pm2_env.name)) {
      throw new DeployError('pm2_inventory_failed');
    }
    return data;
  };
  const dump = (backup = false): PM2Env[] => {
    const path = join(pmHome, backup ? 'dump.pm2.bak' : 'dump.pm2');
    if (!lstatSync(path, { throwIfNoEntry: false })) return [];
    const result = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(result)) throw new DeployError('pm2_dump_invalid');
    return result;
  };

  function savedRegistration(env: PM2Env): Registration {
    const entry = known.get(env.name)!;
    const root = env.pm_cwd;
    const managed = root === link;
    if (!managed) validRoot(root, workspace);
    if (!managed && (!lstatSync(join(root, entry.script), { throwIfNoEntry: false })?.isFile() ||
        !lstatSync(join(root, 'node_modules/node/bin/node'), { throwIfNoEntry: false })?.isFile())) {
      throw new DeployError('crawler_recovery_entrypoint_invalid');
    }
    if (env.pm_exec_path !== join(root, entry.script) || env.exec_mode !== 'fork_mode' ||
      !sameList(env.args, entry.args) ||
      (entry.cron_restart ? env.cron_restart !== entry.cron_restart : !!env.cron_restart)) {
      throw new DeployError('crawler_registration_conflict');
    }
    if (entry === ecosystem.instagram &&
        (typeof env.exec_interpreter !== 'string' || resolve(env.exec_interpreter) !== join(root, 'node_modules/node/bin/node') ||
          env.autorestart !== false)) throw new DeployError('crawler_registration_conflict');
    return { name: entry.name, root, managed };
  }

  const checkInventory = (records: PM2Env[]) => {
    // The alternate scheduler ecosystem sets restart_delay, so a dormant
    // --no-autostart scheduler reports 'waiting restart' too. Only
    // autorestart:false proves no restart is pending behind that status.
    const dormant = (record: PM2Env) => [undefined, 'stopped', 'errored'].includes(record.status) ||
      record.status === 'waiting restart' && record.autorestart === false;
    if (records.some(record => record.name === 'agamajung-collector-scheduler' &&
      (record.autostart !== false || record.cron_restart || !dormant(record)))) {
      throw new DeployError('crawler_competing_scheduler');
    }
    const managed = records.filter(record => known.has(record.name)).map(savedRegistration);
    if (new Set(managed.map(record => record.name)).size !== managed.length) throw new DeployError('crawler_duplicate_registration');
    return managed;
  };

  function daemonTimezone() {
    if (verifyTimezone) return verifyTimezone();
    const pid = Number(readFileSync(join(pmHome, 'pm2.pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 2 || inspectIdentity(identity(pid)) !== 'alive' ||
        statSync('/proc/' + pid).uid !== process.getuid!() ||
        !/^PM2 v[^:]+: God Daemon /.test(readFileSync('/proc/' + pid + '/cmdline', 'utf8'))) {
      throw new DeployError('pm2_daemon_unavailable');
    }
    const tz = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').find(value => value.startsWith('TZ='))?.slice(3);
    const hostZone = () => Buffer.compare(readFileSync('/proc/' + pid + '/root/etc/localtime'), readFileSync('/usr/share/zoneinfo/Asia/Seoul')) === 0;
    if (tz ? !['Asia/Seoul', ':Asia/Seoul', '/usr/share/zoneinfo/Asia/Seoul', ':/usr/share/zoneinfo/Asia/Seoul'].includes(tz) : !hostZone()) {
      throw new DeployError('pm2_timezone_not_kst');
    }
  }

  async function checkSupervisors(instagram: boolean) {
    const units = ['agamajung-collector-watchdog.timer', 'agamajung-collector-watchdog.service'];
    if (instagram) units.push('agamajung-crawler.service');
    const userRuntime = process.env.XDG_RUNTIME_DIR ?? '/run/user/' + process.getuid!();
    for (const scope of ['--user', '--system']) {
      const hasManager = lstatSync(scope === '--system' ? '/run/systemd/system' : join(userRuntime, 'systemd/private'), { throwIfNoEntry: false });
      const env = {
        ...hostEnv(), LC_ALL: 'C', XDG_RUNTIME_DIR: userRuntime,
        ...(lstatSync(join(userRuntime, 'bus'), { throwIfNoEntry: false }) ? { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(userRuntime, 'bus') } : {}),
      };
      for (const unit of units) {
        const check = (verb: string, ...args: string[]) => run('systemctl', [scope, '--no-pager', '--no-ask-password', verb, ...args, unit], { env, timeout: 5000 });
        const enabled = (await check('is-enabled')).stdout.trim();
        if (['enabled', 'enabled-runtime'].includes(enabled)) throw new DeployError('crawler_competing_watchdog');
        if (hasManager) {
          const status = await check('show', '--property=LoadState,ActiveState,UnitFileState');
          const fields = new Map(status.stdout.trim().split('\n').map(line => line.split('=', 2) as [string, string]));
          if (['enabled', 'enabled-runtime'].includes(fields.get('UnitFileState') ?? '') ||
              ['active', 'activating', 'reloading', 'deactivating', 'refreshing'].includes(fields.get('ActiveState') ?? '')) {
            throw new DeployError('crawler_competing_watchdog');
          }
          if ((status.code && fields.get('LoadState') !== 'not-found') || !['inactive', 'failed'].includes(fields.get('ActiveState') ?? '')) {
            throw new DeployError('crawler_supervisor_unverifiable');
          }
        } else {
          // Offline hosts have no bus. Check the unit enablement links as well.
          const directories = scope === '--system' ? ['/etc/systemd/system', '/run/systemd/system'] :
            [join(homedir(), '.config/systemd/user'), join(userRuntime, 'systemd/user'), '/etc/systemd/user'];
          for (const directory of directories) {
            for (const suffix of ['timers.target.wants', 'default.target.wants', 'multi-user.target.wants']) {
              if (lstatSync(join(directory, suffix, unit), { throwIfNoEntry: false })) throw new DeployError('crawler_competing_watchdog');
            }
          }
        }
      }
    }
  }

  function externalPaths() {
    let values: Record<string, string>;
    try { values = readEnv(); }
    catch { throw new DeployError('crawler_env_unavailable'); }
    const db = values.COLLECTOR_DB, raw = values.COLLECTOR_RAW_DIR, deep = values.DEEPSEEK_WEB_STATE_DIR;
    if (!db || !raw || !deep || !values.DEEPSEEK_API_KEY ||
      (values.COLLECTOR_INTAKE_TOKEN?.length ?? 0) < 24 || (values.COLLECTOR_REVIEW_TOKEN?.length ?? 0) < 24 ||
      values.COLLECTOR_INTAKE_TOKEN === values.COLLECTOR_REVIEW_TOKEN ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(values.COLLECTOR_EXTENSION_ORIGIN ?? '')) throw new DeployError('crawler_env_incomplete');
    for (const path of [db, raw, deep]) {
      if (!isAbsolute(path) || resolve(path) !== path || within(dirname(link), path)) throw new DeployError('crawler_storage_invalid');
    }
    for (const dir of [dirname(db), raw, deep]) {
      const stat = lstatSync(dir);
      const permitted = dir === deep ? (stat.mode & 0o022) === 0 : (stat.mode & 0o777) === 0o700;
      if (realpathSync(dir) !== dir || !stat.isDirectory() || stat.uid !== process.getuid!() || !permitted) {
        throw new DeployError('crawler_storage_invalid');
      }
    }
    const dbStat = lstatSync(db);
    if (!dbStat.isFile() || dbStat.uid !== process.getuid!() || (dbStat.mode & 0o777) !== 0o600) throw new DeployError('crawler_storage_invalid');
    return values;
  }

  async function validateCandidate(path: string) {
    const config = join(path, 'crawler/ecosystem.all.config.cjs');
    const code = 'crawler_ecosystem_mismatch';
    if (!lstatSync(config, { throwIfNoEntry: false })?.isFile()) throw new DeployError(code);
    // Load the declaration outside the pinned controller's module graph.
    const output = await checked(run, code, process.execPath, ['-e',
      'process.stdout.write(JSON.stringify(require(process.argv[1]).apps))', config,
    ], { cwd: path, env: nodeEnv(process.execPath), timeout: 5000 });
    let apps: unknown;
    try { apps = JSON.parse(output); } catch { throw new DeployError(code); }
    if (!Array.isArray(apps) || apps.length !== approvedApps.size) throw new DeployError(code);
    const names = new Set<string>();
    for (const app of apps) {
      const name = app?.name;
      if (typeof name !== 'string' || names.has(name) || !isDeepStrictEqual(app, approvedApps.get(name))) {
        throw new DeployError(code);
      }
      names.add(name);
    }
  }

  async function observe(path: string, priorInstagram: string | null): Promise<CrawlerSnapshot> {
    externalPaths();
    await validateCandidate(path);
    daemonTimezone();
    const live = checkInventory((await currentApps()).map(p => p.pm2_env));
    const saved = checkInventory(dump());
    const apps = [...live, ...saved.filter(p => !live.some(l => l.name === p.name))];
    const instagram = apps.find(app => app.name === ecosystem.instagram.name);
    const instagramRoot = priorInstagram ?? (instagram && !instagram.managed ? instagram.root : null);
    if (instagram && !instagramRoot) throw new DeployError('instagram_storage_unverifiable');
    if (instagramRoot) validRoot(instagramRoot, workspace);
    await checkSupervisors(!!instagram);
    const oldTarget = currentTarget(link);
    if (oldTarget) validRoot(oldTarget, workspace);
    for (const app of [...ecosystem.inventory, ...(instagram ? [ecosystem.instagram] : [])]) {
      if (!lstatSync(join(path, app.script)).isFile()) throw new DeployError('crawler_entrypoint_invalid');
    }
    for (const script of ['load-managed-env.mjs', 'pm2-cron-gate.mjs']) {
      if (!lstatSync(join(path, 'crawler', script)).isFile()) throw new DeployError('crawler_entrypoint_invalid');
    }
    return { link: oldTarget, apps, instagramRoot };
  }

  function desired(snapshot: CrawlerSnapshot) {
    // Only the installed controller determines the registrations sent to PM2.
    const instagram = snapshot.apps.some(app => app.name === ecosystem.instagram.name);
    return [...ecosystem.inventory, ...(instagram ? [ecosystem.instagram] : [])].map(entry => ecosystem.app(entry, link));
  }
  function recovery(snapshot: CrawlerSnapshot) {
    return snapshot.apps.map(registration => {
      const entry = known.get(registration.name);
      if (!entry) throw new DeployError('crawler_recovery_invalid');
      const root = registration.managed ? link : validRoot(registration.root, workspace);
      return ecosystem.app(entry, root, registration.managed ? link : stableRoot);
    });
  }

  async function drain(includeInstagram: boolean, wait: boolean) {
    for (let i = 0; i < (wait ? 24 : 1); i++) {
      const apps = await currentApps();
      checkInventory(apps.map(p => p.pm2_env));
      const busy = apps.some(p => known.get(p.name)?.cron_restart &&
        (p.pid > 0 || ['online', 'launching', 'stopping'].includes(p.pm2_env.status ?? '')));
      const lockPath = externalPaths().COLLECTOR_DB + '.crawl.lock';
      const lock = readLock(lockPath);
      const owner = lock ? ownerOf(lock.text, 'crawl', lockPath) : null;
      const ownerState = owner ? inspectIdentity(owner) : 'gone';
      if (ownerState === 'unknown') throw new DeployError('crawler_lock_unverifiable');
      if (!busy && ownerState !== 'alive' && quietWindow(new Date(), includeInstagram)) return;
      if (wait) await sleep(5000);
    }
    throw new DeployError('crawler_cutover_waiting_for_jobs');
  }

  async function replace(apps: App[]) {
    const running = await currentApps();
    checkInventory(running.map(p => p.pm2_env));
    const scoped = running.filter(p => known.has(p.name));
    for (const p of scoped) await pm2('crawler_pm2_delete_failed', 'delete', p.name);
    if (!apps.length) return;
    mkdirSync(join(stateRoot, 'crawler-logs'), { mode: 0o700, recursive: true });
    const file = join(stateRoot, randomUUID() + '.config.cjs');
    try {
      writeFileSync(file, 'module.exports = ' + JSON.stringify({ apps }) + '\n', { flag: 'wx', mode: 0o600 });
      await pm2('crawler_pm2_start_failed', 'start', file);
    } finally { rmSync(file, { force: true }); }
  }

  async function preserveInstagram(path: string, snapshot: CrawlerSnapshot) {
    if (!snapshot.instagramRoot || !snapshot.apps.some(app => app.name === ecosystem.instagram.name)) return;
    for (const directory of ['.session', '.cache']) {
      const source = join(snapshot.instagramRoot, 'crawler', directory);
      const target = join(path, 'crawler', directory);
      if (snapshot.instagramRoot === path) throw new DeployError('instagram_storage_unverifiable');
      // The original checkout stays external to retained releases.
      mkdirSync(source, { recursive: true, mode: 0o700 });
      if (realpathSync(source) !== source) throw new DeployError('instagram_storage_unverifiable');
      const present = currentTarget(target);
      if (present === source) continue;
      if (present) throw new DeployError('instagram_storage_unverifiable');
      await checked(run, 'instagram_storage_unverifiable', 'ln', ['-s', '--', source, target], {});
    }
  }

  async function verify(target: string | null, apps: App[], legacy: boolean, wait: boolean) {
    const values = externalPaths();
    for (let i = 0; i < (wait ? 30 : 1); i++) {
      try {
        if (currentTarget(link) !== target) return false;
        const records = (await currentApps()).filter(p => known.has(p.name));
        if (records.length !== apps.length) return false;
        for (const app of apps) {
          const p = records.find(row => row.name === app.name);
          if (!p || !matches(p.pm2_env, app)) return false;
          assertEnvironment(p.pm2_env, app, values);
          // Installed PM2 (God.handleExit) reports 'waiting restart' after any
          // exit when restart_delay is set, even though autorestart:false
          // schedules no restart. pid 0 proves the gated exit is dormant.
          if (app.cron_restart && p.pid === 0 && ['stopped', 'waiting restart'].includes(p.pm2_env.status ?? '')) continue;
          if (app.cron_restart && quietWindow(new Date(), true)) throw new DeployError('crawler_cron_not_dormant');
          if (p.pid < 1 || p.pm2_env.status !== 'online') throw new DeployError('crawler_process_not_ready');
          const own = identity(p.pid);
          const same = (observed: Identity) => observed?.pid === own.pid && observed.start_ticks === own.start_ticks && observed.boot_id === own.boot_id;
          if (inspectIdentity(own) !== 'alive' || realpathSync('/proc/' + p.pid + '/cwd') !== realpathSync(app.cwd) ||
            realpathSync('/proc/' + p.pid + '/exe') !== realpathSync(app.interpreter)) throw new DeployError('crawler_process_mismatch');
          if (app.name === 'agamajung-local-worker') {
            const { data } = JSON.parse(await probe('http://127.0.0.1:4318/v1/readiness', 'application/json', {
              Authorization: 'Bearer ' + values.COLLECTOR_REVIEW_TOKEN,
            }));
            if (data?.ready !== true || !same(data.identity)) throw new DeployError('crawler_readiness_failed');
          }
          if (app.name === 'agamajung-deepseek-web') {
            const dir = values.DEEPSEEK_WEB_STATE_DIR;
            if (legacy && app.cwd !== link) {
              // Legacy processes have no daemon heartbeat during model backoff.
              // Verify their live identity via the exclusive writer registration.
              const { DatabaseSync } = await import('node:sqlite');
              const db = new DatabaseSync(join(dir, 'writer-ownership.sqlite'), { readOnly: true });
              try {
                const owner = db.prepare('SELECT value FROM owner WHERE id=1').get();
                if (!owner || !same(JSON.parse(String(owner.value)))) throw new DeployError('crawler_heartbeat_failed');
              } finally { db.close(); }
            } else {
              const heartbeat = JSON.parse(readFileSync(join(dir, 'daemon-heartbeat.json'), 'utf8'));
              const age = Date.now() - heartbeat.at;
              if (!same(heartbeat.identity) || !Number.isFinite(age) || age < 0 || age > 45_000 ||
                  heartbeat.at < (p.pm2_env.pm_uptime ?? 0)) throw new DeployError('crawler_heartbeat_failed');
            }
          }
        }
        daemonTimezone();
        return true;
      } catch {
        if (wait) await sleep(3000);
      }
    }
    return false;
  }

  async function save(apps: App[], first: boolean) {
    const values = externalPaths();
    const verifyDump = (backup: boolean) => {
      const records = dump(backup).filter(record => known.has(record.name));
      if (records.length !== apps.length) throw new DeployError('crawler_pm2_dump_mismatch');
      for (const app of apps) {
        const record = records.find(row => row.name === app.name);
        if (!record || !matches(record, app)) throw new DeployError('crawler_pm2_dump_mismatch');
        assertEnvironment(record, app, values);
      }
    };
    await pm2('crawler_pm2_save_failed', 'save');
    verifyDump(false);
    if (first) {
      await pm2('crawler_pm2_save_failed', 'save');
      verifyDump(false);
      verifyDump(true);
    }
  }

  return {
    current: () => currentTarget(link),
    preflight: observe,
    async cutover(path: string, snapshot: CrawlerSnapshot) {
      await validateCandidate(path);
      const apps = desired(snapshot);
      if (!await verify(path, apps, false, false)) {
        const current = currentTarget(link);
        if (current !== snapshot.link && current !== path) throw new DeployError('crawler_runtime_drift');
        await drain(!!snapshot.instagramRoot, true);
        await preserveInstagram(path, snapshot);
        await checkSupervisors(!!snapshot.instagramRoot);
        await drain(!!snapshot.instagramRoot, false);
        if (currentTarget(link) !== current) throw new DeployError('crawler_runtime_drift');
        await switchRuntime(run, link, path);
        await replace(apps);
        if (!await verify(path, apps, false, true)) throw new DeployError('crawler_verification_failed');
      }
      await save(apps, snapshot.apps.some(app => !app.managed) || snapshot.link === null);
    },
    async restore(path: string, snapshot: CrawlerSnapshot) {
      const apps = recovery(snapshot);
      if (!await verify(snapshot.link, apps, true, false)) {
        const current = currentTarget(link);
        if (current !== path && current !== snapshot.link) throw new DeployError('crawler_runtime_drift');
        await drain(!!snapshot.instagramRoot, true);
        await drain(!!snapshot.instagramRoot, false);
        await checkSupervisors(!!snapshot.instagramRoot);
        if (currentTarget(link) !== current) throw new DeployError('crawler_runtime_drift');
        await switchRuntime(run, link, snapshot.link);
        await replace(apps);
        if (!await verify(snapshot.link, apps, true, true)) throw new DeployError('crawler_restore_verify_failed');
      }
      await save(apps, true);
    },
  };
}
