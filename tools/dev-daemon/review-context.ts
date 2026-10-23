import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { utf8Prefix } from './runner';
import type { Execute, Result } from './types';

export const REVIEW_CONTEXT_BYTES = 256 * 1024;
const imageExtensions = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'apng'];
const asset = (path: string) => path.toLowerCase().startsWith('public/img/') && imageExtensions.includes(path.split('.').at(-1)!.toLowerCase());
const omission = '\n[OMITTED: review context byte limit reached; some paths, summaries or patch content are omitted. Inspect the worktree directly.]\n';

/** NUL-delimited Git records may be cut only at the collection limit. */
function records(result: Result): string[] {
  const text = result.stdout ?? result.answer;
  return text.slice(0, text.lastIndexOf('\0') + 1).split('\0').filter(Boolean);
}

export async function buildReviewContext(options: {
  cwd: string; execute: Execute; log: (label: string) => string; maxBytes?: number;
}): Promise<string> {
  const maxBytes = options.maxBytes ?? REVIEW_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error('Review context budget must be at least 256 bytes');
  const git = async (args: string[], label: string, limit = maxBytes): Promise<Result> => {
    const result = await options.execute({ bin: 'git', args, cwd: options.cwd,
      log: options.log(label), stdoutLimitBytes: limit });
    if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}); see task logs`);
    return result;
  };
  // Exclude assets before asking Git for any patch. No giant SVG patch is ever
  // materialized just to remove it later. Renames deliberately become D + A.
  const patch = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'origin/main', '--', '.',
    ...imageExtensions.map(ext => `:(exclude,icase,glob)public/img/**/*.${ext}`)], 'review-main-diff',
  Math.max(0, maxBytes - Buffer.byteLength(omission) - Math.min(4096, Math.floor(maxBytes / 4)) - 100));
  const changed = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', 'origin/main', '--'], 'review-changed-files');
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], 'review-new-files');
  let omitted = Boolean(patch.stdoutTruncated || changed.stdoutTruncated || untracked.stdoutTruncated);
  let context = '';
  const budget = maxBytes - Buffer.byteLength(omission);
  const append = (text: string) => {
    const part = utf8Prefix(text, Math.max(0, budget - Buffer.byteLength(context)));
    context += part;
    if (part !== text) omitted = true;
  };
  append('\nTracked diff against origin/main (generated image patches excluded):\n');
  append(patch.stdout ?? patch.answer);
  if (patch.stdoutTruncated) append('\n[OMITTED: tracked patch truncated; inspect remaining changes directly.]\n');
  append('\nUntracked paths to read as part of the review:\n');
  const newPaths = records(untracked);
  for (const path of newPaths.filter(path => !asset(path))) append(`${JSON.stringify(path)}\n`);
  append('\nGenerated image summaries (inspect assets directly as needed):\n');
  const fields = records(changed);
  const images = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (asset(fields[index + 1])) images.set(fields[index + 1], fields[index]);
  }
  for (const path of newPaths.filter(asset)) images.set(path, 'untracked');
  for (const [path, status] of images) {
    if (Buffer.byteLength(context) >= budget) { omitted = true; break; }
    const fullPath = resolve(options.cwd, path);
    if (!fullPath.startsWith(resolve(options.cwd) + sep)) throw new Error('Unexpected review path');
    // Do not follow a replaced directory symlink into files outside the tree.
    const parents = path.split('/').slice(0, -1);
    let parent = options.cwd, linkedParent = false;
    for (const part of parents) {
      parent = resolve(parent, part);
      try { if ((await lstat(parent)).isSymbolicLink()) { linkedParent = true; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; break; }
    }
    if (linkedParent) { append(`${JSON.stringify(path)} status=${status} [parent is symlink; inspect link directly]\n`); continue; }
    let info;
    try { info = await lstat(fullPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!info) {
      const entry = await git(['ls-tree', '-l', '-z', 'origin/main', '--', `:(literal)${path}`], 'review-deleted-image');
      const header = (entry.stdout ?? entry.answer).split('\t')[0].trim().split(/\s+/);
      if (header.length !== 4 || header[1] !== 'blob') throw new Error('Cannot summarize deleted review asset');
      let lines = 'n/a';
      if (/\.svg$/i.test(path) && header[0] !== '120000') {
        const stats = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', 'origin/main', '--', `:(literal)${path}`], 'review-deleted-image-lines');
        lines = (stats.stdout ?? stats.answer).split('\t')[1] ?? 'unknown';
      }
      append(`${JSON.stringify(path)} status=D bytes=${header[3]} git-blob=${header[2]} lines=${lines}${header[0] === '120000' ? ' symlink' : ''}\n`);
    } else if (info.isSymbolicLink()) {
      const link = await readlink(fullPath);
      append(`${JSON.stringify(path)} status=${status} symlink=${JSON.stringify(link)} bytes=${Buffer.byteLength(link)} sha256=${createHash('sha256').update(link).digest('hex')} lines=n/a\n`);
    } else if (info.isFile()) {
      const hash = createHash('sha256');
      let bytes = 0, newlines = 0, lastByte = -1;
      for await (const chunk of createReadStream(fullPath)) {
        const data = chunk as Buffer;
        hash.update(data); bytes += data.length;
        if (/\.svg$/i.test(path)) for (const byte of data) if (byte === 10) newlines++;
        if (data.length) lastByte = data[data.length - 1];
      }
      const lines = /\.svg$/i.test(path) ? String(newlines + (bytes > 0 && lastByte !== 10 ? 1 : 0)) : 'n/a';
      append(`${JSON.stringify(path)} status=${status} bytes=${bytes} sha256=${hash.digest('hex')} lines=${lines}\n`);
    } else append(`${JSON.stringify(path)} status=${status} [non-regular file; inspect directly]\n`);
  }
  return context + (omitted ? omission : '');
}
