import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link, unlink, rename, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../tools/dev-daemon/models.json';
import { Daemon } from '../tools/dev-daemon/daemon';
import { parseTask, Queue } from '../tools/dev-daemon/queue';
import type { Command, Execute, ModelsConfig, Result, Stage } from '../tools/dev-daemon/types';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink), rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => {
  vi.mocked(link).mockReset().mockImplementation(actualFs.link);
  vi.mocked(unlink).mockReset().mockImplementation(actualFs.unlink);
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
});

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
    if (answers[stage] && !answers[stage]!.length) throw new Error(`Unexpected extra model call for ${stage}`);
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
    const finished = daemon.state.active!;
    await daemon.tick();
    expect(daemon.state.active).toBeUndefined();
    const summary = await readFile(join(queue.root, 'done', `${finished.id}.summary.md`), 'utf8');
    expect(summary).toContain('-design-review-');
    expect(summary).toContain('-build-review-');
    expect(summary).toContain('-re-review-');
    expect(summary).toContain('answer source');
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
    const { queue, daemon, calls } = await fixture({ answers: { 'build-review': Array.from({ length: 8 }, () => 'Looks good') } });
    await enqueue(queue);
    await until(daemon, () => daemon.state.active?.stage === 'failed');
    expect(daemon.state.active?.summary).toContain('VERDICT');
    expect(calls.some(c => c.bin === 'gh' || (c.bin === 'npm' && c.args[0] !== 'ci') || c.args.includes('commit'))).toBe(false);
    expect(calls.filter(c => basename(c.log).includes('clarification'))).toHaveLength(4);
    await daemon.tick();
    expect(daemon.state.active).toBeUndefined();
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
    const { queue, daemon, daemonOptions, calls } = await fixture({ answers: { design: [...Array.from({ length: 4 }, () => ({
      code: 0, output: 'quota resets 2026-10-21T01:00:00Z', answer: '', stderr: 'quota resets 2026-10-21T01:00:00Z',
    })), 'Task complete'] } });
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

async function terminalFixture() {
  const f = await fixture();
  await enqueue(f.queue, '# Terminal task\nOriginal request');
  await f.daemon.tick();
  const task = f.daemon.state.active!;
  task.stage = 'failed'; task.summary = 'Original review failure';
  await f.queue.save(f.daemon.state);
  return { ...f, task, source: join(f.queue.root, 'running', task.file),
    destination: join(f.queue.root, 'failed', task.file), summary: join(f.queue.root, 'failed', `${task.id}.summary.md`) };
}

