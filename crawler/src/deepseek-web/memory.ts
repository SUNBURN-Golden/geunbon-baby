import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunMemory } from './types';
export function emptyMemory(now = new Date().toISOString()): RunMemory {
  return { version: 1, updated_at: now, plan_notes: [], observed_urls: [], pending_urls: [], token_spent: 0, tokens_reserved: 0, requests_spent: 0, requests_reserved: 0, last_heartbeat_at: null, last_run_id: null,
    output_counts: { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 } };
}
export async function loadMemory(dir: string): Promise<RunMemory> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8')) as RunMemory;
    if (parsed.version !== 1) throw new Error('memory_version');
    return {
      ...parsed,
      tokens_reserved: parsed.tokens_reserved ?? 0,
      requests_reserved: parsed.requests_reserved ?? 0,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyMemory();
    throw e;
  }
}
export async function saveMemory(dir: string, memory: RunMemory) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'memory.json'), `${JSON.stringify({ ...memory, updated_at: new Date().toISOString() }, null, 2)}\n`);
}
export function newRunId() { return randomUUID(); }
