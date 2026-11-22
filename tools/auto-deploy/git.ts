import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checked, hostEnv, type Command } from './command';
import { DeployError, isSha } from './state';

export const origin = 'https://github.com/SUNBURN-Golden/geunbon-baby.git';
const copyPaths = ['lib/copy/', 'lib/site-copy.ts', 'lib/deals-copy.ts', 'lib/auth-copy.ts'];
export const runtimePath = (root: string, sha: string) => join(root, 'main-' + sha.slice(0, 12));

export function gitAdapter(run: Command, store: string, runtime: string) {
  const git = (code: string, ...args: string[]) => checked(run, code, 'git', ['--git-dir', store, ...args], {
    env: { ...hostEnv(), GIT_TERMINAL_PROMPT: '0' },
  });

  async function registered() {
    const output = await git('worktree_inventory_failed', 'worktree', 'list', '--porcelain', '-z');
    const paths = new Map<string, string>();
    for (const row of output.split('\0\0')) {
      const fields = row.split('\0');
      const path = fields[0]?.match(/^worktree (.+)$/)?.[1];
      const sha = fields.find(field => field.startsWith('HEAD '))?.slice(5);
      if (path && isSha(sha) && fields.includes('detached')) paths.set(path, sha);
    }
    return paths;
  }

  async function verify(path: string, sha: string) {
    if (!isSha(sha) || path !== runtimePath(runtime, sha) || realpathSync(path) !== path || (await registered()).get(path) !== sha) {
      throw new DeployError('worktree_identity_mismatch');
    }
    const env = { ...hostEnv(), GIT_TERMINAL_PROMPT: '0' };
    const head = (await checked(run, 'worktree_identity_mismatch', 'git', ['-C', path, 'rev-parse', 'HEAD'], { env })).trim();
    const common = (await checked(run, 'worktree_identity_mismatch', 'git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { env })).trim();
    if (head !== sha || common !== store) throw new DeployError('worktree_identity_mismatch');
  }

  return {
    async fetch() {
      if (!lstatSync(store, { throwIfNoEntry: false })) await git('git_init_failed', 'init', '--bare');
      if (realpathSync(store) !== store) throw new DeployError('git_store_invalid');
      const result = await run('git', ['--git-dir', store, 'config', '--get', 'remote.origin.url'], {});
      if (result.code === 1) await git('git_origin_invalid', 'config', 'remote.origin.url', origin);
      else if (result.code !== 0 || result.stdout.trim() !== origin) throw new DeployError('git_origin_invalid');
      await git('fetch_failed', 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
      const sha = (await git('fetch_failed', 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}')).trim();
      if (!isSha(sha)) throw new DeployError('fetch_failed');
      return sha;
    },
    async prepare(path: string, sha: string) {
      if (path !== runtimePath(runtime, sha)) throw new DeployError('worktree_identity_mismatch');
      mkdirSync(runtime, { recursive: true, mode: 0o700 });
      if (!lstatSync(path, { throwIfNoEntry: false })) {
        await git('worktree_add_failed', 'worktree', 'add', '--detach', path, sha);
      }
      await verify(path, sha);
    },
    verify,
    async remove(path: string, sha: string) {
      if (!lstatSync(path, { throwIfNoEntry: false }) && !(await registered()).has(path)) return;
      await verify(path, sha);
      await git('worktree_remove_failed', 'worktree', 'remove', '--force', path);
    },
    async copy(before: string | null, after: string) {
      const baseline = before ?? (await git('copy_diff_failed', 'hash-object', '-t', 'tree', '/dev/null')).trim();
      const diff = await git('copy_diff_failed', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
        '--find-renames', '--unified=0', baseline, after, '--', ...copyPaths);
      return diff ? `\n## ${before ?? 'First snapshot (no previous site SHA)'} → ${after}\n\n`
        + '````diff\n' + diff + '````\n' : '';
    },
  };
}
