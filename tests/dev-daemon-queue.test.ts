import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../tools/dev-daemon/models.json';
import { Daemon } from '../tools/dev-daemon/daemon';
import { parseTask, Queue } from '../tools/dev-daemon/queue';
import type { Command, Execute, ModelsConfig, Result, Stage } from '../tools/dev-daemon/types';

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const ok = (answer = ''): Result => ({ code: 0, output: answer, answer });
async function fixture(options: { answers?: Partial<Record<Stage, (string | Result)[]>>; failCheck?: string; failPrepare?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dev-daemon-test-')); temps.push(root);
  const queue = new Queue(join(root, 'queue'));
  await queue.init();
  const repo = join(root, 'repo');
  const common = join(repo, '.git');
  await mkdir(common, { recursive: true });
  const blueprint = join(root, 'TASK.md');
  await writeFile(blueprint, 'Site and crawler are separate.');
  const calls: Command[] = [];
  const worktrees = new Map<string, string>();
  let extraFiles = '';
  let branch = '', prCreated = false, merged = false, dirty = false, head = 'abc123', diff = '';
  const answers = options.answers ?? {};
  const stages = ['design-review', 'design-revise', 'build-review', 'review-fix', 're-review', 'design', 'build', 'audit'] as Stage[];
  const execute: Execute = vi.fn(async command => {
    calls.push(command);
    const args = command.args[0] === '-C' ? command.args.slice(2) : command.args;
    const gitCwd = command.args[0] === '-C' ? command.args[1] : command.cwd;
    const label = basename(command.log);
    if (command.bin === 'git') {
      if (args[0] === 'fetch' && options.failPrepare) return { ...ok(), code: 1 };
      if (args.includes('--git-common-dir')) return ok(common);
      if (args[0] === 'worktree') {
        switch (args[1]) {
          case 'list': return ok([repo, ...worktrees.keys()].map(path =>
            `worktree ${path}\0HEAD abc123\0branch refs/heads/${path === repo ? 'main' : branch}\0\0`).join(''));
          case 'add': {
            branch = args[3];
            const path = args[4], admin = join(common, 'worktrees', basename(path));
            await mkdir(path, { recursive: true });
            await mkdir(admin, { recursive: true });
            await writeFile(join(path, '.git'), `gitdir: ${admin}\n`);
            await writeFile(join(admin, 'gitdir'), join(path, '.git') + '\n');
            worktrees.set(path, admin);
            await writeFile(join(path, 'file.ts'), 'reviewed content'); return ok();
          }
          case 'remove': {
            const path = args[3], admin = worktrees.get(path);
            await rm(path, { recursive: true, force: true });
            if (admin) await rm(admin, { recursive: true, force: true });
            worktrees.delete(path); return ok();
          }
          case 'prune': return ok();
          default: throw new Error('Unexpected worktree command');
        }
      }
      if (args[0] === 'branch') return ok(branch);
      if (args[0] === 'write-tree' || args[1] === 'HEAD^{tree}') return ok('tree123');
      if (args[0] === 'rev-parse') {
        if (args[1] === '--show-toplevel') return ok(gitCwd);
        if (args[1] === '--absolute-git-dir') return ok(worktrees.get(gitCwd) ?? common);
        return ok(args[1] === 'HEAD^' ? 'abc123' : head);
      }
      if (args[0] === 'rev-list') return ok('1');
      if (args.includes('--quiet')) return { ...ok(), code: args.includes('--cached') ? 1 : 0 };
      if (args[0] === 'diff') return ok(args.includes('--name-status') ? 'M\0file.ts\0' : diff);
      if ((args[0] === 'ls-files' && args.includes('--cached')) || args[0] === 'ls-tree') return ok('file.ts\0' + extraFiles);
      if (args[0] === 'status') return ok(dirty ? ' M file.ts' : '');
      return ok();
    }
    if (command.bin === 'npm') {
      if (label.includes(`check-${options.failCheck ?? 'never'}`)) return { ...ok('check failed'), code: 1 };
      return ok();
    }
    if (command.bin === 'gh') {
      if (args[1] === 'create') prCreated = true;
      if (args[1] === 'merge') merged = true;
      if (args[1] === 'list') return ok(JSON.stringify(prCreated ? [{ url: 'https://github.com/SUNBURN-Golden/geunbon-baby/pull/42',
        state: merged ? 'MERGED' : 'OPEN', headRefOid: head, baseRefName: 'main' }] : []));
      return ok();
    }
    const stage = stages.find(s => new RegExp(`-${s}-\\d+-\\d+-`).test(label));
    if (!stage) throw new Error(`Unexpected mocked command: ${command.bin}`);
    const answer = answers[stage]?.shift() ?? (stage.includes('review') ? 'No issues.\nVERDICT: APPROVE' :
      stage === 'audit' ? '# Audit\n\n```json\n{"fixes":[]}\n```' : 'Task completed.');
    return typeof answer === 'string' ? ok(answer) : answer;
  });
  const daemonOptions = { repo, queue, config: config as ModelsConfig, execute, blueprint, now: () => Date.parse('2026-10-21T00:00:00Z') };
  const daemon = new Daemon(daemonOptions);
  await daemon.init();
  return { root, queue, calls, daemon, daemonOptions, setDirty: () => { dirty = true; }, setMerged: () => { merged = true; },
    setFiles: (value: string) => { extraFiles = value; }, setHead: (value: string) => { head = value; }, setDiff: (value: string) => { diff = value; } };
}
async function enqueue(queue: Queue, body = '# Improve site\n\nMake a scoped change.', file = '001-task.md') {
  await writeFile(join(queue.root, 'inbox', file), body);
}
async function until(daemon: Daemon, predicate: () => boolean) {
  for (let count = 0; count < 60 && !predicate(); count++) {
    await daemon.tick();
    if (daemon.state.active?.stage === 'failed' && !predicate()) throw new Error(daemon.state.active.summary);
  }
  expect(predicate()).toBe(true);
}

describe('task queue', () => {
  it('parses scalar metadata and rejects malformed tasks/protected branches', () => {
    expect(parseTask('---\ntitle: "A task"\nbranch: feature/task\n---\n\nDo the work.', 'task.md'))
      .toEqual({ title: 'A task', branch: 'feature/task', body: 'Do the work.' });
    expect(parseTask('---\n---\nbody', 'task.md')).toEqual({ title: 'task', body: 'body', branch: undefined });
    expect(() => parseTask('---\nbranch: main\n---\nbody', 'x.md')).toThrow('protected');
    expect(() => parseTask('---\ntitle: task\nbody', 'x.md')).toThrow('Unclosed');
    expect(() => parseTask('', 'x.md')).toThrow('empty');
  });
  it('claims sorted inbox tasks atomically, maintains one active task, and archives summaries', async () => {
    const { queue } = await fixture();
    await enqueue(queue, '# B\nbody', '002.md');
    await enqueue(queue, '# A\nbody', '001.md');
    const state = await queue.load();
    const task = (await queue.claim(state))!;
    expect(task.title).toBe('A');
    expect(await queue.claim(state)).toBe(task);
    expect((await readdir(join(queue.root, 'inbox')))).toEqual(['002.md']);
    task.stage = 'failed'; task.summary = 'Expected test failure'; await queue.save(state);
    await queue.finish(state);
    expect(state.active).toBeUndefined();
    expect(await readdir(join(queue.root, 'running'))).toEqual([]);
    expect(await readFile(join(queue.root, 'failed', `${task.id}.summary.md`), 'utf8')).toContain('Expected test failure');
  });
  it('recovers a task renamed to running before its first checkpoint', async () => {
    const { queue } = await fixture();
    await writeFile(join(queue.root, 'running', 'orphan.md'), '# Orphan\nbody');
    await enqueue(queue);
    const state = await queue.load();
    expect((await queue.claim(state))?.id).toBe('orphan');
    expect(await readdir(join(queue.root, 'inbox'))).toHaveLength(1);
  });
  it('archives invalid tasks as failed without invoking any model', async () => {
    const { queue, daemon, calls } = await fixture();
    await enqueue(queue, '---\nbranch: main\n---\nbody');
    await daemon.tick(); await daemon.tick();
    expect(await readdir(join(queue.root, 'failed'))).toHaveLength(2);
    expect(calls.every(command => command.bin === 'git')).toBe(true);
  });
  it('refuses a corrupt checkpoint instead of discarding it', async () => {
    const { queue } = await fixture();
    await writeFile(join(queue.root, 'status.json'), '{broken');
    await expect(queue.load()).rejects.toThrow();
  });
  it('holds a kernel lock until released and reuses it without stale PID races', async () => {
    const { queue } = await fixture();
    const unlock = await queue.lock();
    try { await expect(queue.lock()).rejects.toThrow('Another dev daemon'); }
    finally { await unlock(); }
    const unlockAgain = await queue.lock();
    await unlockAgain();
  });
});

describe('daemon state machine with offline runners', () => {
  it('includes development dependencies when preparing a task under NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { queue, daemon, calls } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'design');
    const install = calls.find(command => command.bin === 'npm' && command.args[0] === 'ci');
    expect(install?.args).toEqual(['ci', '--include=dev', '--no-audit', '--no-fund']);
    expect(install?.cwd).toBe(daemon.state.active?.worktree);
  });
  it('revises the design once, fixes/re-reviews, validates, then publishes and counts a confirmed merge', async () => {
    const { queue, daemon, calls } = await fixture({ answers: {
      'design-review': ['Needs detail.\nVERDICT: CHANGES'], 'build-review': ['Bug.\nVERDICT: CHANGES'],
      're-review': ['Still a bug.\nVERDICT: CHANGES', 'Fixed.\nVERDICT: APPROVE'],
    } });
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'done');
    expect(daemon.state.mergedPrs).toBe(1);
    expect(daemon.state.active?.round).toBe(2);
    expect(daemon.state.active?.outputs['design-revise']).toBeDefined();
    const checks = calls.filter(c => c.bin === 'npm' && basename(c.log).includes('check-')).map(c => c.args.join(' '));
    expect(checks).toEqual(['run lint', 'run typecheck', 'test', 'run build']);
    const pushIndex = calls.findIndex(c => c.bin === 'git' && c.args[0] === 'push');
    const lastCheckIndex = calls.findIndex(c => c.bin === 'npm' && c.args.join(' ') === 'run build');
    expect(pushIndex).toBeGreaterThan(lastCheckIndex);
    expect(calls.filter(c => c.bin === 'gh' && c.args[1] === 'merge')).toHaveLength(1);
    await daemon.tick();
    expect(daemon.state.active).toBeUndefined();
    expect(await readdir(join(queue.root, 'done'))).toHaveLength(2);
  });
  it('fails after exactly two fix/re-review rounds and never pushes', async () => {
    const changes = 'Bug.\nVERDICT: CHANGES';
    const { queue, daemon, calls } = await fixture({ answers: { 'build-review': [changes], 're-review': [changes, changes] } });
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'failed');
    expect(daemon.state.active?.round).toBe(2);
    expect(daemon.state.active?.summary).toContain('two fix/re-review');
    expect(calls.some(c => c.bin === 'git' && c.args[0] === 'push')).toBe(false);
  });
  it('fails a missing final verdict without publishing', async () => {
    const { queue, daemon, calls } = await fixture({ answers: { 'build-review': ['Looks good'] } });
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'failed');
    expect(daemon.state.active?.summary).toContain('VERDICT');
    expect(calls.some(c => c.bin === 'gh')).toBe(false);
  });
  it.each(['lint', 'typecheck', 'test', 'build'])('fails a %s check without publishing', async failCheck => {
    const { queue, daemon, calls } = await fixture({ failCheck });
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'failed');
    expect(daemon.state.active?.summary).toContain(`check-${failCheck}`);
    expect(calls.some(c => c.bin === 'gh')).toBe(false);
    expect(daemon.state.mergedPrs).toBe(0);
    const task = daemon.state.active!;
    await daemon.tick();
    expect(daemon.state.active).toBeUndefined();
    await expect(readFile(join(task.worktree, 'file.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(queue.root, 'failed', `${task.id}.summary.md`), 'utf8')).toContain(`check-${failCheck}`);
  });
  it('archives a prepare failure safely when no task worktree was created', async () => {
    const { queue, daemon, calls } = await fixture({ failPrepare: true });
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'failed');
    expect(daemon.state.active?.summary).toContain('fetch-main');
    await daemon.tick();
    expect(daemon.state.active).toBeUndefined();
    expect(await readdir(join(queue.root, 'failed'))).toHaveLength(2);
    expect(calls.some(c => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
  });
  it('does not clean a running task or another task waiting in inbox', async () => {
    const { queue, daemon, calls } = await fixture();
    await enqueue(queue); await enqueue(queue, '# Second\nbody', '002.md');
    await until(daemon, () => daemon.state.active?.stage === 'build');
    expect(calls.some(c => c.args[0] === 'worktree' && ['remove', 'prune'].includes(c.args[1]))).toBe(false);
    expect(await readdir(join(queue.root, 'inbox'))).toEqual(['002.md']);
  });
  it('persists a quota pause and resumes the same stage after restart, leaving the next task in inbox', async () => {
    const { queue, daemon, daemonOptions, calls } = await fixture({ answers: { design: Array.from({ length: 4 }, () => ({
      code: 0, output: 'quota resets 2026-10-21T01:00:00Z', answer: '', stderr: 'quota resets 2026-10-21T01:00:00Z',
    })) } });
    await enqueue(queue); await enqueue(queue, '# Second\nbody', '002.md');
    await until(daemon, () => Boolean(daemon.state.active?.wakeAt));
    const saved = JSON.parse(await readFile(join(queue.root, 'status.json'), 'utf8'));
    const restarted = new Daemon(daemonOptions); await restarted.init();
    const before = calls.length;
    expect(await restarted.tick()).toBe(30000);
    expect(calls).toHaveLength(before);
    expect(calls.some(c => c.args[0] === 'worktree' && ['remove', 'prune'].includes(c.args[1]))).toBe(false);
    expect(restarted.state.active?.id).toBe(saved.active.id);
    expect(await readdir(join(queue.root, 'inbox'))).toEqual(['002.md']);
    const later = new Daemon({ ...daemonOptions, now: () => Date.parse('2026-10-21T01:01:00Z') });
    await later.init(); await later.tick();
    expect(later.state.active?.stage).toBe('design-review');
    expect(later.state.active?.wakeAt).toBeUndefined();
  });
  it('refuses worktree changes after validation', async () => {
    const { queue, daemon, setDirty, calls } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'publish');
    setDirty(); await daemon.tick();
    expect(daemon.state.active?.stage).toBe('failed');
    expect(calls.some(c => c.bin === 'git' && c.args[0] === 'push')).toBe(false);
  });
  it('blocks validation if content changed after the final review', async () => {
    const { queue, daemon, calls } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'validate');
    await writeFile(join(daemon.state.active!.worktree, 'file.ts'), 'unreviewed content'); await daemon.tick();
    expect(daemon.state.active?.stage).toBe('failed');
    expect(daemon.state.active?.summary).toContain('changed after final review');
    expect(calls.some(c => c.bin === 'git' && c.args[0] === 'push')).toBe(false);
  });
  it('fingerprints complete image contents even when review context summarizes them', async () => {
    const { queue, daemon, calls, setFiles } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'build-review');
    const task = daemon.state.active!;
    await mkdir(join(task.worktree, 'public/img'), { recursive: true });
    const path = join(task.worktree, 'public/img/review.svg');
    await writeFile(path, '<svg>' + 'x'.repeat(400 * 1024) + '</svg>');
    setFiles('public/img/review.svg\0');
    await daemon.tick();
    expect(task.stage).toBe('validate');
    await writeFile(path, '<svg>' + 'y'.repeat(400 * 1024) + '</svg>');
    await daemon.tick();
    expect(task.stage).toBe('failed'); expect(task.summary).toContain('changed after final review');
    expect(calls.some(c => c.bin === 'git' && c.args[0] === 'push')).toBe(false);
  });
  it('resumes after a commit completed before its publish checkpoint, without committing twice', async () => {
    const { queue, daemon, daemonOptions, calls, setHead } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'commit');
    setHead('new-commit');
    const restarted = new Daemon(daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active?.stage).toBe('publish');
    expect(restarted.state.active?.commit).toBe('new-commit');
    expect(calls.some(c => c.bin === 'git' && c.args.includes('commit'))).toBe(false);
  });
  it.each(['build-review', 're-review'] as const)('includes bounded review context in %s stdin', async stage => {
    const { queue, daemon, calls, setDiff } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'build-review');
    daemon.state.active!.stage = stage;
    setDiff('diff --git a/app/page.tsx b/app/page.tsx'); await daemon.tick();
    const review = calls.find(c => basename(c.log).includes(`-${stage}-0-0-`))!;
    expect(review.input?.text).toContain('diff --git a/app/page.tsx b/app/page.tsx');
    expect(review.input?.text).toContain('Untracked paths');
    expect(calls.find(c => c.log.includes('review-main-diff'))?.args).toContain(':(exclude,icase,glob)public/img/**/*.svg');
    expect(review.input?.transport).toBe('stdin');
  });
  it('recovers an already merged PR without merging or counting twice', async () => {
    const { queue, daemon, daemonOptions, setMerged, calls } = await fixture();
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'merge');
    setMerged();
    const restarted = new Daemon(daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.mergedPrs).toBe(1);
    const again = new Daemon(daemonOptions); await again.init(); await again.tick();
    expect(again.state.mergedPrs).toBe(1);
    expect(calls.filter(c => c.bin === 'gh' && c.args[1] === 'merge')).toHaveLength(0);
  });
  it('audits on the tenth merge, writes a report, enqueues fixes and persists the audit checkpoint', async () => {
    const audit = '# Evidence\nSite gap\n```json\n{"fixes":[{"title":"Fix model view","task":"Change the site route; verify rendering."}]}\n```';
    const { queue, daemon, calls } = await fixture({ answers: { audit: [audit] } });
    daemon.state.mergedPrs = 9; await queue.save(daemon.state);
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'done');
    await daemon.tick();
    await until(daemon, () => daemon.state.auditedThrough === 10);
    expect(daemon.state.mergedPrs).toBe(10);
    expect(await readFile(join(queue.root, 'audits', 'audit-000010.md'), 'utf8')).toContain('Site gap');
    expect(await readdir(join(queue.root, 'inbox'))).toEqual(['audit-000010-fix-01.md']);
    expect(calls.filter(c => c.bin === 'gh' && c.args[1] === 'merge')).toHaveLength(1);
  });
  it('resumes a checkpointed audit answer after partial enqueue without rerunning the model', async () => {
    const audit = '# Audit\n```json\n{"fixes":[{"title":"A","task":"First fix"},{"title":"B","task":"Second fix"}]}\n```';
    const { queue, daemon, daemonOptions, calls } = await fixture({ answers: { audit: [audit] } });
    daemon.state.mergedPrs = 10; await queue.save(daemon.state);
    await until(daemon, () => daemon.state.active?.stage === 'audit-enqueue');
    await enqueue(queue, '# Already enqueued\nFirst fix', 'audit-000010-fix-01.md');
    const modelCalls = calls.filter(c => c.bin !== 'git' && c.bin !== 'npm' && c.bin !== 'gh').length;
    const restarted = new Daemon(daemonOptions); await restarted.init(); await restarted.tick();
    expect(await readdir(join(queue.root, 'inbox'))).toEqual(['audit-000010-fix-01.md', 'audit-000010-fix-02.md']);
    expect(restarted.state.auditedThrough).toBe(10);
    expect(calls.filter(c => c.bin !== 'git' && c.bin !== 'npm' && c.bin !== 'gh')).toHaveLength(modelCalls);
  });
});
