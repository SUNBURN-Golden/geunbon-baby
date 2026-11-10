import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixture } from './helpers/collector';
import { deepSeekWebCli } from '../crawler/src/deepseek-web/cli';
import { createDeepSeekClient } from '../crawler/src/deepseek-web/client';
import { EMERGENCY_STOP_META_ID } from '../crawler/src/deepseek-web/domain-policy';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
const dirs: string[] = [];
const mockClient = () => createDeepSeekClient({
  apiKey: 'mock',
  model: 'deepseek-chat',
  maxCompletionTokens: 512,
  fixturePath: join(process.cwd(), 'tests/fixtures/deepseek-web/mock-completion.json'),
});
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); dirs.length = 0; vi.unstubAllEnvs(); });
describe('deepseek-web CLI runtime wiring', () => {
  test('once without COLLECTOR_DB fails closed before fetch or model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-no-db-'));
    dirs.push(dir);
    vi.stubEnv('COLLECTOR_DB', '');
    const fetchSpy = vi.fn(() => { throw new Error('fetch_forbidden'); });
    await expect(deepSeekWebCli(['once', 'https://www.stokke.com/KOR/'], { stateDir: dir, fetchImpl: fetchSpy, client: mockClient() }))
      .rejects.toThrow('collector_db_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('once with momcalendar stopped still collects allowed fixture domain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cli-'));
    dirs.push(dir);
    const f = fixture();
    f.store.put('domain_state', 'momcalendar.com', { next_at: 0, stopped: true, reason: 'blocked' });
    const fetchSpy = vi.fn(() => { throw new Error('fetch_forbidden'); });
    const report = await deepSeekWebCli(
      ['once', 'https://momcalendar.com/calendar', 'https://fixture.example/deepseek-web-sample'],
      { store: f.store, stateDir: dir, fetchImpl: fetchSpy, client: mockClient() },
    );
    expect(report.blocked).toBe(1);
    expect(report.extractions).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    f.close();
  });
  test('once aborts on explicit global emergency_stop meta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cli-'));
    dirs.push(dir);
    const f = fixture();
    f.store.put('collector_meta', EMERGENCY_STOP_META_ID, { stopped: true, reason: 'operator' });
    const fetchSpy = vi.fn(() => { throw new Error('fetch_forbidden'); });
    await expect(deepSeekWebCli(
      ['once', 'https://fixture.example/deepseek-web-sample'],
      { store: f.store, stateDir: dir, fetchImpl: fetchSpy, client: mockClient() },
    )).rejects.toThrow('emergency_stop');
    expect(fetchSpy).not.toHaveBeenCalled();
    f.close();
  });
  test('redirect to stopped momcalendar refuses model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cl-redirect-'));
    dirs.push(dir);
    const f = fixture();
    f.store.put('domain_state', 'momcalendar.com', { stopped: true, next_at: 0, reason: 'blocked' });
    const completeSpy = vi.fn();
    const report = await runDeepSeekWeb({
      mode: 'once',
      store: f.store,
      stateDir: dir,
      urls: ['https://allowed.example/start'],
      client: { complete: completeSpy },
      fetchPage: async () => ({ ok: true, text: 'redirected body', finalUrl: 'https://www.momcalendar.com/landing' }),
    });
    expect(report.blocked).toBe(1);
    expect(completeSpy).not.toHaveBeenCalled();
    f.close();
  });
  test('policy flipped to stopped before model refuses DeepSeek', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-policy-flip-'));
    dirs.push(dir);
    const f = fixture();
    const completeSpy = vi.fn();
    const report = await runDeepSeekWeb({
      mode: 'once',
      store: f.store,
      stateDir: dir,
      urls: ['https://allowed.example/page'],
      client: { complete: completeSpy },
      fetchPage: async () => {
        f.store.put('domain_state', 'allowed.example', { stopped: true, next_at: 0, reason: 'blocked' });
        return { ok: true, text: 'body', finalUrl: 'https://allowed.example/page' };
      },
    });
    expect(report.blocked).toBe(1);
    expect(completeSpy).not.toHaveBeenCalled();
    f.close();
  });
  test('once aborts when domain_state table is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cli-'));
    dirs.push(dir);
    const f = fixture();
    const store = f.store;
    vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('db_locked'); });
    await expect(deepSeekWebCli(['once', 'https://www.stokke.com/'], { store, stateDir: dir, client: mockClient() }))
      .rejects.toThrow('domain_state_unavailable');
    f.close();
  });
  test('dry-run fixture path uses mock client without collector db', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cli-dry-'));
    dirs.push(dir);
    vi.stubEnv('COLLECTOR_DB', '');
    const fetchSpy = vi.fn(() => { throw new Error('fetch_forbidden'); });
    const report = await deepSeekWebCli(['dry-run'], { stateDir: dir, fetchImpl: fetchSpy, client: mockClient() });
    expect(report.extractions).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
