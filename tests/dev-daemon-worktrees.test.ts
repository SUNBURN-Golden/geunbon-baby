import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../tools/dev-daemon/models.json';
import { Daemon } from '../tools/dev-daemon/daemon';
import { atomicWrite, Queue } from '../tools/dev-daemon/queue';
import { ProcessRunner } from '../tools/dev-daemon/runner';
import { cleanupWorktree } from '../tools/dev-daemon/worktrees';
import type { Command, Execute, ModelsConfig, Result, Task } from '../tools/dev-daemon/types';

const run = promisify(execFile);
type Intercept = (command: Command) => Promise<Result | undefined>;
const temps: string[] = [];
const ok = (answer = ''): Result => ({ code: 0, output: answer, answer });
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Only temporary local repositories are used. No remotes, live queue, or model calls.
async function fixture(stage: 'done' | 'failed' = 'done') {
  const root = await mkdtemp(join(tmpdir(), 'daemon-worktrees-')); temps.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = async (args: string[], cwd = repo) => (await run('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false', '-c', 'user.name=Daemon Test', '-c', 'user.email=daemon@example.invalid', ...args],
  { cwd, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })).stdout;
  await git(['init', '-b', 'main']);
  await writeFile(join(repo, 'tracked.txt'), 'original\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\nignored.txt\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Local test fixture']);
  const commonDir = join(repo, '.git');
  const queue = new Queue(join(root, 'queue'));
  await queue.init();
  const target = join(queue.root, 'worktrees', 'A');
  const sibling = join(queue.root, 'worktrees', 'AB');
  await git(['worktree', 'add', '-b', 'task-A', target]);
  await git(['worktree', 'add', '-b', 'task-AB', sibling]);
  const dirty = async (path: string) => {
    await writeFile(join(path, 'tracked.txt'), 'useful uncommitted edit\n');
    await writeFile(join(path, 'untracked.txt'), 'untracked\n');
    await writeFile(join(path, 'ignored.txt'), 'ignored\n');
    await mkdir(join(path, 'node_modules'), { recursive: true });
    await writeFile(join(path, 'node_modules', 'fixture'), 'dependency\n');
  };
  await dirty(target); await dirty(sibling);
  const task: Task = { id: 'A', file: 'A.md', title: 'Cleanup', body: 'Original task', branch: 'task-A',
    worktree: target, kind: 'task', stage, round: 2, outputs: { build: 'Completed build' }, attempts: 0,
    summary: stage === 'done' ? 'Merged successfully' : 'Validation failed', pr: 'https://example.invalid/pull/1' };
  await atomicWrite(join(queue.root, 'running', task.file), task.body);
  await atomicWrite(join(queue.root, 'logs', task.id, 'retained.log'), 'Retained log\n');
  await atomicWrite(join(queue.root, 'audits', 'retained.md'), 'Retained audit\n');
  const state = await queue.load();
  state.active = task; state.mergedPrs = 7; state.auditedThrough = 0;
  await queue.save(state);
  const calls: Command[] = [];
  const runner = new ProcessRunner(10000);
  let intercept: Intercept | undefined;
  const execute: Execute = async command => {
    calls.push(command);
    const intercepted = await intercept?.(command);
    return intercepted ?? runner.execute(command);
  };
  const options = { repo, commonDir, queueRoot: queue.root, task, execute,
    log: (label: string) => join(root, 'cleanup-logs', `${calls.length}-${label}.log`) };
  const daemonOptions = { repo, queue, config: config as ModelsConfig, execute };
  const daemon = new Daemon(daemonOptions); await daemon.init();
  const cleanup = () => cleanupWorktree(options);
  const nested = async () => {
    const path = join(target, 'nested', 'B');
    await mkdir(join(target, 'nested'), { recursive: true });
    await git(['worktree', 'add', '-b', 'task-B', path]);
    await dirty(path);
    return path;
  };
  const destructive = () => calls.filter(command => command.args[0] === 'worktree' &&
    ['remove', 'prune'].includes(command.args[1]));
  return { root, repo, commonDir, queue, target, sibling, task, options, daemon, daemonOptions, calls,
    execute, git, cleanup, nested, dirty, destructive,
    intercept: (handler: Intercept) => { intercept = handler; } };
}

