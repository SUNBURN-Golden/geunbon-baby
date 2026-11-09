import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateMemory } from './budget-cycle';
import type { RunMemory } from './types';
export function emptyMemory(now = new Date().toISOString()): RunMemory {
  return migrateMemory({ version: 2, updated_at: now, plan_notes: [], observed_urls: [], pending_urls: [],
    last_heartbeat_at: null, last_run_id: null, last_collection_status: 'idle',
    output_counts: { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 } }, randomUUID());
}
export async function loadMemory(dir: string): Promise<RunMemory> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8')) as RunMemory;
    return migrateMemory(parsed, parsed.cycle?.cycle_id ?? randomUUID());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyMemory();
    throw e;
  }
}
export async function saveMemory(dir: string, memory: RunMemory) {
  memory.token_spent = memory.cycle.token_spent;
  memory.tokens_reserved = memory.cycle.tokens_reserved;
  memory.requests_spent = memory.cycle.requests_spent;
  memory.requests_reserved = memory.cycle.requests_reserved;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'memory.json'), `${JSON.stringify({ ...memory, updated_at: new Date().toISOString() }, null, 2)}\n`);
}
export function newRunId() { return randomUUID(); }
