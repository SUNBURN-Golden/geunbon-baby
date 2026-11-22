import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfigFileTextToJson } from 'typescript';
import { nodeEnv, type Command, type Environment } from './command';
import { DeployError, isVersion } from './state';

const worker = 'agamajung';
const account = 'aa6bf084982ee841c3ea39b45895a15e';
const database = '4f48b5da-d7d9-4a92-bcb4-891c3c23fd6b';
const domain = 'agamajoong.soulbound.co.kr';
const origin = 'https://' + domain;
const cfTokenFile = '/home/box/.secrets/agamajung_cf_token';

export function servingVersion(output: string) {
  const { versions } = JSON.parse(output);
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].percentage !== 100 || !isVersion(versions[0].version_id)) {
    throw new DeployError('worker_not_single_version');
  }
  return versions[0].version_id as string;
}

export function uploadVersion(output: string) {
  const matches = output.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
    .filter(record => record.type === 'version-upload' && record.worker_name === worker);
  if (matches.length !== 1 || !isVersion(matches[0].version_id)) throw new DeployError('upload_record_invalid');
  return matches[0].version_id as string;
}

function checkedConfig(path: string) {
  const file = join(path, 'wrangler.jsonc');
  if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new DeployError('wrangler_config_invalid');
  const { config, error } = parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  const binding = config?.d1_databases?.[0], route = config?.routes?.[0];
  if (error || !config || config.name !== worker || config.account_id !== account || config.main !== 'worker.ts' ||
    config.d1_databases?.length !== 1 || binding?.binding !== 'DB' || binding?.database_name !== worker ||
    binding?.database_id !== database || binding?.migrations_dir !== 'migrations' ||
    binding?.migrations_pattern !== undefined ||
    binding?.migrations_table !== undefined && binding.migrations_table !== 'd1_migrations' ||
    config.routes?.length !== 1 || route?.pattern !== domain || route?.custom_domain !== true ||
    route?.zone_id !== '8f78031eed59646e7573c8d9c88de216' ||
    config.build !== undefined || config.route !== undefined || config.assets?.directory !== '.open-next/assets' ||
    config.legacy_env === false || config.compliance_region !== undefined) throw new DeployError('wrangler_config_invalid');
  const migrations = join(path, 'migrations');
  if (!lstatSync(migrations).isDirectory() || realpathSync(migrations) !== migrations) throw new DeployError('wrangler_config_invalid');
  return file;
}

export async function readBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new DeployError('health_body_invalid');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new DeployError('health_body_invalid');
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function probe(url: string, media: string, headers: Record<string, string> = {}, send: typeof fetch = fetch) {
  const response = await send(url, {
    headers: { Accept: media, 'Cache-Control': 'no-cache', ...headers },
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== media) {
    void response.body?.cancel().catch(() => {});
    throw new DeployError('health_response_invalid');
  }
  return readBody(response, media === 'text/html' ? 8 * 1024 * 1024 : 1024 * 1024);
}

export async function siteProbe(legacy: boolean, send: typeof fetch = fetch) {
  try {
    const home = await probe(origin + '/', legacy ? 'text/html' : 'application/json', {}, send);
    if (legacy ? !home.trim() : JSON.parse(home)?.ok !== true) return false;
    const deals = JSON.parse(await probe(origin + '/api/v1/deals?limit=5', 'application/json', {}, send));
    return Array.isArray(deals?.data) && (deals.next_cursor === null || typeof deals.next_cursor === 'string');
  } catch {
    return false;
  }
}

export function siteAdapter(run: Command, scratch: string, {
  tokenFile = cfTokenFile, locked = true,
}: { tokenFile?: string; locked?: boolean } = {}) {
  const wrangler = async (path: string, code: string, args: string[], auth = true, output?: string) => {
    const config = checkedConfig(path);
    const node = join(path, 'node_modules/node/bin/node');
    const privateDir = mkdtempSync(join(scratch, 'wrangler-'));
    try {
      const env: Environment = {
        ...nodeEnv(node), HOME: privateDir, XDG_CONFIG_HOME: privateDir, WRANGLER_LOG_PATH: privateDir, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log',
      };
      if (auth) {
        let token: string;
        try { token = readFileSync(tokenFile, 'utf8').trim(); } catch { throw new DeployError('cloudflare_token_unavailable'); }
        if (!token || /\s/.test(token)) throw new DeployError('cloudflare_token_unavailable');
        env.CLOUDFLARE_API_TOKEN = token;
        env.CLOUDFLARE_ACCOUNT_ID = account;
      }
      if (output) env.WRANGLER_OUTPUT_FILE_PATH = output;
      const result = await run(node, [join(path, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', config], {
        cwd: path, env, timeout: 10 * 60_000, lockFile: auth && locked ? join(scratch, 'cloudflare.lock') : undefined,
      });
      if (result.code !== 0) throw new DeployError(code);
      return result.stdout;
    } finally { rmSync(privateDir, { recursive: true, force: true }); }
  };

  return {
    bundle: (path: string) => wrangler(path, 'worker_bundle_failed', ['versions', 'upload', '--dry-run', '--name', worker], false),
    async serving(path: string) {
      try { return servingVersion(await wrangler(path, 'worker_status_failed', ['deployments', 'status', '--name', worker, '--json'])); }
      catch (error) { if (error instanceof DeployError) throw error; throw new DeployError('worker_status_failed'); }
    },
    async pending(path: string) {
      checkedConfig(path);
      const query = async (sql: string, key: string) => {
        const result = JSON.parse(await wrangler(path, 'migration_inspection_failed', [
          'd1', 'execute', worker, '--remote', '--json', '--command', sql,
        ]));
        if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true || !Array.isArray(result[0].results)) {
          throw new DeployError('migration_inspection_failed');
        }
        return (result[0].results as Record<string, unknown>[]).map(row => {
          if (typeof row[key] !== 'string') throw new DeployError('migration_inspection_failed');
          return row[key] as string;
        });
      };
      const exists = await query("SELECT name FROM sqlite_schema WHERE type='table' AND name='d1_migrations'", 'name');
      const applied = new Set(exists.length ? await query('SELECT name FROM d1_migrations', 'name') : []);
      const directory = join(path, 'migrations');
      return readdirSync(directory).filter(name => name.endsWith('.sql') && !applied.has(name)).sort().map(name => {
        const file = join(directory, name);
        if (!/^[\w.-]+\.sql$/.test(name) || !lstatSync(file).isFile()) throw new DeployError('migration_file_invalid');
        return { name, destructive: /\b(?:DROP|ALTER)\b/i.test(readFileSync(file, 'utf8')) };
      });
    },
    migrate: (path: string) => wrangler(path, 'migration_apply_failed', ['d1', 'migrations', 'apply', worker, '--remote']),
    upload: (path: string, output: string) => wrangler(path, 'worker_upload_failed', ['versions', 'upload', '--name', worker], true, output),
    promote: (path: string, version: string) => {
      if (!isVersion(version)) throw new DeployError('worker_version_invalid');
      return wrangler(path, 'worker_promote_failed', ['versions', 'deploy', version + '@100%', '--name', worker, '--yes']);
    },
    rollback: (path: string, version: string) => {
      if (!isVersion(version)) throw new DeployError('worker_version_invalid');
      return wrangler(path, 'worker_rollback_failed', ['rollback', version, '--name', worker, '--yes']);
    },
    async health(path: string, version: string, legacy: boolean) {
      for (let i = 0; i < 4; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, 5000));
        if (await siteProbe(legacy)) {
          if (await this.serving(path) === version) return true;
        }
      }
      return false;
    },
  };
}
