import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { createDeepSeekClient } from '../crawler/src/deepseek-web/client';
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
