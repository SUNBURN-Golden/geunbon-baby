import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { mkdir, readFile, readdir, rename, open, stat, lstat, link, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { redactor } from './runner';
import type { State, Task } from './types';

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path); await syncDirectory(dirname(path));
  }
  finally { await unlink(temp).catch(() => {}); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
const sameBytes = (bytes: Uint8Array | undefined, text: string) => bytes !== undefined && Buffer.compare(bytes, Buffer.from(text)) === 0;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function archiveFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Archive conflict: unexpected file type');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (info.ino !== opened.ino || info.dev !== opened.dev || !opened.isFile()) throw new Error('Archive conflict: file changed during inspection');
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** Publish completed bytes exclusively. POSIX rename would overwrite a racer. */
async function publishSummary(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const published = await archiveFile(path);
    if (!sameBytes(published, content)) throw new Error('Archive conflict: summary differs');
    await syncDirectory(dirname(path));
  } finally { await unlink(temp); }
}
export function parseTask(markdown: string, filename: string): { title: string; branch?: string; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let body = normalized;
  const meta: Record<string, string> = {};
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 3);
    if (end < 0) throw new Error('Unclosed task front matter (use --- on its own line)');
    for (const line of normalized.slice(4, end).split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const match = line.match(/^(title|branch):\s*(.*?)\s*$/);
      if (!match) throw new Error('Front matter supports only scalar title and branch fields');
      meta[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].replace(/^'(.*)'$/, '$1');
      if (typeof meta[match[1]] !== 'string') throw new Error('Task metadata must be text');
    }
    body = normalized.slice(end + 5);
  }
  if (!body.trim()) throw new Error('Task body is empty');
  if (meta.branch && (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(meta.branch) || /^(?:main|master|HEAD)$/.test(meta.branch))) {
    throw new Error('Invalid or protected task branch');
  }
  return { title: (meta.title || body.match(/^#\s+(.+)$/m)?.[1] || filename.replace(/\.md$/, '')).slice(0, 200),
    branch: meta.branch, body: body.trim() };
}

export class Queue {
  readonly scrub = redactor();
  constructor(readonly root: string) {}
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await Promise.all(['inbox', 'running', 'done', 'failed', 'logs', 'audits', 'worktrees'].map(dir => mkdir(join(this.root, dir), { recursive: true, mode: 0o700 })));
  }
  async load(): Promise<State> {
    if (!await exists(join(this.root, 'status.json'))) return { version: 1, mergedPrs: 0, auditedThrough: 0, updatedAt: new Date().toISOString() };
    const state = JSON.parse(await readFile(join(this.root, 'status.json'), 'utf8')) as State;
    if (state.version !== 1 || !Number.isSafeInteger(state.mergedPrs) || state.mergedPrs < 0 ||
      !Number.isSafeInteger(state.auditedThrough) || state.auditedThrough < 0) throw new Error('Invalid status.json; restore a valid checkpoint');
    return state;
  }
  async save(state: State): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await atomicWrite(join(this.root, 'status.json'), this.scrub(JSON.stringify(state, null, 2)) + '\n');
  }
  async claim(state: State): Promise<Task | undefined> {
    if (state.active) return state.active;
    const orphaned = (await readdir(join(this.root, 'running'))).filter(f => f.endsWith('.md')).sort();
    if (orphaned.length > 1) throw new Error('Multiple running tasks; restore status.json before continuing');
    const inbox = (await readdir(join(this.root, 'inbox'))).filter(f => f.endsWith('.md')).sort();
    const source = orphaned[0] ?? inbox[0];
    if (!source) return;
    const id = orphaned.length ? source.slice(0, -3) : `${source.slice(0, -3).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)}-${randomUUID().slice(0, 8)}`;
    const file = `${id}.md`;
    // Rename first: after a crash here, the orphan is claimed on restart before any new inbox task.
    if (!orphaned.length) await rename(join(this.root, 'inbox', source), join(this.root, 'running', file));
    let parsed: ReturnType<typeof parseTask>;
    let failure: string | undefined;
    try { parsed = parseTask(await readFile(join(this.root, 'running', file), 'utf8'), source); }
    catch (error) { parsed = { title: source, body: '' }; failure = (error as Error).message; }
    const task: Task = { id, file, ...parsed, branch: parsed.branch ?? `dev-daemon/${id}`, worktree: join(this.root, 'worktrees', id),
      kind: 'task', stage: failure ? 'failed' : 'prepare', round: 0, outputs: {}, attempts: 0, summary: failure };
    state.active = task;
    await this.save(state);
    return task;
  }
  async finish(state: State): Promise<void> {
    const task = state.active!;
    if (!['done', 'failed'].includes(task.stage)) throw new Error('Cannot archive an unfinished task');
    if (![task.id, task.file].every(name => typeof name === 'string' && name !== '.' && name !== '..' &&
      /^[a-zA-Z0-9_.-]+$/.test(name)) || task.file !== `${task.id}.md`) throw new Error('Archive conflict: unsafe task identity');
    const folder = task.stage as 'done' | 'failed';
    if (task.finalization && task.finalization.destination !== folder) throw new Error('Archive conflict: terminal destination changed');
    const source = join(this.root, 'running', task.file), destination = join(this.root, folder, task.file);
    const summaryPath = join(this.root, folder, `${task.id}.summary.md`);
    // Inspect ALL three names before intent persistence or filesystem mutation.
    const [original, archived, summary] = await Promise.all([archiveFile(source), archiveFile(destination), archiveFile(summaryPath)]);
    if (!original && !archived) throw new Error('Archive conflict: source and destination are both missing');
    const legacySummary = this.scrub(`# ${task.title}\n\n${task.summary ?? task.stage}\n\nBranch: ${task.branch}\nPR: ${task.pr ?? 'none'}\nWorktree: ${task.worktree}\n`);
    const reviews = [...(task.reviewHistory ?? []), ...(task.reviewProgress ? [task.reviewProgress] : [])];
    let content = task.finalization?.summary ?? this.scrub(
      `# ${task.title}\n\n${task.summary ?? task.stage}\n\nBranch: ${task.branch}\nPR: ${task.pr ?? 'none'}\nWorktree: ${task.worktree}\n` +
      (task.cleanup ? `\nCleanup: ${task.cleanup.status === 'complete' ? 'complete' : 'cleanup incomplete'}\n` +
        (task.cleanup.reason ? `Reason: ${task.cleanup.reason}\nInspect directory/registration (may already be partially removed): ${task.cleanup.worktree}\nKnown directory state: ${task.cleanup.directory ?? 'unknown'}; registration requires inspection.\nDiagnostic log: ${task.cleanup.log ?? 'unavailable; see daemon diagnostic'}\n` : '') : '') +
      (reviews.length ? `\nReview attempt records:\n${reviews.flatMap(review => review.attempts).flatMap(attempt =>
        [attempt.original, ...(attempt.clarification ? [attempt.clarification] : [])].map(record =>
          `- Model position ${attempt.modelIndex}, cycle ${attempt.cycle}: ${record.outcome ?? record.status}; answer source ${record.answerSource ?? 'unselected'}; log ${record.log}`)).join('\n')}\n` : ''));
    if (!task.finalization && sameBytes(summary, legacySummary) && task.cleanup?.status !== 'incomplete') content = legacySummary;
    if (!original && !task.finalization) {
      // Legacy partial move has no digest. Validate identity against the saved
      // checkpoint, never just the destination filename. Uncertain cases stop.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(archived!);
      if (task.kind === 'audit') {
        if (text !== `# ${task.title}\n\n${task.body}\n` || task.branch !== `dev-daemon/${task.id}`) {
          throw new Error('Archive conflict: legacy audit identity differs');
        }
      } else {
        let parsed: ReturnType<typeof parseTask>;
        try { parsed = parseTask(text, `${task.title}.md`); }
        catch { throw new Error('Archive conflict: cannot validate legacy task identity'); }
        if (parsed.body !== task.body || parsed.title !== task.title || (parsed.branch ?? `dev-daemon/${task.id}`) !== task.branch) {
          throw new Error('Archive conflict: legacy task identity differs');
        }
      }
    }
    const expected = task.finalization?.digest ?? digest(original ?? archived!);
    if ((original && digest(original) !== expected) || (archived && digest(archived) !== expected)) throw new Error('Archive conflict: task contents differ');
    if (summary && !sameBytes(summary, content)) throw new Error('Archive conflict: summary differs');
    if (!task.finalization) {
      const intent = { destination: folder, digest: expected, summary: content };
      const checkpoint = structuredClone(state);
      checkpoint.active!.finalization = intent;
      await this.save(checkpoint);
      task.finalization = intent;
    }
    await publishSummary(summaryPath, content);
    if (original) {
      // Link is exclusive even if a destination appears after preflight. A
      // crash with both names present resumes through digest validation.
      try { await link(source, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const moved = await archiveFile(destination);
      if (!moved || digest(moved) !== expected) throw new Error('Archive conflict: task appeared during publication');
      await syncDirectory(dirname(destination));
      const remaining = await archiveFile(source);
      if (remaining && digest(remaining) !== expected) throw new Error('Archive conflict: source changed before removal');
      if (remaining) await unlink(source);
      await syncDirectory(dirname(source));
    }
    const completed = structuredClone(state);
    delete completed.active;
    await this.save(completed);
    // A failed checkpoint must leave in-memory active available for retry too.
    delete state.active;
    state.updatedAt = completed.updatedAt;
  }
  async lock(onLost?: () => void): Promise<() => Promise<void>> {
    const path = join(this.root, 'daemon.lock');
    const handle = await open(path, 'a', 0o600);
    await handle.close();
    // Kernel lock avoids PID reuse and stale-file deletion races. The child owns
    // the lock only while our stdin pipe is open, including across daemon crashes.
    // Never unlink the lock inode while another process may have it open.
    const child = spawn('flock', ['--nonblock', '--no-fork', path, process.execPath, '-e',
      "process.stdout.write('locked\\n'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      child.stdout.on('data', () => { ready = true; resolve(); });
      child.once('error', () => reject(new Error('Cannot acquire queue lock; flock must be installed')));
      child.once('close', () => { if (!ready) reject(new Error('Another dev daemon owns this queue, or flock failed')); });
    });
    let releasing = false;
    child.once('close', () => { if (!releasing) onLost?.(); });
    return async () => { releasing = true; child.stdin.end(); await closed; };
  }
}
