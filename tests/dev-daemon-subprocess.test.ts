import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRunner } from '../tools/dev-daemon/runner';
import type { Command } from '../tools/dev-daemon/types';

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function command(script: string, transport: 'stdin' | 'file' = 'stdin') {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-daemon-subprocess-')); temps.push(cwd);
  return { bin: process.execPath, args: ['-e', script], cwd, log: join(cwd, 'process.log'),
    input: { text: '', transport } } satisfies Command;
}
const reader = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = process.argv[process.argv.indexOf('--prompt-file') + 1];
const report = data => console.log(JSON.stringify({ bytes: data.length,
  hash: crypto.createHash('sha256').update(data).digest('hex'),
  ...(process.argv.includes('--prompt-file') ? { file, fileMode: fs.statSync(file).mode & 511,
    dirMode: fs.statSync(require('node:path').dirname(file)).mode & 511 } : {}) }));
if (process.argv.includes('--prompt-file')) report(fs.readFileSync(file));
else { const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => report(Buffer.concat(chunks))); }
`;

describe('real local subprocess prompt transport (no models/network)', () => {
  it.each(['stdin', 'file'] as const)('delivers 400 KiB ASCII and Unicode input intact via %s and sends EOF', async transport => {
    for (const prompt of ['x'.repeat(400 * 1024), '한글\n"quotes" \'single\'\\'.repeat(24000)]) {
      const cmd = await command(reader, transport); cmd.input.text = prompt;
      // Node's option parser must stop before runner appends --prompt-file.
      cmd.args.push('--');
      const result = await new ProcessRunner(5000).execute(cmd);
      expect(result.code).toBe(0);
      const received = JSON.parse(result.stdout!);
      expect(received.bytes).toBe(Buffer.byteLength(prompt));
      expect(received.hash).toBe(createHash('sha256').update(prompt).digest('hex'));
      if (transport === 'file') {
        expect(received.fileMode).toBe(0o600); expect(received.dirMode).toBe(0o700);
        await expect(readFile(received.file)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(cmd.log, 'utf8')).not.toContain(prompt);
    }
  });
  it('fails closed on early stdin closure/EPIPE while retaining quota diagnostics', async () => {
    const cmd = await command("process.stdin.destroy(); process.stderr.write('quota resets in 1 hour\\n'); setTimeout(() => process.exit(0), 20)");
    cmd.input.text = 'x'.repeat(4 * 1024 * 1024);
    const result = await new ProcessRunner(2000).execute(cmd);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('quota resets in 1 hour');
    expect(result.output).toContain('prompt delivery failed');
  });
  it('returns failure on spawn error without an unhandled stdin error', async () => {
    const cmd = await command(''); cmd.bin = '/nonexistent-dev-daemon-binary'; cmd.input.text = 'x'.repeat(400 * 1024);
    const result = await new ProcessRunner(2000).execute(cmd);
    expect(result.code).not.toBe(0); expect(result.output).toContain('Runner error');
  });
  it.each(['failure', 'timeout', 'stop'] as const)('removes prompt files on %s', async mode => {
    const script = `require('node:fs').writeFileSync('input-path', process.argv.at(-1)); ${mode === 'failure' ? 'process.exit(1)' : 'setInterval(() => {}, 1000)'}`;
    const cmd = await command(script, 'file'); cmd.args.push('--'); cmd.input.text = 'private prompt';
    const runner = new ProcessRunner(mode === 'timeout' ? 200 : 3000);
    const running = runner.execute(cmd);
    let file = '';
    // Wait for the child to record its path, without invoking a real model.
    for (let count = 0; count < 100; count++) {
      try { file = await readFile(join(cmd.cwd, 'input-path'), 'utf8'); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    expect(file).not.toBe('');
    if (mode === 'stop') { runner.stop(); await expect(running).rejects.toThrow('Daemon stopping'); }
    else expect((await running).code).toBe(mode === 'timeout' ? 124 : 1);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cleans up a file after spawn failure', async () => {
    const cmd = await command('', 'file'); cmd.bin = '/nonexistent-dev-daemon-binary';
    const result = await new ProcessRunner(2000).execute(cmd);
    expect(result.code).not.toBe(0);
  });
  it('bounds captured and logged stdout including a huge line, drains the rest, and preserves stderr/exit', async () => {
    const cmd = await command("process.stdout.write('가'.repeat(400000), () => { process.stderr.write('git diagnostic'); process.exitCode = 7; })");
    const result = await new ProcessRunner(3000).execute({ ...cmd, stdoutLimitBytes: 1024 });
    expect(result.code).toBe(7); expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout!)).toBeLessThanOrEqual(1024);
    expect(result.stdout).not.toContain('\ufffd'); expect(result.stderr).toBe('git diagnostic');
    expect(Buffer.byteLength(await readFile(cmd.log, 'utf8'))).toBeLessThan(1100);
  });
});
