import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewContext, REVIEW_CONTEXT_BYTES } from '../tools/dev-daemon/review-context';
import { ProcessRunner } from '../tools/dev-daemon/runner';
import type { Command, Execute } from '../tools/dev-daemon/types';

const exec = promisify(execFile);
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dev-daemon-review-')); temps.push(root);
  const cwd = join(root, 'repo'); await mkdir(cwd);
  const git = (...args: string[]) => exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  const put = async (path: string, text: string | Buffer) => { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), text); };
  await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Offline fixture');
  await put('code.ts', 'export const before = true;\n');
  await put('public/img/modified.svg', '<svg>old</svg>\n');
  await put('public/img/한글 [old]\n.svg', '<svg>\ndeleted\n</svg>\n');
  await put('public/img/rename.svg', '<svg>rename</svg>\n');
  await put('public/img/deleted.png', Buffer.from([137, 80, 78, 71, 0, 10]));
  await git('add', '.'); await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'offline fixture');
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const calls: Command[] = [];
  const runner = new ProcessRunner(5000);
  const execute: Execute = command => { calls.push(command); return runner.execute(command); };
  let index = 0;
  const context = (maxBytes?: number) => buildReviewContext({ cwd, execute, maxBytes, log: label => join(root, 'logs', `${index++}-${label}.log`) });
  return { root, cwd, git, put, calls, context };
}

describe('bounded review context using local Git only', () => {
  it('summarizes modified/deleted/untracked/renamed images before generating patches and keeps staged + unstaged code', async () => {
    const f = await fixture();
    const svg = '<svg>\n' + 'GENERATED-SVG-CONTENT'.repeat(22000) + '\n</svg>\n';
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71]), Buffer.alloc(400 * 1024, 77)]);
    await f.put('public/img/modified.svg', svg);
    await f.put('public/img/nested/new image.PNG', png);
    await f.put('public/img/:(literal) [new]\n한글.svg', '<svg>new</svg>');
    await f.put('code.ts', 'export const staged = true;\n'); await f.git('add', 'code.ts');
    await f.put('code.ts', 'export const staged = true;\nexport const unstaged = true;\n');
    await f.put('untracked [한글]\n.ts', 'read this too');
    await rm(join(f.cwd, 'public/img/한글 [old]\n.svg'));
    await rm(join(f.cwd, 'public/img/deleted.png'));
    await rename(join(f.cwd, 'public/img/rename.svg'), join(f.cwd, 'public/img/renamed.svg'));
    await f.git('add', '--', 'public/img/rename.svg', 'public/img/renamed.svg');
    const result = await f.context();
    expect(result).not.toContain('GENERATED-SVG-CONTENT');
    expect(result).not.toContain('MMMMMMMM');
    expect(result).toContain('+export const staged'); expect(result).toContain('+export const unstaged');
    expect(result).toContain(JSON.stringify('untracked [한글]\n.ts'));
    expect(result).toContain(`"public/img/modified.svg" status=M bytes=${Buffer.byteLength(svg)} sha256=${createHash('sha256').update(svg).digest('hex')} lines=3`);
    expect(result).toContain(`"public/img/nested/new image.PNG" status=untracked bytes=${png.length} sha256=${createHash('sha256').update(png).digest('hex')} lines=n/a`);
    const { stdout: blob } = await f.git('rev-parse', 'origin/main:public/img/한글 [old]\n.svg');
    expect(result).toContain(`${JSON.stringify('public/img/한글 [old]\n.svg')} status=D bytes=21 git-blob=${blob.trim()} lines=3`);
    expect(result).toContain('"public/img/deleted.png" status=D bytes=6 git-blob=');
    expect(result).toMatch(/deleted\.png.*lines=n\/a/);
    expect(result).toContain('"public/img/rename.svg" status=D');
    expect(result).toContain('"public/img/renamed.svg" status=A');
    expect(result).toContain(`${JSON.stringify('public/img/:(literal) [new]\n한글.svg')} status=untracked`);
    const patch = f.calls.find(command => command.log.includes('review-main-diff'))!;
    expect(patch.args).toContain(':(exclude,icase,glob)public/img/**/*.svg');
    expect(await readFile(patch.log, 'utf8')).not.toContain('GENERATED-SVG-CONTENT');
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(REVIEW_CONTEXT_BYTES);
  });
  it('reports symlinks themselves without following their targets', async () => {
    const f = await fixture();
    const outside = join(f.root, 'private.txt'); await writeFile(outside, 'EXTERNAL-CONTENT-DO-NOT-READ');
    await symlink(outside, join(f.cwd, 'public/img/link.svg'));
    const result = await f.context();
    expect(result).toContain(`symlink=${JSON.stringify(outside)}`);
    expect(result).not.toContain('EXTERNAL-CONTENT-DO-NOT-READ');
  });
  it.each([256, 1024, REVIEW_CONTEXT_BYTES])('caps a giant Unicode line to %s UTF-8 bytes with an explicit omission notice', async maxBytes => {
    const f = await fixture(); await f.put('code.ts', '한'.repeat(400 * 1024));
    const result = await f.context(maxBytes);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
    expect(result).toContain('OMITTED'); expect(result).not.toContain('\ufffd');
  });
  it('budgets many paths and summaries and gives ordinary code priority', async () => {
    const f = await fixture(); await f.put('code.ts', 'export const important = true;\n');
    for (let index = 0; index < 80; index++) {
      await f.put(`public/img/${index}.svg`, '<svg/>\n');
      await f.put(`untracked/한글-${index}.ts`, 'code');
    }
    const result = await f.context(2048);
    expect(result).toContain('+export const important'); expect(result).toContain('OMITTED');
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2048);
  });
  it('does not hide Git failures as ordinary truncation', async () => {
    await expect(buildReviewContext({ cwd: '/tmp', log: () => '/unused', execute: async () => ({ code: 7, output: '', answer: '', stdoutTruncated: true }) })).rejects.toThrow('failed (exit 7)');
  });
});
