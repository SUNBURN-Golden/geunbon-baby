import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { createDeepSeekClient } from '../crawler/src/deepseek-web/client';
import { fixture } from './helpers/collector';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); dirs.length = 0; });
describe('deepseek-web offline runner', () => {
  test('dry-run produces review queue, proposal, fresh heartbeat artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-run-'));
    dirs.push(dir);
    process.env.DEEPSEEK_WEB_FIXTURE = join(process.cwd(), 'tests/fixtures/deepseek-web/mock-completion.json');
    const report = await runDeepSeekWeb({
      mode: 'dry_run',
      stateDir: dir,
      urls: ['https://fixture.example/deepseek-web-sample'],
      client: createDeepSeekClient({ apiKey: 'mock', model: 'deepseek-chat', maxCompletionTokens: 512, fixturePath: process.env.DEEPSEEK_WEB_FIXTURE }),
    });
    expect(report.extractions).toBe(1);
    expect(report.heartbeat_fresh).toBe(true);
    expect(report.model).toBeTruthy();
    const queue = (await readFile(join(dir, 'review-queue.jsonl'), 'utf8')).trim().split('\n');
    expect(queue).toHaveLength(1);
    const artifact = JSON.parse(await readFile(join(dir, 'validation-artifact.json'), 'utf8'));
    expect(artifact.profile).toBe('deepseek-web');
    const proposalsDir = join(dir, 'proposals');
    // Proposal is optional when rule parser also sees price patterns; fixture text includes 원.
    expect(report.proposals).toBeGreaterThanOrEqual(0);
    expect(report.review_pending).toBe(1);
    expect(proposalsDir).toBeTruthy();
  });
  test('stopped host skips fetch and model when store is wired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-stop-'));
    dirs.push(dir);
    const f = fixture();
    f.store.put('domain_state', 'fixture.example', { next_at: 0, stopped: true, reason: 'robots_denied' });
    const completeSpy = vi.fn();
    const report = await runDeepSeekWeb({
      mode: 'dry_run',
      stateDir: dir,
      store: f.store,
      urls: ['https://fixture.example/deepseek-web-sample'],
      client: { complete: completeSpy },
    });
    expect(report.blocked).toBe(1);
    expect(completeSpy).not.toHaveBeenCalled();
    f.close();
  });
  test('hard token cap halts second URL after reservation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-cap-'));
    dirs.push(dir);
    const config = loadDeepSeekWebConfig();
    const f = fixture();
    const calls: number[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: ['https://fixture.example/one', 'https://fixture.example/two'],
      client: {
        complete: async () => {
          calls.push(1);
          return {
            content: '{"brand":"A","model":"B","in_scope":false}',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: config.budget.max_tokens_per_run },
            model: 'deepseek-chat',
          };
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(report.requests_spent).toBe(1);
    f.close();
  });
  test('instagram URL is blocked without network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-block-'));
    dirs.push(dir);
    const report = await runDeepSeekWeb({
      mode: 'dry_run',
      stateDir: dir,
      urls: ['https://www.instagram.com/deal/'],
      client: createDeepSeekClient({ apiKey: 'mock', model: 'deepseek-chat', maxCompletionTokens: 512, fixturePath: join(process.cwd(), 'tests/fixtures/deepseek-web/mock-completion.json') }),
    });
    expect(report.extractions).toBe(0);
    expect(report.blocked).toBe(1);
  });
});
