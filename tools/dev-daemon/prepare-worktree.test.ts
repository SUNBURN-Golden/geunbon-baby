import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from './models.json';
import { Daemon } from './daemon';
import { prepareWorktree } from './prepare-worktree';
import { atomicWrite, Queue } from './queue';
import { ProcessRunner } from './runner';
import type { Command, Execute, ModelsConfig, Result, Task } from './types';

const run = promisify(execFile);
const temps: string[] = [];
const NOW = Date.parse('2026-10-31T12:34:56.789Z');
const STALE = 'dev-daemon/retry-stale-20261031T123456789Z';
const ok = (answer = ''): Result => ({ code: 0, output: answer, answer });
const failed = (): Result => ({ code: 1, output: 'private diagnostics', answer: '' });
type Intercept = (command: Command) => Promise<Result | undefined>;
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Fetch only from a local repository. GitHub, npm and models never execute.
async function fixture(existing = false) {
  const root = await mkdtemp(join(tmpdir(), 'daemon-prepare-')); temps.push(root);
  const origin = join(root, 'origin');
  const repo = join(root, 'repo');
  await mkdir(origin);
  const git = async (args: string[], cwd = repo) => (await run('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false', '-c', 'user.name=Daemon Test', '-c', 'user.email=daemon@example.invalid', ...args],
  { cwd, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })).stdout;
  await git(['init', '-b', 'main'], origin);
  await writeFile(join(origin, 'tracked.txt'), 'initial\n');
  await git(['add', '.'], origin);
  await git(['commit', '-m', 'Initial local fixture'], origin);
  await git(['clone', '--', origin, repo], root);
  const initial = (await git(['rev-parse', 'HEAD'])).trim();
  const original = (await git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Unique previous attempt'])).trim();
  // The clone has an outdated origin/main until prepare fetches it.
  await writeFile(join(origin, 'tracked.txt'), 'latest main\n');
  await git(['add', '.'], origin);
  await git(['commit', '-m', 'New local main commit'], origin);
  const latest = (await git(['rev-parse', 'HEAD'], origin)).trim();
  const queue = new Queue(join(root, 'queue'));
  await queue.init();
  const task: Task = { id: 'A', file: 'A.md', title: 'Retry worktree', body: 'Preserve previous commits.',
    branch: 'dev-daemon/retry', worktree: join(queue.root, 'worktrees', 'A'), kind: 'task', stage: 'prepare',
    round: 0, attempts: 0, outputs: {} };
  if (existing) await git(['branch', task.branch, original]);
  await atomicWrite(join(queue.root, 'running', task.file), task.body);
  const state = await queue.load(); state.active = task; await queue.save(state);
  const calls: Command[] = [];
  const runner = new ProcessRunner(10000);
  let intercept: Intercept | undefined;
  const execute: Execute = async command => {
    calls.push(command);
    const intercepted = await intercept?.(command);
    if (intercepted) return intercepted;
    if (command.bin === 'gh') return ok('[]');
    if (command.bin === 'npm') return ok();
    if (command.bin !== 'git') throw new Error('Unexpected model/network command in fixture');
    return runner.execute(command);
  };
  const daemonOptions = { repo, queue, config: config as ModelsConfig, execute, now: () => NOW };
  const daemon = new Daemon(daemonOptions); await daemon.init();
  const options = { repo, task: daemon.state.active!, commonDir: join(repo, '.git'), execute,
    log: (label: string) => join(root, 'prepare-logs', `${calls.length}-${label}.log`), scrub: queue.scrub, now: () => NOW };
  const prepare = () => prepareWorktree(options);
  const refs = () => git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']);
  const mutations = () => calls.filter(command => command.bin === 'git' &&
    ((command.args[0] === 'branch' && command.args[1] === '-m') ||
      (command.args[0] === 'worktree' && command.args[1] === 'add')));
  const prs = () => calls.filter(command => command.bin === 'gh');
  const openPr = (baseRefName = 'main') => JSON.stringify([{ number: 123,
    url: 'https://github.com/SUNBURN-Golden/geunbon-baby/pull/123', headRefName: task.branch, baseRefName }]);
  return { root, origin, repo, queue, task: options.task, git, initial, original, latest, calls, prepare, options,
    refs, mutations, prs, openPr, daemon, daemonOptions,
    intercept: (handler?: Intercept) => { intercept = handler; } };
}

