import { mkdir, readFile, readdir, rename, writeFile, open, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
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
    const folder = task.stage;
    await writeFile(join(this.root, folder, `${task.id}.summary.md`), this.scrub(
      `# ${task.title}\n\n${task.summary ?? task.stage}\n\nBranch: ${task.branch}\nPR: ${task.pr ?? 'none'}\nWorktree: ${task.worktree}\n`), { mode: 0o600 });
    const source = join(this.root, 'running', task.file);
    if (await exists(source)) await rename(source, join(this.root, folder, task.file));
    delete state.active;
    await this.save(state);
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
