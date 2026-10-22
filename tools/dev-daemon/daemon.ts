import { readFile, readlink, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fallback } from './fallback';
import { Queue, atomicWrite, exists } from './queue';
import { chains, readOnly, verdict } from './stages';
import { promptFor } from './prompts';
import { cleanupWorktree } from './worktrees';
import type { Execute, ModelsConfig, Result, Stage, State, Task } from './types';

const REPOSITORY = 'SUNBURN-Golden/geunbon-baby';
interface PullRequest { url: string; state: string; headRefOid: string; baseRefName: string }
export interface DaemonOptions {
  repo: string;
  queue: Queue;
  config: ModelsConfig;
  execute: Execute;
  blueprint?: string;
  now?: () => number;
  unknownResetMs?: number;
}

export class Daemon {
  state!: State;
  private commonDir = '';
  private readonly now: () => number;
  constructor(readonly options: DaemonOptions) { this.now = options.now ?? Date.now; }
  async init(): Promise<void> {
    await this.options.queue.init();
    this.state = await this.options.queue.load();
    await this.save();
    const result = await this.command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], this.options.repo, 'git-common-dir');
    this.commonDir = result.answer.trim();
    if (!this.commonDir.startsWith('/')) throw new Error('Cannot resolve shared Git directory');
  }
  private log(label: string): string {
    const task = this.state.active;
    return join(this.options.queue.root, 'logs', task?.id ?? 'daemon', `${String(task ? ++task.attempts : 0).padStart(5, '0')}-${label}.log`);
  }
  private async command(bin: string, args: string[], cwd: string, label: string, allowFailure = false): Promise<Result> {
    const result = await this.options.execute({ bin, args, cwd, log: this.log(label) });
    if (result.code !== 0 && !allowFailure) throw new Error(`${label} failed (exit ${result.code}); see task logs`);
    return result;
  }
  private save(): Promise<void> { return this.options.queue.save(this.state); }
  private async advance(stage: Stage): Promise<void> {
    this.state.active!.stage = stage;
    delete this.state.active!.wakeAt;
    await this.save();
  }
  private async fail(summary: string): Promise<void> {
    const task = this.state.active!;
    task.summary = this.options.queue.scrub(summary);
    if (task.kind === 'audit') {
      const report = join(this.options.queue.root, 'audits', `${task.id}.md`);
      const previous = await exists(report) ? await readFile(report, 'utf8') : '';
      await atomicWrite(report, `${previous}\n# Audit failed\n\n${task.summary}\n`);
      // Record this scheduled attempt; a broken provider must not create an infinite audit loop.
      this.state.auditedThrough = task.auditAt!;
    }
    await this.advance('failed');
  }
  // One durable transition per tick. A sleeping task remains the active task.
  async tick(): Promise<number> {
    if (!this.state.active) {
      if (this.state.mergedPrs >= this.state.auditedThrough + 10) await this.scheduleAudit();
      else await this.options.queue.claim(this.state);
      return this.state.active ? 0 : 5000;
    }
    const task = this.state.active;
    if (task.wakeAt && Date.parse(task.wakeAt) > this.now()) return Math.min(30000, Date.parse(task.wakeAt) - this.now());
    if (task.stage === 'done' || task.stage === 'failed') {
      // Keep cleanup outside the stage catch: a cleanup error must not rewrite a
      // successful merge or audit result as a new failure. Restart retries it.
      try {
        await cleanupWorktree({ task, queueRoot: this.options.queue.root, repo: this.options.repo,
          commonDir: this.commonDir, execute: this.options.execute, log: label => this.log(label) });
      } catch (error) {
        await atomicWrite(this.log('worktree-cleanup-error'), this.options.queue.scrub((error as Error).message) + '\n');
        throw error;
      }
      await this.options.queue.finish(this.state);
      return 0;
    }
    try {
      switch (task.stage) {
        case 'prepare': await this.prepare(task); break;
        case 'validate': await this.validate(task); break;
        case 'commit': await this.commit(task); break;
        case 'publish': await this.publish(task); break;
        case 'merge': await this.merge(task); break;
        case 'audit-enqueue': await this.completeAudit(task, task.outputs.audit!); break;
        default:
          if (!chains[task.stage]) throw new Error(`Unknown persisted stage: ${task.stage}`);
          await this.modelStage(task);
      }
    } catch (error) {
      if ((error as Error).message === 'Daemon stopping') throw error;
      await this.fail((error as Error).message);
    }
    return 0;
  }
  private async scheduleAudit(): Promise<void> {
    const auditAt = this.state.auditedThrough + 10;
    const id = `audit-${String(auditAt).padStart(6, '0')}`;
    const task: Task = { id, file: `${id}.md`, title: `Blueprint audit after ${auditAt} merged PRs`,
      body: 'Audit the blueprint, README, site structure and separate crawler. Recommend concrete fix tasks.',
      branch: `dev-daemon/${id}`, worktree: join(this.options.queue.root, 'worktrees', id), kind: 'audit',
      stage: 'prepare', round: 0, outputs: {}, attempts: 0, auditAt };
    // Persist intent before creating its markdown; restart can reconstruct the latter.
    this.state.active = task;
    await this.save();
    await atomicWrite(join(this.options.queue.root, 'running', task.file), `# ${task.title}\n\n${task.body}\n`);
  }
  private async prepare(task: Task): Promise<void> {
    if (task.kind === 'audit' && !await exists(join(this.options.queue.root, 'running', task.file))) {
      await atomicWrite(join(this.options.queue.root, 'running', task.file), `# ${task.title}\n\n${task.body}\n`);
    }
    if (!await exists(task.worktree)) {
      await this.command('git', ['check-ref-format', '--branch', task.branch], this.options.repo, 'check-branch');
      await this.command('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], this.options.repo, 'fetch-main');
      await this.command('git', ['worktree', 'add', '-b', task.branch, task.worktree, 'origin/main'], this.options.repo, 'worktree-add');
    } else {
      const common = await this.command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], task.worktree, 'verify-worktree');
      if (await realpath(common.answer.trim()) !== await realpath(this.commonDir)) throw new Error('Existing worktree belongs to another repository');
    }
    await this.checkBranch(task);
    if (task.kind === 'task') await this.command('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], task.worktree, 'npm-ci');
    await this.advance(task.kind === 'audit' ? 'audit' : 'design');
  }
  private async checkBranch(task: Task): Promise<void> {
    const branch = await this.command('git', ['branch', '--show-current'], task.worktree, 'verify-branch');
    if (branch.answer.trim() !== task.branch) throw new Error('Task worktree branch changed unexpectedly');
  }
  private async fingerprint(task: Task): Promise<string> {
    const digest = createHash('sha256');
    const head = await this.command('git', ['rev-parse', 'HEAD'], task.worktree, 'review-head');
    digest.update(head.answer);
    // Hash final file content regardless of staging, so interruption after
    // git add does not invalidate an otherwise identical reviewed worktree.
    const files = await this.command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], task.worktree, 'review-files');
    const baseline = await this.command('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], task.worktree, 'review-baseline');
    const eligible = new Set(files.answer.split('\0').filter(Boolean));
    const baselinePaths = new Set(baseline.answer.split('\0').filter(Boolean));
    const paths = new Set([...eligible, ...baselinePaths]);
    for (const file of [...paths].sort()) {
      const path = resolve(task.worktree, file);
      if (!path.startsWith(task.worktree + '/')) throw new Error('Unexpected review path');
      try {
        const info = await lstat(path);
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error('Review cannot fingerprint this file type');
        digest.update(file + '\0' + String(eligible.has(file)) + '\0');
        digest.update(String(info.mode)).update('\0').update(info.isSymbolicLink() ? await readlink(path) : await readFile(path)).update('\0');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (baselinePaths.has(file)) digest.update(file + '\0deleted\0');
      }
    }
    return digest.digest('hex');
  }
  private async modelStage(task: Task): Promise<void> {
    const stage = task.stage;
    let blueprint: string;
    try { blueprint = await readFile(this.options.blueprint ?? '/workspace/agamajung/TASK.md', 'utf8'); }
    catch { throw new Error('Blueprint TASK.md cannot be read'); }
    await this.checkBranch(task);
    const before = readOnly(stage) ? await this.fingerprint(task) : undefined;
    let reviewContext = '';
    if (stage === 'build-review' || stage === 're-review') {
      const diff = await this.command('git', ['diff', '--no-ext-diff', '--no-textconv', 'origin/main', '--'], task.worktree, 'review-main-diff');
      const files = await this.command('git', ['ls-files', '--others', '--exclude-standard'], task.worktree, 'review-new-files');
      reviewContext = `\nTracked diff against origin/main (inspect these files and surrounding code):\n${diff.answer}\nUntracked paths to read as part of the review:\n${files.answer}`;
    }
    // Checkpoint the attempt number before invoking a potentially interrupted process.
    const invocation = ++task.attempts;
    await this.save();
    const result = await fallback({ config: this.options.config, choices: chains[stage]!, prompt: promptFor(task, blueprint) + reviewContext,
      cwd: task.worktree, readOnly: readOnly(stage), execute: this.options.execute, now: this.now,
      unknownResetMs: this.options.unknownResetMs, protectedRoots: [this.options.repo, this.commonDir, this.options.queue.root],
      logPath: (choice, index) => join(this.options.queue.root, 'logs', task.id, `${String(invocation).padStart(5, '0')}-${stage}-${task.round}-${index}-${choice.model}.log`),
    });
    if (before && before !== await this.fingerprint(task)) throw new Error('Read-only stage modified the worktree; inspect logs and changes');
    if (result.kind === 'pause') { task.wakeAt = result.wakeAt; task.summary = result.summary; await this.save(); return; }
    if (result.kind === 'failed') { await this.fail(result.summary); return; }
    task.outputs[stage] = this.options.queue.scrub(result.answer);
    delete task.summary;
    switch (stage) {
      case 'design': await this.advance('design-review'); break;
      case 'design-review': {
        const decision = verdict(result.answer);
        if (!decision) throw new Error('Design review did not return an unambiguous VERDICT');
        await this.advance(decision === 'CHANGES' ? 'design-revise' : 'build'); break;
      }
      case 'design-revise': await this.advance('build'); break;
      case 'build': await this.advance('build-review'); break;
      case 'build-review': case 're-review': {
        const decision = verdict(result.answer);
        if (!decision) throw new Error('Build review did not return an unambiguous VERDICT');
        task.verdict = decision;
        if (decision === 'APPROVE') { task.reviewedFingerprint = before; await this.advance('validate'); }
        else if (task.round >= 2) await this.fail('Review still requests changes after two fix/re-review rounds');
        else { task.round++; await this.advance('review-fix'); }
        break;
      }
      case 'review-fix': await this.advance('re-review'); break;
      case 'audit': await this.advance('audit-enqueue'); break;
    }
  }
  private async validate(task: Task): Promise<void> {
    if (task.verdict !== 'APPROVE') throw new Error('Validation requires final review approval');
    await this.checkBranch(task);
    if (await this.fingerprint(task) !== task.reviewedFingerprint) throw new Error('Worktree changed after final review');
    for (const [label, args] of [['lint', ['run', 'lint']], ['typecheck', ['run', 'typecheck']],
      ['test', ['test']], ['build', ['run', 'build']]] as const) {
      await this.command('npm', [...args], task.worktree, `check-${label}`);
    }
    if (await this.fingerprint(task) !== task.reviewedFingerprint) throw new Error('Validation commands modified reviewed files');
    await this.command('git', ['add', '-A'], task.worktree, 'git-add');
    task.validatedTree = (await this.command('git', ['write-tree'], task.worktree, 'validated-tree')).answer.trim();
    task.validatedParent = (await this.command('git', ['rev-parse', 'HEAD'], task.worktree, 'validated-parent')).answer.trim();
    await this.advance('commit');
  }
  private async commit(task: Task): Promise<void> {
    await this.checkBranch(task);
    if (task.verdict !== 'APPROVE' || !task.validatedTree || !task.validatedParent) throw new Error('Commit requires validated content and approval');
    const tree = (await this.command('git', ['write-tree'], task.worktree, 'check-validated-tree')).answer.trim();
    const unstaged = await this.command('git', ['diff', '--quiet'], task.worktree, 'check-unstaged', true);
    const untracked = await this.command('git', ['ls-files', '--others', '--exclude-standard'], task.worktree, 'check-untracked');
    if (tree !== task.validatedTree || unstaged.code !== 0 || untracked.answer.trim()) throw new Error('Content changed after validation');
    const head = (await this.command('git', ['rev-parse', 'HEAD'], task.worktree, 'check-commit-head')).answer.trim();
    if (head === task.validatedParent) {
      const diff = await this.command('git', ['diff', '--cached', '--quiet'], task.worktree, 'git-has-changes', true);
      if (diff.code !== 0 && diff.code !== 1) throw new Error('Cannot inspect staged changes');
      if (diff.code === 1) await this.command('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', task.title], task.worktree, 'git-commit');
    } else {
      // The daemon may have committed just before a crash. Reuse exactly that
      // single commit if its tree and parent match the validation checkpoint.
      const committedTree = (await this.command('git', ['rev-parse', 'HEAD^{tree}'], task.worktree, 'check-committed-tree')).answer.trim();
      const parent = (await this.command('git', ['rev-parse', 'HEAD^'], task.worktree, 'check-commit-parent')).answer.trim();
      if (committedTree !== task.validatedTree || parent !== task.validatedParent) throw new Error('HEAD changed after validation');
    }
    const ahead = await this.command('git', ['rev-list', '--count', 'origin/main..HEAD'], task.worktree, 'git-ahead');
    if (Number(ahead.answer.trim()) < 1) throw new Error('Task produced no changes to publish');
    task.commit = (await this.command('git', ['rev-parse', 'HEAD'], task.worktree, 'git-head')).answer.trim();
    await this.advance('publish');
  }
  private async findPr(task: Task): Promise<PullRequest | undefined> {
    const result = await this.command('gh', ['pr', 'list', '--repo', REPOSITORY, '--head', task.branch, '--base', 'main',
      '--state', 'all', '--json', 'url,state,headRefOid,baseRefName'], task.worktree, 'pr-lookup');
    const prs = JSON.parse(result.answer) as PullRequest[];
    if (!Array.isArray(prs) || prs.length > 1) throw new Error('Ambiguous PR lookup');
    return prs[0];
  }
  private async assertPublishable(task: Task): Promise<void> {
    if (task.verdict !== 'APPROVE' || !task.commit) throw new Error('Publication requires validation and review approval');
    await this.checkBranch(task);
    const head = (await this.command('git', ['rev-parse', 'HEAD'], task.worktree, 'check-publish-head')).answer.trim();
    const dirty = await this.command('git', ['status', '--porcelain'], task.worktree, 'check-publish-clean');
    if (head !== task.commit || dirty.answer.trim()) throw new Error('Worktree changed after validation');
  }
  private async publish(task: Task): Promise<void> {
    await this.assertPublishable(task);
    await this.command('git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${task.branch}`], task.worktree, 'git-push');
    let pr = await this.findPr(task);
    if (!pr) {
      const bodyPath = join(this.options.queue.root, 'logs', task.id, 'pr-body.md');
      await atomicWrite(bodyPath, this.options.queue.scrub(`${task.body}\n\n${task.outputs['review-fix'] ?? task.outputs.build}\n\nValidation: npm run lint, npm run typecheck, npm test, npm run build passed. Final review: APPROVE.\n`));
      await this.command('gh', ['pr', 'create', '--repo', REPOSITORY, '--base', 'main', '--head', task.branch,
        '--title', task.title, '--body-file', bodyPath], task.worktree, 'pr-create');
      pr = await this.findPr(task);
    }
    if (!pr || pr.baseRefName !== 'main' || pr.headRefOid !== task.commit || pr.state === 'CLOSED') throw new Error('PR does not match the validated commit and main base');
    task.pr = pr.url;
    await this.advance('merge');
  }
  private async merge(task: Task): Promise<void> {
    await this.assertPublishable(task);
    let pr = await this.findPr(task);
    if (!pr || pr.url !== task.pr || pr.baseRefName !== 'main' || pr.headRefOid !== task.commit) throw new Error('PR changed after validation');
    if (pr.state !== 'MERGED') {
      await this.command('gh', ['pr', 'merge', task.pr!, '--repo', REPOSITORY, '--squash', '--match-head-commit', task.commit!], task.worktree, 'pr-merge');
      pr = await this.findPr(task);
    }
    if (pr?.state !== 'MERGED') throw new Error('GitHub has not confirmed the squash merge');
    // Count and terminal stage in one atomic write. If killed after GitHub merges,
    // restart observes MERGED and increments exactly once.
    this.state.mergedPrs++;
    task.summary = `Merged ${task.pr} with squash after approval and all four checks passed.`;
    await this.advance('done');
  }
  private async completeAudit(task: Task, answer: string): Promise<void> {
    await atomicWrite(join(this.options.queue.root, 'audits', `${task.id}.md`), this.options.queue.scrub(answer) + '\n');
    const blocks = [...answer.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    if (!blocks.length) throw new Error('Audit report has no JSON fix list');
    const parsed: unknown = JSON.parse(blocks[blocks.length - 1][1]);
    const fixes = (parsed as { fixes?: unknown })?.fixes;
    if (!Array.isArray(fixes) || fixes.length > 20) throw new Error('Audit fix list must be an array of at most 20 tasks');
    const valid = fixes.map((fix: unknown) => {
      const entry = fix as { title?: unknown; task?: unknown };
      if (!entry || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 200 ||
        typeof entry.task !== 'string' || !entry.task.trim() || entry.task.length > 20000) throw new Error('Invalid audit fix task');
      return { title: entry.title, task: entry.task };
    });
    for (const [index, fix] of valid.entries()) {
      const file = `${task.id}-fix-${String(index + 1).padStart(2, '0')}.md`;
      // Enqueue atomically; scheduled audit always finishes before another task is claimed.
      // Deterministic filenames make retries after partial enqueue idempotent.
      const path = join(this.options.queue.root, 'inbox', file);
      await atomicWrite(path, this.options.queue.scrub(`---\ntitle: ${JSON.stringify(fix.title)}\n---\n\n${fix.task}\n`));
    }
    this.state.auditedThrough = task.auditAt!;
    task.summary = `Audit report saved; enqueued ${valid.length} fix tasks.`;
    await this.advance('done');
  }
}