describe('preparing real local Git worktrees', () => {
  it('creates an absent branch from newly fetched main without any gh lookup', async () => {
    const f = await fixture();
    expect((await f.git(['rev-parse', 'origin/main'])).trim()).toBe(f.initial);
    await f.daemon.tick();
    expect(f.daemon.state.active?.stage).toBe('design');
    expect(f.prs()).toEqual([]);
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.latest);
    expect(await f.refs()).not.toContain('-stale-');
    expect(await readFile(join(f.task.worktree, 'tracked.txt'), 'utf8')).toBe('latest main\n');
    expect(f.mutations().map(command => command.args)).toEqual([
      ['worktree', 'add', '-b', f.task.branch, f.task.worktree, f.latest],
    ]);
    expect(f.calls.find(command => command.bin === 'npm')?.args).toEqual(['ci', '--include=dev', '--no-audit', '--no-fund']);
  });

  it('does not mistake a child ref for the requested branch or rename it', async () => {
    const f = await fixture();
    await f.git(['branch', f.task.branch + '/child', f.original]);
    await expect(f.prepare()).rejects.toThrow('worktree-add failed');
    expect(f.prs()).toEqual([]);
    expect((await f.git(['rev-parse', f.task.branch + '/child'])).trim()).toBe(f.original);
    expect(await f.refs()).not.toContain('-stale-');
  });

  it('preserves the unique old commit, then creates a fresh branch from latest main', async () => {
    const f = await fixture(true);
    await f.daemon.tick();
    expect(f.daemon.state.active?.stage).toBe('design');
    expect((await f.git(['rev-parse', STALE])).trim()).toBe(f.original);
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.latest);
    expect(f.prs()).toHaveLength(2);
    expect(f.prs().every(command => command.cwd === f.repo && command.args.join(' ') ===
      `pr list --repo SUNBURN-Golden/geunbon-baby --head ${f.task.branch} --state open --json number,url,headRefName,baseRefName`)).toBe(true);
    const logs = await readdir(join(f.queue.root, 'logs', f.task.id));
    const preserved = logs.find(file => file.includes('prepare-branch-preserved'))!;
    const log = await readFile(join(f.queue.root, 'logs', f.task.id, preserved), 'utf8');
    expect(log).toContain(f.task.branch); expect(log).toContain(STALE); expect(log).toContain(f.original);
  });

  it.each(['present', 'locked', 'missing', 'main'] as const)('blocks a branch used by a %s worktree and preserves it through failure archival', async kind => {
    const f = await fixture(true);
    const other = kind === 'main' ? f.repo : join(f.root, 'other worktree\n한글');
    if (kind === 'main') await f.git(['checkout', f.task.branch]);
    else await f.git(['worktree', 'add', other, f.task.branch]);
    await writeFile(join(other, 'tracked.txt'), 'useful changes\n');
    if (kind === 'locked') await f.git(['worktree', 'lock', other]);
    if (kind === 'missing') await rm(other, { recursive: true });
    const before = await f.git(['worktree', 'list', '--porcelain', '-z']);
    await f.daemon.tick();
    const summary = `Branch preparation blocked: ${f.task.branch} is used by worktree ${JSON.stringify(other)}.`;
    expect(f.daemon.state.active?.stage).toBe('failed');
    expect((await f.queue.load()).active?.summary).toBe(summary);
    expect(f.prs()).toEqual([]); expect(f.mutations()).toEqual([]);
    await f.daemon.tick();
    expect(f.daemon.state.active).toBeUndefined();
    expect(await readFile(join(f.queue.root, 'failed', 'A.summary.md'), 'utf8')).toContain(summary);
    expect(await f.git(['worktree', 'list', '--porcelain', '-z'])).toBe(before);
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.original);
    if (kind !== 'missing') expect(await readFile(join(other, 'tracked.txt'), 'utf8')).toBe('useful changes\n');
  });

  it.each(['main', 'release/next'])('blocks an open PR to %s and archives its number and URL', async base => {
    const f = await fixture(true);
    f.intercept(async command => command.bin === 'gh' ? ok(f.openPr(base)) : undefined);
    await f.daemon.tick();
    expect(f.task.stage).toBe('failed');
    expect(f.task.summary).toContain('has open PR #123 (https://github.com/SUNBURN-Golden/geunbon-baby/pull/123)');
    expect(f.mutations()).toEqual([]);
    expect((await f.git(['rev-parse', 'origin/main'])).trim()).toBe(f.initial);
    await f.daemon.tick();
    expect(await readFile(join(f.queue.root, 'failed', 'A.summary.md'), 'utf8')).toContain('#123');
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.original);
  });

  it.each(['command', 'json', 'object', 'missing-field', 'wrong-head', 'wrong-url', 'wrong-number', 'wrong-base'])(
    'fails closed on %s PR lookup failure', async kind => {
      const f = await fixture(true);
      const pr = JSON.parse(f.openPr())[0];
      if (kind === 'missing-field') delete pr.baseRefName;
      if (kind === 'wrong-head') pr.headRefName += '-other';
      if (kind === 'wrong-url') pr.url = 'https://example.invalid/pull/123';
      if (kind === 'wrong-number') pr.number = '123';
      if (kind === 'wrong-base') pr.baseRefName = null;
      f.intercept(async command => command.bin !== 'gh' ? undefined : kind === 'command' ? failed() :
        ok(kind === 'json' ? '{broken' : kind === 'object' ? '{}' : JSON.stringify([pr])));
      const before = await f.refs();
      await f.daemon.tick();
      expect(f.task.stage).toBe('failed');
      expect(f.task.summary).toBe('Branch preparation blocked: open PR lookup failed; branch unchanged; see task logs.');
      expect(await f.refs()).toBe(before); expect(f.mutations()).toEqual([]);
    });

  it.each(['ref-command', 'ref-malformed', 'list-command', 'list-malformed', 'fetch', 'main-command', 'main-malformed'])(
    'preserves the old branch on %s Git failure', async kind => {
      const f = await fixture(true);
      const before = await f.refs();
      f.intercept(async command => {
        if (kind.startsWith('ref-') && command.args[0] === 'for-each-ref') return kind === 'ref-command' ? failed() : ok('broken\n');
        if (kind.startsWith('list-') && command.args[1] === 'list') return kind === 'list-command' ? failed() : ok('broken');
        if (kind === 'fetch' && command.args[0] === 'fetch') return failed();
        if (kind.startsWith('main-') && command.args.includes('refs/remotes/origin/main^{commit}')) {
          return kind === 'main-command' ? failed() : ok('not a commit\n');
        }
        return undefined;
      });
      await f.daemon.tick();
      expect(f.task.stage).toBe('failed');
      expect(await f.refs()).toBe(before); expect(f.mutations()).toEqual([]);
      expect(f.task.summary).not.toContain('private diagnostics');
    });

  it('avoids stale-name collisions without overwriting preserved commits', async () => {
    const f = await fixture(true);
    await f.git(['branch', STALE, f.initial]);
    await f.prepare();
    expect((await f.git(['rev-parse', STALE])).trim()).toBe(f.initial);
    expect((await f.git(['rev-parse', 'dev-daemon/retry-stale-20261031T123456790Z'])).trim()).toBe(f.original);
  });

  it('bounds stale-name selection and leaves all existing refs intact on exhaustion', async () => {
    const f = await fixture(true);
    for (let i = 0; i < 100; i++) {
      const name = `${f.task.branch}-stale-${new Date(NOW + i).toISOString().replace(/[-:.]/g, '')}`;
      await f.git(['branch', name, f.initial]);
    }
    const before = await f.refs();
    await expect(f.prepare()).rejects.toThrow('stale branch names exhausted');
    expect(await f.refs()).toBe(before); expect(f.mutations()).toEqual([]);
  });

  it.each(['ref', 'worktree', 'PR'] as const)('rechecks %s changes after fetch and blocks renaming', async kind => {
    const f = await fixture(true);
    let changed = false;
    f.intercept(async command => {
      if (!changed && command.args.includes('refs/remotes/origin/main^{commit}')) {
        changed = true;
        if (kind === 'ref') await f.git(['update-ref', `refs/heads/${f.task.branch}`, f.initial, f.original]);
        if (kind === 'worktree') await f.git(['worktree', 'add', join(f.root, 'other'), f.task.branch]);
      }
      return kind === 'PR' && changed && command.bin === 'gh' ? ok(f.openPr()) : undefined;
    });
    await expect(f.prepare()).rejects.toThrow(kind === 'ref' ? 'local branch changed' : kind === 'worktree' ? 'used by worktree' : 'has open PR');
    expect(f.mutations()).toEqual([]); expect(await f.refs()).not.toContain('-stale-');
  });

  it('fails on a second PR lookup failure before renaming', async () => {
    const f = await fixture(true);
    let queries = 0;
    f.intercept(async command => command.bin === 'gh' && ++queries === 2 ? failed() : undefined);
    await expect(f.prepare()).rejects.toThrow('open PR lookup failed');
    expect(f.mutations()).toEqual([]);
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.original);
  });

  it('does not rename or query PRs for a branch appearing after the absence check', async () => {
    const f = await fixture();
    f.intercept(async command => {
      if (command.args[0] === 'fetch') await f.git(['branch', f.task.branch, f.original]);
      return undefined;
    });
    await expect(f.prepare()).rejects.toThrow('appeared during preparation');
    expect(f.prs()).toEqual([]); expect(f.mutations()).toEqual([]);
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.original);
  });

  it('keeps the old ref on rename failure', async () => {
    const f = await fixture(true);
    f.intercept(async command => command.args[0] === 'branch' && command.args[1] === '-m' ? failed() : undefined);
    await expect(f.prepare()).rejects.toThrow('prepare-branch-preserve failed');
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.original);
    expect(await f.refs()).not.toContain('-stale-');
    expect(f.mutations()).toHaveLength(1);
  });

  it('keeps the stale commit on add failure and archives the preservation name', async () => {
    const f = await fixture(true);
    f.intercept(async command => command.args[0] === 'worktree' && command.args[1] === 'add' ? failed() : undefined);
    await f.daemon.tick();
    expect(f.task.stage).toBe('failed');
    expect(f.task.summary).toBe(`Worktree creation failed; previous branch preserved as ${STALE}; see task logs.`);
    await f.daemon.tick();
    expect(await readFile(join(f.queue.root, 'failed', 'A.summary.md'), 'utf8')).toContain(STALE);
    expect((await f.git(['rev-parse', STALE])).trim()).toBe(f.original);
    expect(await f.refs()).not.toContain(`refs/heads/${f.task.branch} `);
    const restarted = new Daemon(f.daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active).toBeUndefined(); // Archived failures do not automatically rerun.
  });

  it.each(['rename', 'add', 'failed-add-ref'] as const)('resumes prepare after interruption at %s without losing the old commit', async point => {
    const f = await fixture(true);
    let interrupted = false;
    f.intercept(async command => {
      const match = point === 'rename' ? command.args[0] === 'branch' && command.args[1] === '-m' :
        command.args[0] === 'worktree' && command.args[1] === 'add';
      if (!match || interrupted) return undefined;
      interrupted = true;
      if (point === 'failed-add-ref') await f.git(['branch', f.task.branch, f.latest]);
      else await f.git(command.args);
      throw new Error('Daemon stopping');
    });
    await expect(f.daemon.tick()).rejects.toThrow('Daemon stopping');
    expect((await f.queue.load()).active?.stage).toBe('prepare');
    expect((await f.git(['rev-parse', STALE])).trim()).toBe(f.original);
    f.intercept(); f.calls.length = 0;
    const restarted = new Daemon(f.daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active?.stage).toBe('design');
    expect((await f.git(['rev-parse', STALE])).trim()).toBe(f.original);
    expect((await f.git(['rev-parse', f.task.branch])).trim()).toBe(f.latest);
    if (point !== 'failed-add-ref') expect(f.prs()).toEqual([]);
    if (point === 'add') expect(f.mutations()).toEqual([]);
    if (point === 'failed-add-ref') {
      expect(f.prs()).toHaveLength(2);
      expect((await f.git(['rev-parse', 'dev-daemon/retry-stale-20261031T123456790Z'])).trim()).toBe(f.latest);
    }
  });

  it('resumes an existing dirty task worktree without PR lookup, fetch or rename', async () => {
    const f = await fixture(true);
    await f.git(['worktree', 'add', f.task.worktree, f.task.branch]);
    await writeFile(join(f.task.worktree, 'tracked.txt'), 'interrupted work\n');
    await f.daemon.tick();
    expect(f.task.stage).toBe('design'); expect(f.prs()).toEqual([]); expect(f.mutations()).toEqual([]);
    expect(f.calls.some(command => command.args[0] === 'fetch')).toBe(false);
    expect(await readFile(join(f.task.worktree, 'tracked.txt'), 'utf8')).toBe('interrupted work\n');
  });

  it.each(['branch', 'repository'] as const)('retains existing worktree %s ownership checks', async kind => {
    const f = await fixture(true);
    if (kind === 'branch') await f.git(['worktree', 'add', '-b', 'other', f.task.worktree]);
    else await f.git(['worktree', 'add', '-b', 'other', f.task.worktree], f.origin);
    await f.daemon.tick();
    expect(f.task.stage).toBe('failed');
    expect(f.task.summary).toContain(kind === 'branch' ? 'branch changed unexpectedly' : 'another repository');
    expect(f.prs()).toEqual([]); expect(f.mutations()).toEqual([]);
  });

  it('advances audits without npm installation', async () => {
    const f = await fixture(); f.task.kind = 'audit';
    await f.daemon.tick();
    expect(f.task.stage).toBe('audit');
    expect(f.calls.some(command => command.bin === 'npm')).toBe(false); expect(f.prs()).toEqual([]);
  });

  it('keeps failed preparation checkpoint and summary while cleanup is blocked, then archives on restart', async () => {
    const f = await fixture(true);
    const other = join(f.task.worktree, 'nested');
    await mkdir(f.task.worktree);
    await f.git(['worktree', 'add', other, f.task.branch]);
    await writeFile(join(other, 'tracked.txt'), 'keep nested edits\n');
    await f.daemon.tick(); // Existing parent fails branch ownership verification.
    expect(f.task.stage).toBe('failed');
    const summary = f.task.summary;
    const before = await f.queue.load();
    await expect(f.daemon.tick()).rejects.toThrow('another registered worktree');
    expect(await f.queue.load()).toEqual(before);
    expect(await readdir(join(f.queue.root, 'failed'))).toEqual([]);
    expect(await readFile(join(other, 'tracked.txt'), 'utf8')).toBe('keep nested edits\n');
    // Resolve the fixture obstruction without removing the other worktree or its edits.
    await f.git(['worktree', 'move', other, join(f.root, 'recovered')]);
    await rm(f.task.worktree, { recursive: true });
    const restarted = new Daemon(f.daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active).toBeUndefined();
    expect(await readFile(join(f.queue.root, 'failed', 'A.summary.md'), 'utf8')).toContain(summary);
    expect(await readFile(join(f.root, 'recovered', 'tracked.txt'), 'utf8')).toBe('keep nested edits\n');
  });

  it('applies the queue scrubber to preservation logs and archived summaries', async () => {
    const f = await fixture(true);
    const scrub = vi.spyOn(f.queue, 'scrub').mockImplementation(text => text.replaceAll(f.task.branch, '[REDACTED]'));
    f.intercept(async command => command.args[0] === 'worktree' && command.args[1] === 'add' ? failed() : undefined);
    await f.daemon.tick();
    expect(f.task.summary).toContain('[REDACTED]'); expect(f.task.summary).not.toContain(f.task.branch);
    const logs = await readdir(join(f.queue.root, 'logs', f.task.id));
    const preservation = logs.find(file => file.includes('prepare-branch-preserved'))!;
    expect(await readFile(join(f.queue.root, 'logs', f.task.id, preservation), 'utf8')).not.toContain(f.task.branch);
    await f.daemon.tick();
    expect(await readFile(join(f.queue.root, 'failed', 'A.summary.md'), 'utf8')).not.toContain(f.task.branch);
    expect(scrub).toHaveBeenCalled();
  });
});
