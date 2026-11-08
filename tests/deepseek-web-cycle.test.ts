import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { beginCycle, finalizeCycle, cycleAdmit, cycleSettle, cycleHold } from '../crawler/src/deepseek-web/budget-cycle';
import { admitCall, perCallTokenReserve } from '../crawler/src/deepseek-web/guards';
import { emptyMemory, saveMemory, loadMemory } from '../crawler/src/deepseek-web/memory';
import { fixture } from './helpers/collector';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { readFile } from 'node:fs/promises';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); dirs.length = 0; });

describe('deepseek-web budget cycle', () => {
  const config = loadDeepSeekWebConfig();
  test('v1 memory migrates lifetime without starving next tick', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-mig-'));
    dirs.push(dir);
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'memory.json'), `${JSON.stringify({
      version: 1,
      updated_at: '2026-11-08T04:14:42.372Z',
      plan_notes: ['halt: budget_tokens'],
      observed_urls: ['https://09pangpang.com/search/r/x'],
      pending_urls: [],
      token_spent: 19871,
      tokens_reserved: 0,
      requests_spent: 3,
      requests_reserved: 0,
      last_heartbeat_at: '2026-11-08T04:14:42.372Z',
      last_run_id: '91e9e6e0-cc5e-4efa-a3e1-e5b01c579350',
      output_counts: { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 },
    }, null, 2)}\n`);
    let memory = beginCycle(await loadMemory(dir), 'tick-2');
    const reserve = perCallTokenReserve(config);
    expect(admitCall(memory.cycle, config).ok).toBe(true);
    cycleHold(memory, reserve);
    cycleSettle(memory, reserve, 500);
    await finalizeCycle(dir, memory, { run_id: 'tick-2' });
    expect(memory.lifetime.token_spent).toBe(19871 + 500);
    expect(memory.lifetime.model_calls).toBe(4);
    memory = beginCycle(memory, 'tick-3');
    expect(cycleAdmit(memory, config).ok).toBe(true);
  });
  test('duplicate seed URL skipped after observed without pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-dup-'));
    dirs.push(dir);
    const f = fixture();
    const url = 'https://fixture.example/deepseek-web-sample';
    const complete = { complete: async () => ({ content: '{"brand":"A","model":"B","in_scope":false}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'deepseek-chat' }) };
    const first = await runDeepSeekWeb({ mode: 'dry_run', stateDir: dir, store: f.store, urls: [url], client: complete });
    expect(first.requests_spent).toBe(1);
    const second = await runDeepSeekWeb({ mode: 'dry_run', stateDir: dir, store: f.store, urls: [url], client: complete });
    expect(second.blocked).toBe(1);
    expect(second.requests_spent).toBe(0);
    const outcomes = (await readFile(join(dir, 'outcomes.jsonl'), 'utf8')).trim().split('\n');
    expect(outcomes.some(l => JSON.parse(l).outcome === 'duplicate_skip')).toBe(true);
    f.close();
  });
  test('pangpang listing enqueues premium detail without model call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-pp-'));
    dirs.push(dir);
    const f = fixture();
    const listHtml = await readFile(join(process.cwd(), 'tests/fixtures/external/pangpang/list.html'), 'utf8');
    const searchUrl = 'https://09pangpang.com/search/r/test';
    const complete = { complete: async () => { throw new Error('model_should_not_run'); } };
    const report = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [searchUrl],
      client: complete,
      fetchPage: async () => ({ ok: true, text: listHtml, finalUrl: searchUrl }),
    });
    expect(report.requests_spent).toBe(0);
    const mem = await loadMemory(dir);
    expect(mem.pending_urls.length).toBeGreaterThan(0);
    f.close();
  });
});
