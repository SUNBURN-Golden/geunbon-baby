import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixture } from './helpers/collector';
import { deepSeekWebCli } from '../crawler/src/deepseek-web/cli';
import { createDeepSeekClient } from '../crawler/src/deepseek-web/client';
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
    vi.stubEnv('COLLECTOR_DB', '');
    const fetchSpy = vi.fn(() => { throw new Error('fetch_forbidden'); });
    await expect(deepSeekWebCli(['once', 'https://www.stokke.com/KOR/'], { fetchImpl: fetchSpy, client: mockClient() }))
      .rejects.toThrow('collector_db_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('once fails closed when collector domain_state is stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cli-'));
    dirs.push(dir);
    const f = fixture();
    f.store.put('domain_state', 'www.stokke.com', { next_at: 0, stopped: true, reason: 'access_restricted' });
    const fetchSpy = vi.fn(() => { throw new Error('fetch_forbidden'); });
    const completeSpy = vi.fn();
    await expect(deepSeekWebCli(
      ['once', 'https://www.stokke.com/KOR/ko-kr/'],
      { store: f.store, stateDir: dir, fetchImpl: fetchSpy, client: { complete: completeSpy } },
    )).rejects.toThrow('domain_stopped');
    expect(fetchSpy).not.toHaveBeenCalled();
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
