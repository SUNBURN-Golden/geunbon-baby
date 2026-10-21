import { expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushHealth, health, initHealth } from '../crawler/lib/health';
test('health flush writes ordered JSONL and summary with secret redaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crawler-health-'));
  try {
    vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'mock-password-only');
    vi.stubEnv('INGEST_TOKEN', 'mock-token-only');
    await initHealth(dir);
    health('run_start', { token: 'mock-token-only', detail: 'mock-password-only mock-token-only', text: 'private caption' });
    health('quiet_window_enter', { timezone: 'Asia/Seoul', end_at: '2026-10-20T23:00:00.000Z', resume_at: '2026-10-20T23:00:01.000Z' });
    health('quiet_window_exit', { timezone: 'Asia/Seoul' });
    health('poll', { posts: 2, stories: 1 });
    await flushHealth();
    const log = await readFile(join(dir, 'logs', `health-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    expect(log).not.toContain('mock-password-only'); expect(log).not.toContain('mock-token-only'); expect(log).not.toContain('private caption');
    expect(log.trim().split('\n').map(line => JSON.parse(line).event)).toEqual(['run_start', 'quiet_window_enter', 'quiet_window_exit', 'poll']);
    const summary = JSON.parse(await readFile(join(dir, 'logs', 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ counts: { run_start: 1, quiet_window_enter: 1, quiet_window_exit: 1, poll: 1 }, last_event: { event: 'poll', posts: 2, stories: 1 }, log_write_failed: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('safe login transitions and last halt survive cleanup events without copying private preview or URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crawler-health-'));
  try {
    await initHealth(dir);
    health('login_state', { phase: 'submitted', state: 'blank-loading', elapsed_ms: 0, recoveries: 0 });
    health('login_recovery', { phase: 'submitted', state: 'blank-loading', elapsed_ms: 30_000, recoveries: 1 });
    health('halt', { reason: 'challenge', state: 'challenge', phase: 'submitted', elapsed_ms: 31_000, recoveries: 1, body_length: 42, root_masked: true, preview: 'private preview', path: '/private-path/' });
    health('run_stop');
    health('error', { reason: 'challenge' });
    await flushHealth();
    const summary = JSON.parse(await readFile(join(dir, 'logs', 'summary.json'), 'utf8'));
    expect(summary.last_halt).toEqual({ reason: 'challenge', state: 'challenge', phase: 'submitted', elapsed_ms: 31_000, recoveries: 1, body_length: 42, root_masked: true });
    expect(JSON.stringify(summary)).not.toContain('private preview');
    expect(JSON.stringify(summary)).not.toContain('/private-path/');
    expect(summary.last_event.event).toBe('error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('health write failure is contained and reports only a fixed operational message', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'crawler-health-'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await initHealth(dir);
    await rm(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'logs'), 'offline ENOTDIR fixture');
    health('login_state', { phase: 'entry', state: 'blank-loading', elapsed_ms: 0, recoveries: 0 });
    health('halt', { reason: 'login', state: 'blank-loading', body_length: 0, root_masked: false });
    await expect(flushHealth()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('크롤러 상태 로그 쓰기 실패: logs 디렉터리 권한·디스크 확인 필요.');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
