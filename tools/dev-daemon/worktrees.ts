import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { Execute, Result, Task } from './types';

interface CleanupOptions {
  task: Task;
  queueRoot: string;
  repo: string;
  commonDir: string;
  execute: Execute;
  log: (label: string) => string;
}
export interface Registration { path: string; rawPath: string; bare: boolean; branch?: string }

// Include equality, and compare directory boundaries rather than name prefixes.
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

// Resolve even a missing registration through its nearest existing ancestor.
// This catches aliases of the target as well as paths inside a removed target.
async function physical(path: string): Promise<string> {
  if (await info(path)) return realpath(path);
  const parent = dirname(path);
  if (parent === path) throw new Error('Cannot resolve worktree path');
  return join(await physical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}

async function checkTargetPath(target: string): Promise<boolean> {
  let present = false;
  for (let path = target; ; path = dirname(path)) {
    const entry = await info(path);
    if (path === target) present = Boolean(entry);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error('Unsafe worktree path or ancestor');
    if (dirname(path) === path) break;
  }
  if (await physical(target) !== target) throw new Error('Worktree path escapes its expected location');
  return present;
}

export function registrations(output: string): Registration[] {
  if (!output.endsWith('\0\0')) throw new Error('Cannot parse worktree registrations');
  const records = output.slice(0, -2).split('\0\0').map(record => {
    const [header, ...fields] = record.split('\0');
    const path = header.startsWith('worktree ') ? header.slice(9) : '';
    if (!isAbsolute(path) || path.includes('\0') || fields.some(field =>
      !/^(?:HEAD [0-9a-f]+|branch refs\/\S+|detached|bare|locked(?: [\s\S]*)?|prunable(?: [\s\S]*)?)$/.test(field))) {
      throw new Error('Cannot parse worktree registrations');
    }
    const keys = fields.map(field => field.split(' ', 1)[0]);
    if (new Set(keys).size !== keys.length || fields.filter(field => /^(HEAD |bare$)/.test(field)).length !== 1) {
      throw new Error('Ambiguous worktree registration');
    }
    return { path: normalize(path), rawPath: path, bare: fields.includes('bare'),
      branch: fields.find(field => field.startsWith('branch '))?.slice(7) };
  });
  if (!records.length || new Set(records.map(record => record.path)).size !== records.length) {
    throw new Error('Ambiguous worktree registrations');
  }
  return records;
}

/** Only the active terminal task may be removed. The caller records deferred cleanup independently of archival. */
export async function cleanupWorktree(options: CleanupOptions): Promise<void> {
  const { task } = options;
  if (task.stage !== 'done' && task.stage !== 'failed') throw new Error('Cannot clean an unfinished task');
  if (typeof task.id !== 'string' || !task.id || task.id === '.' || task.id === '..' ||
    ['/', '\\', '\0'].some(character => task.id.includes(character))) {
    throw new Error('Unsafe task ID for worktree cleanup');
  }
  const target = resolve(options.queueRoot, 'worktrees', task.id);
  if (typeof task.worktree !== 'string' || task.worktree !== target) throw new Error('Unexpected task worktree path');
  await checkTargetPath(target);
  const repo = await realpath(options.repo);
  const common = await realpath(options.commonDir);
  const cwd = await realpath(process.cwd());
  for (const protectedPath of [resolve(options.repo), repo, resolve(options.commonDir), common, process.cwd(), cwd]) {
    if (contains(target, protectedPath)) throw new Error('Worktree cleanup would remove a protected location');
  }
  const git = async (args: string[], label: string): Promise<Result> => {
    const result = await options.execute({ bin: 'git', args, cwd: repo,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, log: options.log(`worktree-cleanup-${label}`) });
    if (result.code !== 0) throw new Error(`Worktree cleanup ${label} failed (exit ${result.code}); see task logs`);
    return result;
  };
  const readList = async () => registrations((await git(['worktree', 'list', '--porcelain', '-z'], 'list')).answer);

  const inspect = async () => {
    const present = await checkTargetPath(target);
    const repoCommon = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], 'verify-repo')).answer.trim();
    if (!isAbsolute(repoCommon) || await realpath(repoCommon) !== common) throw new Error('Cleanup repository changed');
    const records = await readList();
    const main = records[0].path;
    for (const protectedPath of [resolve(options.repo), repo, main, await physical(records[0].rawPath),
      resolve(options.commonDir), common, process.cwd(), cwd]) {
      if (contains(target, protectedPath)) throw new Error('Worktree cleanup would remove a protected location');
    }
    // Check every registration, including locked and missing worktrees. An
    // enclosing remove --force recursively deletes even another live worktree.
    for (const record of records) {
      if (record.path === target) continue;
      if (contains(target, record.path) || contains(target, await physical(record.rawPath))) {
        throw new Error('Worktree cleanup would remove another registered worktree');
      }
    }
    const registration = records.find(record => record.path === target);
    if (registration?.bare || registration === records[0]) throw new Error('Cannot remove the main or bare worktree');
    if (present) {
      if (!registration) throw new Error('Worktree cleanup refuses an unregistered directory');
      const dotGit = await info(join(target, '.git'));
      if (!dotGit?.isFile() || dotGit.isSymbolicLink()) throw new Error('Target is not a linked worktree');
      // Use -C with an argument array; all processes still start outside target.
      const targetCommon = (await git(['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'], 'verify-common')).answer.trim();
      if (!isAbsolute(targetCommon) || await realpath(targetCommon) !== common) throw new Error('Worktree belongs to another repository');
      const top = (await git(['-C', target, 'rev-parse', '--show-toplevel'], 'verify-root')).answer.trim();
      if (!isAbsolute(top) || await realpath(top) !== target) throw new Error('Cannot identify worktree root');
      const admin = (await git(['-C', target, 'rev-parse', '--absolute-git-dir'], 'verify-admin')).answer.trim();
      const adminRoot = join(common, 'worktrees');
      if (!isAbsolute(admin) || dirname(admin) !== adminRoot || await realpath(admin) !== admin ||
        await realpath(adminRoot) !== adminRoot) throw new Error('Cannot identify linked worktree metadata');
      if (await readFile(join(admin, 'gitdir'), 'utf8') !== join(target, '.git') + '\n') {
        throw new Error('Linked worktree metadata does not match target');
      }
    }
    return { present, registration, records };
  };

  const checkPrune = async (records: Registration[]) => {
    const dry = await git(['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'], 'prune-preview');
    // Git reports admin directory names, not worktree paths. Resolve each name
    // through its gitdir file and require an exact registration for this task.
    // Unknown/localized diagnostics or malformed metadata fail closed.
    const output = dry.output;
    if (!output) return;
    for (const line of output.replace(/\n$/, '').split('\n')) {
      const match = /^Removing worktrees\/([^/:]+): [^\n]+$/.exec(line);
      if (!match || match[1] === '.' || match[1] === '..' ||
        [...match[1]].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        throw new Error('Cannot identify prune candidate');
      }
      const admin = join(common, 'worktrees', match[1]);
      if (await realpath(admin) !== admin) throw new Error('Unsafe prune metadata');
      const file = join(admin, 'gitdir');
      if (!(await info(file))?.isFile()) throw new Error('Cannot identify prune metadata');
      const gitdir = await readFile(file, 'utf8');
      if (gitdir !== join(target, '.git') + '\n' || !records.some(record => record.path === target)) {
        throw new Error('Prune would affect another worktree');
      }
    }
  };

  // No prune command (including dry-run) is allowed before nested protection.
  let snapshot = await inspect();
  if (!snapshot.present && !snapshot.registration) return; // Already cleaned, or prepare never created it.
  await checkPrune(snapshot.records);
  // Recheck paths and the entire list after the preview, immediately before remove.
  snapshot = await inspect();
  if (snapshot.present) await git(['worktree', 'remove', '--force', target], 'remove');
  snapshot = await inspect();
  if (snapshot.present) throw new Error('Worktree directory remains after removal');
  await checkPrune(snapshot.records);
  await git(['worktree', 'prune', '--expire', 'now'], 'prune');
  const final = await inspect();
  if (final.present || final.registration) throw new Error('Worktree cleanup is incomplete');
}
