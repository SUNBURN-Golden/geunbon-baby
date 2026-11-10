import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** State is private to one host user. Reject symlinks in every existing path component. */
export function safePath(path: string, directory = false) {
  const absolute = resolve(path);
  let part = absolute;
  for (;;) {
    const stat = lstatSync(part, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('unsafe_state_path');
    if (part === absolute && stat && !(directory ? stat.isDirectory() : stat.isFile())) throw new Error('unsafe_state_path');
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
  return absolute;
}
export function prepareStateDir(dir: string) {
  const path = safePath(dir, true);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path) throw new Error('unsafe_state_path');
  return path;
}
export function readState(path: string): string {
  const fd = openSync(safePath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
export function syncDirectory(dir: string) {
  const fd = openSync(safePath(dir, true), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function atomicState(path: string, value: unknown, fault?: { hook: (point: string) => void; point: string }) {
  const dir = prepareStateDir(dirname(path));
  safePath(path);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    // Fault injection window between the durable temp write and the atomic rename.
    fault?.hook(fault.point);
    safePath(path);
    renameSync(tmp, path);
    syncDirectory(dir);
  } finally { rmSync(tmp, { force: true }); }
}