describe('terminal cleanup with real local Git worktrees', () => {
  it.each(['done', 'failed'] as const)('removes only %s task A, including dirty and ignored files, and archives after prune', async stage => {
    const f = await fixture(stage);
    await f.daemon.tick();
    expect(f.daemon.state.active).toBeUndefined();
    await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(f.sibling, 'tracked.txt'), 'utf8')).toContain('useful uncommitted');
    expect(await readFile(join(f.sibling, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(await readFile(join(f.repo, 'tracked.txt'), 'utf8')).toBe('original\n');
    const list = await f.git(['worktree', 'list', '--porcelain', '-z']);
    expect(list).not.toContain(`worktree ${f.target}\0`);
    expect(list).toContain(`worktree ${f.sibling}\0`);
    expect(await f.git(['show-ref', '--verify', 'refs/heads/task-A'])).toContain('refs/heads/task-A');
    expect(await readFile(join(f.queue.root, stage, 'A.md'), 'utf8')).toBe('Original task');
    expect(await readFile(join(f.queue.root, stage, 'A.summary.md'), 'utf8')).toContain(f.task.summary);
    expect(await readFile(join(f.queue.root, 'logs', 'A', 'retained.log'), 'utf8')).toBe('Retained log\n');
    expect(await readFile(join(f.queue.root, 'audits', 'retained.md'), 'utf8')).toBe('Retained audit\n');
    expect(f.daemon.state.mergedPrs).toBe(7);
    const commands = f.destructive().map(command => command.args);
    expect(commands).toEqual([
      ['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'],
      ['worktree', 'remove', '--force', f.target],
      ['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'],
      ['worktree', 'prune', '--expire', 'now'],
    ]);
    expect(f.destructive().every(command => command.cwd === f.repo)).toBe(true);
  });

  for (const stage of ['done', 'failed'] as const) {
    it.each(['present', 'locked', 'missing'] as const)(`preserves nested B and the ${stage} checkpoint when B is %s, including restart`, async condition => {
      const f = await fixture(stage);
      const nested = await f.nested();
      if (condition === 'locked') await f.git(['worktree', 'lock', nested]);
      if (condition === 'missing') await rm(nested, { recursive: true });
      const beforeList = await f.git(['worktree', 'list', '--porcelain', '-z']);
      const checkpoint = await readFile(join(f.queue.root, 'status.json'), 'utf8');
      for (const daemon of [f.daemon, new Daemon(f.daemonOptions)]) {
        if (daemon !== f.daemon) await daemon.init();
        await expect(daemon.tick()).rejects.toThrow('another registered worktree');
        expect(f.destructive()).toEqual([]); // Even prune dry-run is forbidden.
        expect(await f.git(['worktree', 'list', '--porcelain', '-z'])).toBe(beforeList);
        expect(await readFile(join(f.target, 'tracked.txt'), 'utf8')).toContain('useful uncommitted');
        expect(await readFile(join(f.target, 'untracked.txt'), 'utf8')).toBe('untracked\n');
        if (condition !== 'missing') {
          expect(await readFile(join(nested, 'tracked.txt'), 'utf8')).toContain('useful uncommitted');
          expect(await readFile(join(nested, 'untracked.txt'), 'utf8')).toBe('untracked\n');
        }
        const persisted = JSON.parse(await readFile(join(f.queue.root, 'status.json'), 'utf8'));
        const original = JSON.parse(checkpoint);
        expect(persisted.active).toEqual(original.active);
        expect(persisted.mergedPrs).toBe(original.mergedPrs);
        expect(await readdir(join(f.queue.root, stage))).toEqual([]);
      }
    });
  }

  it('rechecks the entire registration list immediately before remove', async () => {
    const f = await fixture();
    let lists = 0;
    f.intercept(async command => {
      if (command.args[0] === 'worktree' && command.args[1] === 'list' && ++lists === 2) await f.nested();
      return undefined;
    });
    await expect(f.daemon.tick()).rejects.toThrow('another registered worktree');
    expect(f.destructive().map(command => command.args[1])).toEqual(['prune']);
    expect(f.destructive()[0].args).toContain('--dry-run');
    expect(f.daemon.state.active?.stage).toBe('done');
    expect(await readFile(join(f.target, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it('refuses a locked target without a second force or a filesystem fallback', async () => {
    const f = await fixture('failed');
    await f.git(['worktree', 'lock', f.target]);
    await expect(f.daemon.tick()).rejects.toThrow('remove failed');
    expect(f.destructive().filter(command => command.args[1] === 'remove').map(command => command.args))
      .toEqual([['worktree', 'remove', '--force', f.target]]);
    expect(f.daemon.state.active?.summary).toBe('Validation failed');
    expect(await readFile(join(f.target, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(await readdir(join(f.queue.root, 'failed'))).toEqual([]);
  });

  it('refuses all deletion when another missing worktree would be pruned', async () => {
    const f = await fixture();
    await rm(f.sibling, { recursive: true });
    const before = await f.git(['worktree', 'list', '--porcelain', '-z']);
    await expect(f.daemon.tick()).rejects.toThrow('Prune would affect another worktree');
    expect(f.destructive().map(command => command.args)).toEqual([
      ['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'],
    ]);
    expect(await f.git(['worktree', 'list', '--porcelain', '-z'])).toBe(before);
    expect(await readFile(join(f.target, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it('rechecks prune scope after remove and preserves the done checkpoint if a new candidate appears', async () => {
    const f = await fixture();
    let previews = 0;
    f.intercept(async command => {
      if (command.args.includes('--dry-run') && ++previews === 2) await rm(f.sibling, { recursive: true });
      return undefined;
    });
    await expect(f.daemon.tick()).rejects.toThrow('Prune would affect another worktree');
    expect(f.destructive().some(command => command.args[1] === 'prune' && !command.args.includes('--dry-run'))).toBe(false);
    expect(f.daemon.state.active?.stage).toBe('done');
    expect(f.daemon.state.mergedPrs).toBe(7);
    expect(await f.git(['worktree', 'list', '--porcelain', '-z'])).toContain(`worktree ${f.sibling}\0`);
  });

  it('recovers a missing target with stale metadata by pruning only its registration', async () => {
    const f = await fixture();
    await rm(f.target, { recursive: true });
    await f.daemon.tick();
    expect(f.daemon.state.active).toBeUndefined();
    expect(f.destructive().some(command => command.args[1] === 'remove')).toBe(false);
    expect(await f.git(['worktree', 'list', '--porcelain', '-z'])).not.toContain(`worktree ${f.target}\0`);
    expect(await readFile(join(f.sibling, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it.each(['done', 'failed'] as const)('cleans a terminal %s audit without changing its report or audit checkpoint', async stage => {
    const f = await fixture(stage);
    f.daemon.state.active!.kind = 'audit';
    f.daemon.state.active!.auditAt = 10;
    f.daemon.state.auditedThrough = 10;
    f.daemon.state.mergedPrs = 10;
    await f.queue.save(f.daemon.state);
    await atomicWrite(join(f.queue.root, 'audits', 'A.md'), 'Checkpointed audit report\n');
    await f.daemon.tick();
    expect(f.daemon.state.active).toBeUndefined();
    expect(f.daemon.state.auditedThrough).toBe(10);
    expect(f.daemon.state.mergedPrs).toBe(10);
    expect(await readFile(join(f.queue.root, 'audits', 'A.md'), 'utf8')).toBe('Checkpointed audit report\n');
    await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a completed audit result and audit checkpoint when cleanup is blocked', async () => {
    const f = await fixture();
    await f.nested();
    f.daemon.state.active!.kind = 'audit';
    f.daemon.state.active!.auditAt = 10;
    f.daemon.state.auditedThrough = 10;
    f.daemon.state.mergedPrs = 10;
    await f.queue.save(f.daemon.state);
    const before = await f.queue.load();
    await expect(f.daemon.tick()).rejects.toThrow('another registered worktree');
    expect(await f.queue.load()).toEqual(before);
    expect(f.destructive()).toEqual([]);
  });

  it.each(['after-remove', 'during-archive'] as const)('resumes %s without deleting twice or changing the result', async interruption => {
    const f = await fixture();
    if (interruption === 'after-remove') {
      let interrupted = false;
      f.intercept(async command => {
        if (!interrupted && command.args[1] === 'remove') {
          interrupted = true;
          await f.git(command.args);
          throw new Error('Daemon stopping');
        }
        return undefined;
      });
      await expect(f.daemon.tick()).rejects.toThrow('Daemon stopping');
    } else {
      const original = f.queue.finish.bind(f.queue);
      f.queue.finish = async state => {
        const task = state.active!;
        await rename(join(f.queue.root, 'running', task.file), join(f.queue.root, 'done', task.file));
        throw new Error('Interrupted archive');
      };
      await expect(f.daemon.tick()).rejects.toThrow('Interrupted archive');
      f.queue.finish = original;
    }
    const restarted = new Daemon(f.daemonOptions); await restarted.init();
    expect(restarted.state.active?.stage).toBe('done');
    expect(restarted.state.active?.outputs).toEqual(f.task.outputs);
    await restarted.tick();
    expect(restarted.state.active).toBeUndefined();
    expect(restarted.state.mergedPrs).toBe(7);
    expect(f.destructive().filter(command => command.args[1] === 'remove')).toHaveLength(1);
    expect(await readFile(join(f.queue.root, 'done', 'A.summary.md'), 'utf8')).toContain('Merged successfully');
  });
});

describe('worktree cleanup safety failures', () => {
  it.each(['', '.', '..', '../A', 'A/B', 'A\\B', 'A\0B'])('rejects unsafe task ID %j before Git commands', async id => {
    const f = await fixture(); f.calls.length = 0;
    f.task.id = id;
    await expect(f.cleanup()).rejects.toThrow('Unsafe task ID');
    expect(f.calls).toEqual([]);
  });

  it.each(['design', 'prepare', 'validate'] as const)('refuses to clean the running %s stage', async stage => {
    const f = await fixture(); f.calls.length = 0; f.task.stage = stage;
    await expect(f.cleanup()).rejects.toThrow('unfinished');
    expect(f.calls).toEqual([]);
  });

  it('rejects a mismatched or escaping saved path', async () => {
    const f = await fixture(); f.calls.length = 0; f.task.worktree = f.repo;
    await expect(f.cleanup()).rejects.toThrow('Unexpected task worktree');
    expect(f.calls).toEqual([]);
  });

  it.each(['target', 'parent'] as const)('rejects a symlink at the %s without touching its destination', async location => {
    const f = await fixture();
    if (location === 'target') {
      await f.git(['worktree', 'remove', '--force', f.target]);
      await symlink(f.sibling, f.target);
    } else {
      const parent = join(f.queue.root, 'worktrees');
      await rename(parent, join(f.root, 'moved-worktrees'));
      await symlink(join(f.root, 'moved-worktrees'), parent);
    }
    f.calls.length = 0;
    await expect(f.cleanup()).rejects.toThrow('Unsafe worktree path');
    expect(f.calls).toEqual([]);
    expect(await readFile(join(f.sibling, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it.each(['repo', 'commonDir'] as const)('protects the configured %s and its ancestors', async field => {
    const f = await fixture(); f.calls.length = 0;
    f.options[field] = field === 'repo' ? f.target : join(f.target, '.git');
    // commonDir must exist as a directory for realpath; any descendant is protected.
    if (field === 'commonDir') { f.options.commonDir = join(f.target, 'node_modules'); }
    await expect(f.cleanup()).rejects.toThrow('protected location');
    expect(f.calls).toEqual([]);
  });

  it('protects the daemon current directory', async () => {
    const f = await fixture();
    vi.spyOn(process, 'cwd').mockReturnValue(f.target);
    await expect(f.cleanup()).rejects.toThrow('protected location');
    expect(f.destructive()).toEqual([]);
  });

  it('protects the Git main worktree even when it is inside the target', async () => {
    const f = await fixture();
    f.intercept(async command => command.args[1] === 'list' ? ok(
      `worktree ${f.target}\0HEAD abc123\0branch refs/heads/main\0\0`) : undefined);
    await expect(f.cleanup()).rejects.toThrow('protected location');
    expect(f.destructive()).toEqual([]);
  });

  it('preserves an unregistered ordinary directory', async () => {
    const f = await fixture();
    await f.git(['worktree', 'remove', '--force', f.target]);
    await mkdir(f.target);
    await writeFile(join(f.target, 'keep'), 'preserve');
    await expect(f.cleanup()).rejects.toThrow('unregistered directory');
    expect(f.destructive()).toEqual([]);
    expect(await readFile(join(f.target, 'keep'), 'utf8')).toBe('preserve');
  });

  it('preserves a registered path replaced by a worktree from a different repository', async () => {
    const f = await fixture();
    await rm(f.target, { recursive: true });
    const other = join(f.root, 'other'); await mkdir(other);
    await f.git(['init', '-b', 'other'], other);
    await f.git(['commit', '--allow-empty', '-m', 'Other local fixture'], other);
    await f.git(['worktree', 'add', '-b', 'other-task', f.target], other);
    await expect(f.cleanup()).rejects.toThrow('another repository');
    expect(f.destructive()).toEqual([]);
    expect(await f.git(['worktree', 'list', '--porcelain', '-z'], other)).toContain(`worktree ${f.target}\0`);
  });

  it.each(['alias', 'nested-alias', 'missing-nested'] as const)('protects another registration through %s path resolution', async kind => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    await symlink(f.target, alias);
    const path = kind === 'alias' ? alias : kind === 'nested-alias' ? join(alias, 'node_modules') : join(f.target, 'gone', 'B');
    const list = await f.git(['worktree', 'list', '--porcelain', '-z']);
    f.intercept(async command => command.args[1] === 'list' ? ok(list +
      `worktree ${path}\0HEAD abc123\0branch refs/heads/alias\0\0`) : undefined);
    await expect(f.cleanup()).rejects.toThrow('another registered worktree');
    expect(f.destructive()).toEqual([]);
  });

  it.each(['unterminated', 'unknown-field', 'duplicate', 'relative'] as const)('fails closed for %s registrations', async kind => {
    const f = await fixture();
    const list = await f.git(['worktree', 'list', '--porcelain', '-z']);
    const corrupt = kind === 'unterminated' ? list.slice(0, -1) : kind === 'unknown-field' ? list.replace('HEAD ', 'unknown ') :
      kind === 'duplicate' ? list + list : list.replace(`worktree ${f.repo}`, 'worktree relative');
    f.intercept(async command => command.args[1] === 'list' ? ok(corrupt) : undefined);
    await expect(f.cleanup()).rejects.toThrow(/parse|Ambiguous/);
    expect(f.destructive()).toEqual([]);
  });

  it('refuses an unparseable prune preview before removing the target', async () => {
    const f = await fixture();
    f.intercept(async command => command.args.includes('--dry-run') ? ok('unrecognized diagnostic\n') : undefined);
    await expect(f.cleanup()).rejects.toThrow('Cannot identify prune candidate');
    expect(f.destructive().every(command => command.args.includes('--dry-run'))).toBe(true);
    expect(await readFile(join(f.target, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it.each(['list', 'remove', 'prune', 'signal'] as const)('preserves terminal results on %s failure and retries on restart', async failure => {
    const f = await fixture('failed');
    f.intercept(async command => {
      const match = failure === 'signal' ? command.args[1] === 'remove' : command.args[1] === failure &&
        (failure !== 'prune' || !command.args.includes('--dry-run'));
      if (!match) return undefined;
      if (failure === 'signal') throw new Error('Daemon stopping');
      return { ...ok(), code: 1 };
    });
    await expect(f.daemon.tick()).rejects.toThrow();
    const saved = await f.queue.load();
    expect(saved.active?.stage).toBe('failed');
    expect(saved.active?.summary).toBe('Validation failed');
    expect(saved.active?.outputs).toEqual(f.task.outputs);
    expect(saved.mergedPrs).toBe(7);
    expect(await readdir(join(f.queue.root, 'failed'))).toEqual([]);
    const logs = await readdir(join(f.queue.root, 'logs', 'A'));
    expect(logs.some(file => basename(file).includes('worktree-cleanup-error'))).toBe(true);
    f.intercept(async () => undefined);
    const restarted = new Daemon(f.daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active).toBeUndefined();
    expect(restarted.state.mergedPrs).toBe(7);
  });
});
