import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRunner, redactor } from '../tools/dev-daemon/runner';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function mockProcess(action: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough }) => Promise<void>) {
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    queueMicrotask(() => { void action(child).then(() => child.emit('close', 0)); });
    return child as unknown as ReturnType<typeof spawn>;
  });
}
async function logPath() {
  const path = await mkdtemp(join(tmpdir(), 'dev-daemon-runner-test-')); temps.push(path);
  return join(path, 'stage.log');
}
describe('process runner with mocked subprocesses', () => {
  it('opens stdin on /dev/null and redacts secrets split across chunks in logs and captured output', async () => {
    const log = await logPath();
    mockProcess(async child => {
      child.stdout.write('test-sup');
      child.stdout.write('ersecret-value\n');
      child.stderr.write('Bearer xyz123\n');
    });
    const runner = new ProcessRunner(1000, redactor({ API_KEY: 'test-supersecret-value' }));
    const result = await runner.execute({ bin: 'codex', args: ['exec', 'prompt'], cwd: '/tmp', log });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    expect(result.output).not.toContain('test-supersecret-value');
    expect(result.stdout).toBe('[REDACTED]\n');
    expect(result.stderr).toBe('[REDACTED AUTH]\n');
    expect(await readFile(log, 'utf8')).toBe('[REDACTED]\n[REDACTED AUTH]\n');
  });
  it('pipes the complete prompt with backpressure and EOF without logging input', async () => {
    const log = await logPath();
    const prompt = '한글\n"quoted" '.repeat(40000);
    let received = '';
    mockProcess(async child => {
      child.stdin.setEncoding('utf8').on('data', text => { received += text; });
      await once(child.stdin, 'end');
      child.stdout.write('complete\n');
    });
    const result = await new ProcessRunner(1000).execute({ bin: 'stub', args: [], cwd: '/tmp', log,
      input: { transport: 'stdin', text: prompt } });
    expect(received).toBe(prompt); expect(result.code).toBe(0);
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
    expect(await readFile(log, 'utf8')).toBe('complete\n');
  });
  it('rejects a zero exit after a stdin write error and preserves stderr diagnostics', async () => {
    const log = await logPath();
    mockProcess(async child => {
      child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
      child.stderr.write('quota resets in 1 hour\n');
      child.stdout.write('partial answer\n');
    });
    const result = await new ProcessRunner(1000).execute({ bin: 'stub', args: [], cwd: '/tmp', log,
      input: { transport: 'stdin', text: 'x'.repeat(400 * 1024) } });
    expect(result.code).toBe(1); expect(result.stderr).toContain('quota');
  });
  it('cleans private prompt files after synchronous spawn failure', async () => {
    const log = await logPath();
    let file = '';
    vi.mocked(spawn).mockImplementation((_bin, args) => {
      file = (args as string[]).at(-1)!;
      throw new Error('spawn EACCES');
    });
    const result = await new ProcessRunner().execute({ bin: 'stub', args: ['-p'], cwd: '/tmp', log,
      input: { transport: 'file', text: 'private body' } });
    expect(result.code).toBe(1); expect(file).not.toBe('');
    await expect(stat(dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(log, 'utf8')).not.toContain('private body');
  });
  it('uses the Codex final-answer file rather than echoed prompt/transcript verdicts', async () => {
    const log = await logPath();
    const answerFile = `${log}.answer`;
    mockProcess(async child => {
      child.stdout.write('Prompt asks VERDICT: CHANGES\n');
      await writeFile(answerFile, 'Reviewed code.\nVERDICT: APPROVE');
    });
    const result = await new ProcessRunner().execute({ bin: 'codex', args: [], cwd: '/tmp', log, answerFile });
    expect(result.answer).toBe('Reviewed code.\nVERDICT: APPROVE');
    expect(result.output).toContain('CHANGES');
    expect(result.stdout).toBe('Prompt asks VERDICT: CHANGES\n');
    expect(result.stderr).toBe('');
    await expect(readFile(answerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('returns an empty final answer when Codex produced no final-answer file', async () => {
    const log = await logPath();
    mockProcess(async child => { child.stdout.write('VERDICT: APPROVE\n'); });
    const result = await new ProcessRunner().execute({ bin: 'codex', args: [], cwd: '/tmp', log, answerFile: `${log}.answer` });
    expect(result.answer).toBe('');
  });
  it('keeps stdout and stderr separate when chunks and trailing lines are interleaved', async () => {
    const log = await logPath();
    mockProcess(async child => {
      child.stdout.write('user\nQuota task');
      child.stderr.write('Usage li');
      child.stdout.write(' prompt\ntranscript');
      child.stderr.write('mit; resets in 1 hour');
    });
    const result = await new ProcessRunner().execute({ bin: 'codex', args: [], cwd: '/tmp', log, answerFile: `${log}.answer` });
    expect(result.stdout).toBe('user\nQuota task prompt\ntranscript');
    expect(result.stderr).toBe('Usage limit; resets in 1 hour');
    expect(result.answer).toBe('');
  });
});
