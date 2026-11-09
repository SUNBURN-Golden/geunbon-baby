import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunReport } from './types';
export function heartbeatFresh(reportAtIso: string, now = Date.now(), maxAgeMs: number) {
  const age = now - Date.parse(reportAtIso);
  return { fresh: age <= maxAgeMs, age_ms: Math.max(0, age) };
}
export async function writeHeartbeat(dir: string, report: RunReport, maxAgeMs: number, now = Date.now()) {
  await mkdir(dir, { recursive: true });
  const heartbeat_at = new Date(now).toISOString();
  const { fresh, age_ms } = heartbeatFresh(heartbeat_at, now, maxAgeMs);
  const payload = { ...report, heartbeat_at, heartbeat_fresh: fresh, heartbeat_age_ms: age_ms };
  await writeFile(join(dir, 'heartbeat.json'), `${JSON.stringify(payload, null, 2)}\n`);
  return fresh;
}
export async function readHeartbeat(dir: string) {
  try { return JSON.parse(await readFile(join(dir, 'heartbeat.json'), 'utf8')) as RunReport & { heartbeat_at: string; heartbeat_age_ms?: number }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
