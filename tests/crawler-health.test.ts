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
    health('poll', { posts: 2, stories: 1 });
    await flushHealth();
    const log = await readFile(join(dir, 'logs', `health-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    expect(log).not.toContain('mock-password-only'); expect(log).not.toContain('mock-token-only'); expect(log).not.toContain('private caption');
    expect(log.trim().split('\n').map(line => JSON.parse(line).event)).toEqual(['run_start', 'poll']);
    const summary = JSON.parse(await readFile(join(dir, 'logs', 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ counts: { run_start: 1, poll: 1 }, last_event: { event: 'poll', posts: 2, stories: 1 }, log_write_failed: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
