import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GongguExtraction, ReviewQueueItem } from './types';
export async function enqueueReview(dir: string, extraction: GongguExtraction) {
  await mkdir(dir, { recursive: true });
  const item: ReviewQueueItem = { id: randomUUID(), status: 'pending', created_at: new Date().toISOString(), extraction, source_kind: 'public_web', verify_level: 'model_extract' };
  await appendFile(join(dir, 'review-queue.jsonl'), `${JSON.stringify(item)}\n`);
  return item;
}
export async function countPending(dir: string) {
  try {
    const lines = (await readFile(join(dir, 'review-queue.jsonl'), 'utf8')).split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l) as ReviewQueueItem).filter(i => i.status === 'pending').length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}
