import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { Choice, Command, Execute, ModelsConfig, Result } from './types';

export function redactor(env: Record<string, string | undefined> = process.env): (text: string) => string {
  const secrets = Object.entries(env).filter(([key, value]) => /token|secret|password|credential|api[_-]?key|authorization/i.test(key) && value && value.length >= 4)
    .map(([, value]) => value!).sort((a, b) => b.length - a.length);
  return text => {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\b(?:Bearer|Basic)\s+[\w.+/=-]+/gi, '[REDACTED AUTH]')
      .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{12,})\b/g, '[REDACTED TOKEN]')
      .replace(/((?:password|api[_-]?key|access[_-]?token|auth[_-]?token|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  };
}

export function modelCommand(config: ModelsConfig, choice: Choice, prompt: string, cwd: string,
  log: string, readOnly: boolean, protectedRoots: string[] = []): Command {
  const model = config.models[choice.model];
  const env = { ...process.env };
  if (model.provider === 'codex') return {
    bin: 'codex', cwd, log, env, answerFile: `${log}.answer`,
    args: ['exec', '-m', model.id, '-c', `model_reasoning_effort=${choice.effort ?? 'high'}`,
      ...(readOnly ? ['-s', 'read-only', '-c', 'approval_policy="never"'] : ['--dangerously-bypass-approvals-and-sandbox']),
      '--ephemeral', '--output-last-message', `${log}.answer`, prompt],
  };
  if (model.provider === 'devin') {
    const args = ['--respect-workspace-trust', 'false', '--model', model.id,
      '--permission-mode', readOnly ? 'auto' : 'dangerous', '-p', prompt];
    // Devin's auto mode only approves read tools. Mounts also prevent any review
    // tool from changing the worktree, shared Git metadata, or queue state.
    return readOnly ? {
      bin: 'bwrap', args: ['--die-with-parent', '--bind', '/', '/',
        ...[...new Set([...protectedRoots, cwd])].flatMap(root => ['--ro-bind', root, root]),
        '--dev', '/dev', '--proc', '/proc', '--', '/home/box/.local/bin/devin', ...args], cwd, env, log,
    } : { bin: '/home/box/.local/bin/devin', args, cwd, env, log };
  }
  if (model.provider === 'glm') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = '/home/box/.claude-fable';
  return {
    bin: 'claude', cwd, env, log,
    // The prompt MUST precede variadic tool flags.
    args: ['-p', prompt, ...(model.provider === 'glm' && model.id === 'default' ? [] : ['--model', model.id]),
      ...(choice.effort ? ['--effort', choice.effort] : []), '--no-session-persistence',
      ...(readOnly ? ['--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob'] : ['--dangerously-skip-permissions'])],
  };
}

export class ProcessRunner {
  private child?: ReturnType<typeof spawn>;
  private stopped = false;
  constructor(private readonly timeoutMs = 45 * 60000, private readonly scrub = redactor()) {}

  stop(): void {
    this.stopped = true;
    const pid = this.child?.pid;
    this.kill('SIGTERM', pid);
    const timer = setTimeout(() => this.kill('SIGKILL', pid), 5000);
    timer.unref();
  }
  private kill(signal: NodeJS.Signals, pid = this.child?.pid): void {
    if (pid) {
      try { process.kill(-pid, signal); } catch { /* Already exited. */ }
    }
  }
  execute: Execute = async command => {
    if (this.stopped) throw new Error('Daemon stopping');
    await mkdir(dirname(command.log), { recursive: true, mode: 0o700 });
    if (command.answerFile) await rm(command.answerFile, { force: true });
    if (this.stopped) throw new Error('Daemon stopping');
    const log = createWriteStream(command.log, { flags: 'a', mode: 0o600 });
    let logError: Error | undefined;
    log.on('error', error => { logError = error; this.kill('SIGTERM'); });
    let output = '', stdout = '', stderr = '', bytes = 0, exceeded = false;
    const pending = ['', ''];
    const record = (text: string, stream?: number) => {
      const safe = this.scrub(text);
      log.write(safe);
      if (bytes < 16 * 1024 * 1024) {
        output += safe;
        if (stream === 0) stdout += safe;
        if (stream === 1) stderr += safe;
      }
      bytes += Buffer.byteLength(safe);
      if (bytes > 16 * 1024 * 1024 && !exceeded) { exceeded = true; this.kill('SIGTERM'); }
    };
    // Buffer by line so a token split across process chunks is still redacted.
    const consume = (chunk: string, stream: number) => {
      pending[stream] += chunk;
      const last = pending[stream].lastIndexOf('\n');
      if (last >= 0) { record(pending[stream].slice(0, last + 1), stream); pending[stream] = pending[stream].slice(last + 1); }
      if (pending[stream].length > 16 * 1024 * 1024) { exceeded = true; this.kill('SIGTERM'); }
    };
    let timedOut = false;
    const code = await new Promise<number>(resolve => {
      // On Unix, ignored stdin is opened on /dev/null, never inherited or piped.
      const child = spawn(command.bin, command.args, { cwd: command.cwd, env: command.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      this.child = child;
      child.stdout?.setEncoding('utf8').on('data', chunk => consume(chunk, 0));
      child.stderr?.setEncoding('utf8').on('data', chunk => consume(chunk, 1));
      const timer = setTimeout(() => {
        timedOut = true; this.kill('SIGTERM', child.pid);
        const force = setTimeout(() => this.kill('SIGKILL', child.pid), 5000); force.unref();
      }, this.timeoutMs);
      child.on('error', error => record(`Runner error: ${error.message}\n`));
      child.on('close', exit => { clearTimeout(timer); this.child = undefined; resolve(exit ?? 1); });
    });
    pending.forEach((text, stream) => record(text, stream));
    if (timedOut) record('\nRunner timed out.\n');
    if (exceeded) record('\nRunner output exceeded 16 MiB.\n');
    let answer = output;
    if (command.answerFile) {
      try { answer = this.scrub(await readFile(command.answerFile, 'utf8')); }
      catch { answer = ''; }
      // Codex initially writes its final answer outside our redacting stream.
      await rm(command.answerFile, { force: true });
      record(`\n--- final answer ---\n${answer}\n`);
    }
    await new Promise<void>(resolve => { if (log.destroyed) resolve(); else log.end(resolve); });
    if (logError) throw new Error('Cannot write process log');
    if (this.stopped) throw new Error('Daemon stopping');
    return { code: timedOut ? 124 : exceeded ? 1 : code, output, answer, stdout, stderr } satisfies Result;
  };
}