describe('restart-safe no-clobber archival', () => {
  it.each(['task', 'summary', 'directory', 'symlink'] as const)('preflights conflicting %s without modifying source, archive or checkpoint', async conflict => {
    const f = await terminalFixture();
    const target = conflict === 'summary' ? f.summary : f.destination;
    if (conflict === 'directory') await mkdir(target);
    else if (conflict === 'symlink') await symlink(f.source, target);
    else await writeFile(target, 'conflicting contents');
    const before = await readFile(join(f.queue.root, 'status.json'), 'utf8');
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('Archive conflict');
    expect(await readFile(f.source, 'utf8')).toBe('# Terminal task\nOriginal request');
    expect(await readFile(join(f.queue.root, 'status.json'), 'utf8')).toBe(before);
    if (conflict === 'symlink') expect((await lstat(target)).isSymbolicLink()).toBe(true);
    else if (conflict !== 'directory') expect(await readFile(target, 'utf8')).toBe('conflicting contents');
  });
  it('rejects missing source plus missing archive and uncertain legacy identity', async () => {
    const f = await terminalFixture();
    await unlink(f.source);
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('both missing');
    await writeFile(f.destination, '# Another task\nWrong body');
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('legacy task identity');
    expect(f.daemon.state.active).toBeDefined();
    expect(await readdir(join(f.queue.root, 'failed'))).toEqual([f.task.file]);
  });
  it('validates and recovers a legacy partial archive with no finalization metadata', async () => {
    const f = await terminalFixture();
    await rename(f.source, f.destination);
    await f.queue.finish(f.daemon.state);
    expect(f.daemon.state.active).toBeUndefined();
    expect(await readFile(f.summary, 'utf8')).toContain('Original review failure');
  });
  it.each(['summary', 'task'] as const)('cannot clobber a conflicting %s appearing after preflight', async target => {
    const f = await terminalFixture();
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (String(destination) === (target === 'summary' ? f.summary : f.destination)) await writeFile(destination, 'appeared concurrently');
      return actualFs.link(source, destination);
    });
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('Archive conflict');
    expect(await readFile(target === 'summary' ? f.summary : f.destination, 'utf8')).toBe('appeared concurrently');
    expect(await readFile(f.source, 'utf8')).toBe('# Terminal task\nOriginal request');
    expect((await f.queue.load()).active?.finalization).toBeDefined();
  });
  it.each(['intent', 'summary', 'link', 'unlink', 'clear-active'] as const)('recovers interruption after %s without duplicate archival', async point => {
    const f = await terminalFixture();
    const save = f.queue.save.bind(f.queue);
    let interrupted = false;
    f.queue.save = async state => {
      await save(state);
      if (!interrupted && ((point === 'intent' && state.active?.finalization) || (point === 'clear-active' && !state.active))) {
        interrupted = true; throw new Error('Daemon stopping');
      }
    };
    vi.mocked(link).mockImplementation(async (source, destination) => {
      await actualFs.link(source, destination);
      if (!interrupted && ((point === 'summary' && String(destination) === f.summary) || (point === 'link' && String(destination) === f.destination))) {
        interrupted = true; throw new Error('Daemon stopping');
      }
    });
    vi.mocked(unlink).mockImplementation(async source => {
      await actualFs.unlink(source);
      if (!interrupted && point === 'unlink' && String(source) === f.source) { interrupted = true; throw new Error('Daemon stopping'); }
    });
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('Daemon stopping');
    f.queue.save = save;
    const checkpoint = await f.queue.load();
    if (checkpoint.active) await f.queue.finish(checkpoint);
    expect(checkpoint.active).toBeUndefined();
    expect((await f.queue.load()).active).toBeUndefined();
    expect(await readdir(join(f.queue.root, 'failed'))).toEqual([f.task.file, `${f.task.id}.summary.md`].sort());
    expect(await readdir(join(f.queue.root, 'running'))).toEqual([]);
    expect(await readFile(f.destination, 'utf8')).toBe('# Terminal task\nOriginal request');
  });
  it('retains active in memory and on disk if the final checkpoint cannot be written', async () => {
    const f = await terminalFixture();
    const save = f.queue.save.bind(f.queue);
    f.queue.save = async state => { if (!state.active) throw new Error('disk full'); await save(state); };
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('disk full');
    expect(f.daemon.state.active?.stage).toBe('failed');
    const saved = await f.queue.load();
    expect(saved.active?.finalization).toBeDefined();
    // Frozen scrubbed content survives later in-memory summary changes.
    const summary = await readFile(f.summary, 'utf8');
    f.daemon.state.active!.summary = 'Later mutable text';
    f.queue.save = save;
    await f.queue.finish(f.daemon.state);
    expect(await readFile(f.summary, 'utf8')).toBe(summary);
    expect(summary).toContain('Original review failure');
  });
  it('does not mutate archival files if intent persistence fails', async () => {
    const f = await terminalFixture();
    f.queue.save = async () => { throw new Error('disk full'); };
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('disk full');
    expect(await readdir(join(f.queue.root, 'failed'))).toEqual([]);
    expect(f.daemon.state.active?.finalization).toBeUndefined();
    expect((await f.queue.load()).active?.finalization).toBeUndefined();
  });
  it('retains a terminal task on archival I/O failure, retries in-process, and never claims the next task', async () => {
    const f = await terminalFixture();
    await enqueue(f.queue, '# Next\nNext request', '002.md');
    // All renames, including diagnostic log publication, fail with full storage.
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    for (let i = 0; i < 3; i++) expect(await f.daemon.tick()).toBe(30000);
    expect(f.daemon.state.active?.id).toBe(f.task.id);
    expect((await f.queue.load()).active?.stage).toBe('failed');
    expect(await readdir(join(f.queue.root, 'inbox'))).toEqual(['002.md']);
    vi.mocked(rename).mockImplementation(actualFs.rename);
    await f.daemon.tick();
    expect(f.daemon.state.active).toBeUndefined();
    await f.daemon.tick();
    expect(f.daemon.state.active?.title).toBe('Next');
  });
  it('blocks queue progress on archive conflicts without overwriting either side', async () => {
    const f = await terminalFixture();
    await enqueue(f.queue, '# Next\nNext request', '002.md');
    await writeFile(f.destination, 'foreign task');
    for (let i = 0; i < 2; i++) expect(await f.daemon.tick()).toBe(30000);
    expect(await readFile(f.destination, 'utf8')).toBe('foreign task');
    expect(await readFile(f.source, 'utf8')).toBe('# Terminal task\nOriginal request');
    expect(await readdir(join(f.queue.root, 'inbox'))).toEqual(['002.md']);
  });
});

