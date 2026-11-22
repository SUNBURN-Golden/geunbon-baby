import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { command, nodeEnv } from './command';
import { crawlerAdapter } from './crawler';
import { deployer } from './deploy';
import { gitAdapter } from './git';
import { siteAdapter } from './site';
import { DeployError, errorCode } from './state';

const workspace = '/workspace/agamajung';
const root = join(workspace, 'auto-deploy');
const runtime = join(workspace, 'runtime');
const controller = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const log = (status: string) => console.info(JSON.stringify({ service: 'agamajung-auto-deploy', status }));
const pollMs = 300_000;
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());

async function main() {
  if (process.versions.node.split('.')[0] !== '22') throw new DeployError('node_22_required');
  for (const directory of [root, runtime]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new DeployError('deployment_directory_invalid');
  }

  const git = gitAdapter(command, join(root, 'main.git'), runtime);
  const site = siteAdapter(command, root);
  const crawler = crawlerAdapter(command, workspace, root, controller);
  const controllerOps = deployer(root, runtime, {
    ...git, ...site, ...crawler,
    async validate(path, report) {
      const node = join(path, 'node_modules/node/bin/node');
      const npm = async (interpreter: string, args: string[], error: string) => {
        const result = await command('npm', args, {
          cwd: path, env: { ...nodeEnv(interpreter), npm_config_userconfig: '/dev/null' }, timeout: 20 * 60_000,
        });
        if (result.code !== 0) throw new DeployError(error);
      };
      await npm(process.execPath, ['ci', '--include=dev'], 'dependencies_failed');
      const version = await command(node, ['--version'], { env: nodeEnv(node) });
      if (version.code !== 0 || !/^v22\./.test(version.stdout)) throw new DeployError('node_22_required');
      report('npm_ci');
      await npm(node, ['run', 'typecheck'], 'typecheck_failed');
      report('typecheck');
      await npm(node, ['test'], 'tests_failed');
      report('tests');
      await npm(node, ['run', 'build:worker'], 'worker_build_failed');
      report('worker_build');
      await site.bundle(path);
      report('worker_bundle');
    },
  }, log);

  while (!abort.signal.aborted) {
    const start = performance.now();
    try { await controllerOps.poll(); }
    catch (error) { log(errorCode(error)); }
    if (!abort.signal.aborted) {
      await setTimeout(Math.max(0, pollMs - (performance.now() - start)), undefined, { signal: abort.signal }).catch(() => {});
    }
  }
}

main().catch(error => { log(errorCode(error)); process.exitCode = 1; });
