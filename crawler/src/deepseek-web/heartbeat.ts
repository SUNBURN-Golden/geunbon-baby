import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunReport } from './types';
export async function writeHeartbeat(dir: string, report: RunReport, maxAgeMs: number) {
  await mkdir(dir, { recursive: true });
  const payload = { ...report, heartbeat_at: new Date().toISOString() };
  await writeFile(join(dir, 'heartbeat.json'), `${JSON.stringify(payload, null, 2)}\n`);
  const age = Date.now() - Date.parse(payload.heartbeat_at);
  return age <= maxAgeMs;
}
export async function readHeartbeat(dir: string) {
  try { return JSON.parse(await readFile(join(dir, 'heartbeat.json'), 'utf8')) as RunReport & { heartbeat_at: string }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