describe('durable review stage integration', () => {
  it.each(['design-review', 'build-review', 're-review'] as const)('exhausted %s ambiguity cannot reach checks, commit or publication', async stage => {
    const f = await fixture({ answers: { [stage]: Array.from({ length: 8 }, () => 'Inspection in progress') } });
    await enqueue(f.queue);
    await until(f.daemon, () => f.daemon.state.active?.stage === (stage === 'design-review' ? stage : 'build-review'));
    f.daemon.state.active!.stage = stage;
    await f.daemon.tick();
    expect(f.daemon.state.active?.stage).toBe('failed');
    expect(f.daemon.state.active?.round).toBe(0);
    expect(f.calls.filter(c => c.log.includes(`-${stage}-`) && c.log.includes('clarification'))).toHaveLength(4);
    expect(f.calls.some(c => c.bin === 'gh' || c.args.includes('commit') || (c.bin === 'npm' && c.log.includes('check-')))).toBe(false);
  });
  it('clarification-only CHANGES fails without consuming a fix/revision round', async () => {
    const f = await fixture({ answers: { 'build-review': ['I will inspect', 'VERDICT: CHANGES'] } });
    await enqueue(f.queue);
    await until(f.daemon, () => f.daemon.state.active?.stage === 'failed');
    expect(f.daemon.state.active?.round).toBe(0);
    expect(f.daemon.state.active?.summary).toContain('incomplete review');
    expect(f.daemon.state.active?.reviewProgress?.attempts[0].original.result?.answer).toBe('I will inspect');
    expect(f.calls.some(c => c.log.includes('-review-fix-'))).toBe(false);
  });
  it.each([false, true])('reuses completed review only with unchanged content (changed=%s)', async changed => {
    const f = await fixture({ answers: { 'build-review': changed ? ['VERDICT: APPROVE', 'VERDICT: CHANGES'] : ['VERDICT: APPROVE'] } });
    await enqueue(f.queue);
    await until(f.daemon, () => f.daemon.state.active?.stage === 'build-review');
    const task = f.daemon.state.active!;
    const save = f.queue.save.bind(f.queue);
    f.queue.save = async state => {
      if (state.active?.stage === 'validate') throw new Error('Daemon stopping');
      await save(state);
    };
    await expect(f.daemon.tick()).rejects.toThrow('Daemon stopping');
    const before = (await f.queue.load()).active!;
    expect(before.stage).toBe('build-review');
    expect(before.reviewProgress?.attempts[0].original.status).toBe('completed');
    if (changed) await writeFile(join(task.worktree, 'file.ts'), 'Changed after review');
    f.queue.save = save;
    const restarted = new Daemon(f.daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active?.stage).toBe(changed ? 'review-fix' : 'validate');
    expect(f.calls.filter(c => /-build-review-\d+-\d+-/.test(c.log))).toHaveLength(changed ? 2 : 1);
    if (changed) expect(restarted.state.active?.reviewProgress?.key).not.toBe(before.reviewProgress?.key);
  });
  it('resumes consumed clarification after daemon restart with distinct logs and no extra same-model call', async () => {
    const f = await fixture({ answers: { 'build-review': ['Inspection in progress', 'VERDICT: APPROVE'] } });
    await enqueue(f.queue);
    await until(f.daemon, () => f.daemon.state.active?.stage === 'build-review');
    const save = f.queue.save.bind(f.queue);
    let interrupted = false;
    f.queue.save = async state => {
      await save(state);
      if (!interrupted && state.active?.reviewProgress?.attempts[0]?.clarification?.status === 'issued') {
        interrupted = true; throw new Error('Daemon stopping');
      }
    };
    await expect(f.daemon.tick()).rejects.toThrow('Daemon stopping');
    f.queue.save = save;
    const restarted = new Daemon(f.daemonOptions); await restarted.init(); await restarted.tick();
    expect(restarted.state.active?.stage).toBe('validate');
    const invocations = f.calls.filter(c => /-build-review-\d+-\d+-/.test(c.log));
    expect(invocations).toHaveLength(2);
    expect(invocations[0].args).not.toContain('--model'); // Original GLM.
    expect(invocations[1].args).toContain('sonnet');
    expect(restarted.state.active?.reviewProgress?.attempts[0].clarification?.outcome).toContain('consumed');
    expect(new Set(invocations.map(c => c.log)).size).toBe(2);
  });
});

