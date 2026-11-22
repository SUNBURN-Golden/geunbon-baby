import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export class DeployError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const errorCode = (error: unknown) => error instanceof DeployError ? error.code : 'infrastructure_error';

export type Migration = { name: string; destructive: boolean };
export type Step = { name: string; outcome: string };
export type Registration = { name: string; root: string; managed: boolean };
export type CrawlerSnapshot = { link: string | null; apps: Registration[]; instagramRoot: string | null };
export type Phase = 'prepare' | 'migrate' | 'upload' | 'promote' | 'health' | 'rollback' | 'crawler' | 'cutover' | 'restore';
export type Attempt = {
  id: string;
  sha: string;
  path: string;
  started: number;
  steps: Step[];
  phase: Phase;
  previous?: string;
  version?: string;
  output?: string;
  migrations?: Migration[];
  crawler?: CrawlerSnapshot;
  rollback: { command: 'ok' | 'failed' | 'observed' | null; verified: boolean } | null;
};
export type Append = { offset: number; text: string };
export type Copy = { before: string | null; after: string; append?: Append };
export type State = {
  schema: 1;
  lastSite: string | null;
  lastSiteVersion: string | null;
  lastCrawler: string | null;
  lastDeployed: string | null;
  rejected: string | null;
  attempt: Attempt | null;
  owned: Record<string, string>;
  successful: string[];
  instagramRoot: string | null;
  retry: { sha: string; count: number; at: number } | null;
  copy: Copy[];
  event: { text: string; append?: Append } | null;
};

export function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomicWrite(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}

export function readState(root: string): State {
  let data: string;
  try { data = readFileSync(join(root, 'state.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      schema: 1, lastSite: null, lastSiteVersion: null, lastCrawler: null, lastDeployed: null,
      rejected: null, attempt: null, owned: {}, successful: [], instagramRoot: null, retry: null, copy: [], event: null,
    };
  }
  const state: State = JSON.parse(data);
  if (state.schema !== 1 || ![state.lastSite, state.lastCrawler, state.lastDeployed, state.rejected].every(sha => sha === null || isSha(sha)) ||
      (state.lastSiteVersion !== null && !isVersion(state.lastSiteVersion)) ||
      (state.attempt && !isSha(state.attempt.sha))) throw new DeployError('state_invalid');
  return state;
}

function withAudit<T>(path: string, operation: (fd: number) => T) {
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new DeployError('audit_invalid');
    return operation(fd);
  } finally { closeSync(fd); }
}

export function prepareAppend(path: string, text: string): Append {
  const offset = withAudit(path, fd => {
    fsyncSync(fd);
    return fstatSync(fd).size;
  });
  syncDirectory(dirname(path));
  return { offset, text };
}

// Reserve the offset in state before writing. An interrupted append can be
// resumed at the first missing byte, including an interruption within UTF-8.
export function finishAppend(path: string, record: Append) {
  withAudit(path, fd => {
    const bytes = Buffer.from(record.text);
    let written = fstatSync(fd).size - record.offset;
    if (written < 0 || written > bytes.length) throw new DeployError('audit_offset_conflict');
    const existing = Buffer.alloc(written);
    for (let offset = 0; offset < existing.length;) {
      const size = readSync(fd, existing, offset, existing.length - offset, record.offset + offset);
      if (!size) throw new DeployError('audit_offset_conflict');
      offset += size;
    }
    if (!existing.equals(bytes.subarray(0, written))) throw new DeployError('audit_offset_conflict');
    while (written < bytes.length) {
      const size = writeSync(fd, bytes, written, bytes.length - written);
      if (!size) throw new DeployError('audit_write_failed');
      written += size;
    }
    fsyncSync(fd);
  });
}
