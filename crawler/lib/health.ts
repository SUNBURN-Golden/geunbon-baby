// Serialized JSONL events and an atomically replaced operator summary.
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redact } from './redact';
let logsDir: string | null = null;
let pending = Promise.resolve();
let counts: Record<string, number> = {};
let lastEvent: Record<string, unknown> = {};
let failed = false;
export async function initHealth(root: string) {
  await flushHealth();
  logsDir = resolve(root, 'logs');
  counts = {};
  lastEvent = {};
  failed = false;
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
}
export type HealthEvent = 'halt' | 'login_attempt' | 'login_ok' | 'session_reused' | 'following_sync' | 'quiet_window_enter' | 'quiet_window_exit' | 'run_start' | 'run_stop' | 'signals' | 'queue' | 'poll' | 'account_visit' | 'post_sent' | 'story_seen' | 'story_skip' | 'follow' | 'follow_skip' | 'candidate_found' | 'discovery' | 'challenge' | 'blocked' | 'api_error' | 'selector_miss' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | null | undefined>;
export function health(event: HealthEvent, fields: Fields = {}) {
  if (!logsDir) return;
  const safe = Object.fromEntries(Object.entries(fields)
    .filter(([key]) => !/password|token|cookie|caption|text|secret/i.test(key))
    .map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]));
  const record = { ...safe, ts: new Date().toISOString(), event };
  counts[event] = (counts[event] ?? 0) + 1;
  lastEvent = record;
  const file = resolve(logsDir, `health-${record.ts.slice(0, 10)}.jsonl`);
  pending = pending.then(() => appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 })).catch(() => { failed = true; });
}
export async function flushHealth() {
  await pending;
  if (!logsDir) return;
  const temporary = resolve(logsDir, 'summary.json.tmp');
  try {
    await writeFile(temporary, JSON.stringify({ updated_at: new Date().toISOString(), counts, last_event: lastEvent, log_write_failed: failed }) + '\n', { mode: 0o600 });
    await rename(temporary, resolve(logsDir, 'summary.json'));
  } catch { failed = true; }
  if (failed) console.error('크롤러 상태 로그 쓰기 실패: logs 디렉터리 권한·디스크 확인 필요.');
}
