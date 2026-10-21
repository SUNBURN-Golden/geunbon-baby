import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRunner, redactor } from '../tools/dev-daemon/runner';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function mockProcess(action: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => Promise<void>) {
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
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
    expect(await readFile(log, 'utf8')).toBe('[REDACTED]\n[REDACTED AUTH]\n');
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
    await expect(readFile(answerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('returns an empty final answer when Codex produced no final-answer file', async () => {
    const log = await logPath();
    mockProcess(async child => { child.stdout.write('VERDICT: APPROVE\n'); });
    const result = await new ProcessRunner().execute({ bin: 'codex', args: [], cwd: '/tmp', log, answerFile: `${log}.answer` });
    expect(result.answer).toBe('');
  });
});
