// JSONL 상태 로그. crawler/logs/health-YYYY-MM-DD.jsonl 에 한 사건 한 줄로 남긴다.
// 필드는 스칼라(문자열 계정명·횟수·상태)만 받는다. 비밀번호·토큰·수집 원문·쿠키는 절대 넣지 않는다.
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
let logsDir: string | null = null;
export async function initHealth(root: string) {
  logsDir = resolve(root, 'logs');
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
}
export type HealthEvent = 'run_start' | 'run_stop' | 'signals' | 'queue' | 'poll' | 'account_visit' | 'post_sent' | 'story_seen' | 'story_skip' | 'follow' | 'follow_skip' | 'candidate_found' | 'discovery' | 'challenge' | 'blocked' | 'api_error' | 'selector_miss' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | null | undefined>;
export function health(event: HealthEvent, fields: Fields = {}) {
  if (!logsDir) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
  void appendFile(resolve(logsDir, `health-${new Date().toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 }).catch(() => {});
}