describe('legacy archival compatibility', () => {
  it('reuses a matching legacy summary while recovering its moved task', async () => {
    const f = await terminalFixture();
    await rename(f.source, f.destination);
    const summary = `# ${f.task.title}\n\n${f.task.summary}\n\nBranch: ${f.task.branch}\nPR: none\nWorktree: ${f.task.worktree}\n`;
    await writeFile(f.summary, summary);
    await f.daemon.tick();
    expect(f.daemon.state.active).toBeUndefined();
    expect(await readFile(f.summary, 'utf8')).toBe(summary);
  });
  it('fails closed if a legacy archive lacks the explicit branch in the checkpoint', async () => {
    const f = await terminalFixture();
    await rename(f.source, f.destination);
    f.task.branch = 'custom/branch';
    await f.queue.save(f.daemon.state);
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('legacy task identity');
    expect(await readFile(f.destination, 'utf8')).toBe('# Terminal task\nOriginal request');
  });
});

describe('legacy audit recovery', () => {
  it('validates the deterministic audit Markdown against its terminal checkpoint', async () => {
    const f = await terminalFixture();
    f.task.kind = 'audit'; f.task.body = 'Audit blueprint'; f.task.auditAt = 10;
    f.daemon.state.auditedThrough = 10;
    await writeFile(f.source, `# ${f.task.title}\n\n${f.task.body}\n`);
    await f.queue.save(f.daemon.state);
    await rename(f.source, f.destination);
    await f.queue.finish(f.daemon.state);
    expect(f.daemon.state.active).toBeUndefined();
    expect(f.daemon.state.auditedThrough).toBe(10);
  });
});

describe('empty task archival', () => {
  it('preserves an empty original task when its linked archive disappears before validation', async () => {
    const f = await terminalFixture();
    await writeFile(f.source, '');
    vi.mocked(link).mockImplementation(async (source, destination) => {
      await actualFs.link(source, destination);
      if (String(destination) === f.destination) await actualFs.unlink(destination);
    });
    await expect(f.queue.finish(f.daemon.state)).rejects.toThrow('Archive conflict');
    expect(await readFile(f.source, 'utf8')).toBe('');
    expect(f.daemon.state.active?.stage).toBe('failed');
  });
});
