import { realpath } from 'node:fs/promises';
import { atomicWrite, exists } from './queue';
import { registrations } from './worktrees';
import type { Execute, Result, Task } from './types';

interface PrepareOptions {
  task: Task;
  repo: string;
  commonDir: string;
  execute: Execute;
  log: (label: string) => string;
  scrub: (text: string) => string;
  now: () => number;
}
const REPOSITORY = 'SUNBURN-Golden/geunbon-baby';
const STALE_NAME_ATTEMPTS = 100;

/** Called under the queue lock. External Git/PR operations must not run concurrently. */
export async function prepareWorktree(options: PrepareOptions): Promise<void> {
  const { task, repo } = options;
  const command = async (bin: string, args: string[], cwd: string, label: string): Promise<Result> => {
    const result = await options.execute({ bin, args, cwd, log: options.log(label) });
    if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}); see task logs`);
    return result;
  };
  const git = (args: string[], label: string) => command('git', args, repo, label);
  if (await exists(task.worktree)) {
    const common = await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], task.worktree, 'verify-worktree');
    if (await realpath(common.answer.trim()) !== await realpath(options.commonDir)) {
      throw new Error('Existing worktree belongs to another repository');
    }
    return; // The caller still verifies the branch before resuming/installing.
  }

  await git(['check-ref-format', '--branch', task.branch], 'check-branch');
  const unused = async () => {
    const result = await git(['worktree', 'list', '--porcelain', '-z'], 'prepare-worktree-list');
    const used = registrations(result.answer).find(record => record.branch === `refs/heads/${task.branch}`);
    if (used) throw new Error(`Branch preparation blocked: ${task.branch} is used by worktree ${JSON.stringify(used.rawPath)}.`);
  };
  const branchCommit = async (branch: string): Promise<string | undefined> => {
    const ref = `refs/heads/${branch}`;
    const result = await git(['for-each-ref', '--format=%(refname)%00%(objectname)', ref], 'prepare-branch-ref');
    if (!result.answer) return undefined;
    // for-each-ref may also return child refs. Parse every row, then compare exactly.
    if (!result.answer.endsWith('\n')) throw new Error('Cannot parse local branch refs; branch unchanged; see task logs.');
    const seen = new Set<string>();
    let commit: string | undefined;
    for (const row of result.answer.slice(0, -1).split('\n')) {
      const match = /^(refs\/heads\/[^\s\0]+)\0([0-9a-f]{40}|[0-9a-f]{64})$/.exec(row);
      if (!match || seen.has(match[1]) || (match[1] !== ref && !match[1].startsWith(ref + '/'))) {
        throw new Error('Cannot parse local branch refs; branch unchanged; see task logs.');
      }
      seen.add(match[1]);
      if (match[1] === ref) commit = match[2];
    }
    return commit;
  };
  const noOpenPr = async () => {
    let prs: { number: number; url: string; headRefName: string; baseRefName: string }[];
    try {
      const result = await command('gh', ['pr', 'list', '--repo', REPOSITORY, '--head', task.branch,
        '--state', 'open', '--json', 'number,url,headRefName,baseRefName'], repo, 'prepare-pr-lookup');
      const parsed: unknown = JSON.parse(result.answer);
      if (!Array.isArray(parsed) || parsed.some(pr => !pr || typeof pr !== 'object' ||
        !Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.url !== 'string' ||
        pr.url !== `https://github.com/${REPOSITORY}/pull/${pr.number}` ||
        pr.headRefName !== task.branch || typeof pr.baseRefName !== 'string' || !pr.baseRefName.trim())) {
        throw new Error('Invalid open PR response');
      }
      prs = parsed;
    } catch (error) {
      if ((error as Error).message === 'Daemon stopping') throw error;
      throw new Error('Branch preparation blocked: open PR lookup failed; branch unchanged; see task logs.');
    }
    if (prs.length) throw new Error(`Branch preparation blocked: ${task.branch} has open PR ${
      prs.map(pr => `#${pr.number} (${pr.url})`).join(', ')}.`);
  };

  await unused();
  const original = await branchCommit(task.branch);
  if (original) await noOpenPr(); // Fresh tasks do not require gh in preparation.
  await git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 'fetch-main');
  const main = (await git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], 'prepare-main-commit')).answer.trim();
  if (!/^[0-9a-f]+$/.test(main)) throw new Error('Cannot resolve fetched main commit; branch unchanged; see task logs.');

  let stale: string | undefined;
  if (original) {
    const now = options.now();
    for (let attempt = 0; attempt < STALE_NAME_ATTEMPTS; attempt++) {
      const candidate = `${task.branch}-stale-${new Date(now + attempt).toISOString().replace(/[-:.]/g, '')}`;
      if (!await branchCommit(candidate)) { stale = candidate; break; }
    }
    if (!stale) throw new Error('Branch preparation blocked: stale branch names exhausted; branch unchanged; see task logs.');
    await unused();
    if (await branchCommit(task.branch) !== original) {
      throw new Error('Branch preparation blocked: local branch changed during preparation; branch unchanged; see task logs.');
    }
    await noOpenPr();
    await git(['branch', '-m', task.branch, stale], 'prepare-branch-preserve');
    if (await branchCommit(stale) !== original) throw new Error(`Cannot verify preserved branch ${stale}; see task logs.`);
    await atomicWrite(options.log('prepare-branch-preserved'), options.scrub(
      `Original branch: ${task.branch}\nPreserved branch: ${stale}\nCommit: ${original}\n`));
  }

  // Do not rename a branch that appeared after the initial absence check.
  await unused();
  if (await branchCommit(task.branch)) {
    throw new Error(`Branch preparation blocked: ${task.branch} appeared during preparation; see task logs.`);
  }
  try {
    await git(['worktree', 'add', '-b', task.branch, task.worktree, main], 'worktree-add');
  } catch (error) {
    if ((error as Error).message === 'Daemon stopping') throw error;
    if (stale) throw new Error(`Worktree creation failed; previous branch preserved as ${stale}; see task logs.`);
    throw error;
  }
}
