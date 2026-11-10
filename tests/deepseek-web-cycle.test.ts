import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { beginCycle, finalizeCycle, cycleAdmit, cycleSettle, cycleHold } from '../crawler/src/deepseek-web/budget-cycle';
import { admitCall, perCallTokenReserve } from '../crawler/src/deepseek-web/guards';
import { loadMemory } from '../crawler/src/deepseek-web/memory';
import { fixture } from './helpers/collector';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { readFile } from 'node:fs/promises';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); dirs.length = 0; });

const PANGPANG_SEARCH = 'https://09pangpang.com/search/r/%EC%9C%A1%EC%95%84%ED%85%9C';

describe('deepseek-web budget cycle', () => {
  const config = loadDeepSeekWebConfig();
  test('v1 memory migrates lifetime without starving next tick', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-mig-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'memory.json'), `${JSON.stringify({
      version: 1,
      updated_at: '2026-11-08T04:14:42.372Z',
      plan_notes: ['halt: budget_tokens'],
      observed_urls: [PANGPANG_SEARCH],
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
  test('unchanged fixture is revalidated and uses the content cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-dup-'));
    dirs.push(dir);
    const f = fixture();
    const url = 'https://fixture.example/deepseek-web-sample';
    const complete = { complete: async () => ({ content: '{"brand":"A","model":"B","category":"정보 없음","gonggu_price":"정보 없음","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":false}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'deepseek-chat' }) };
    const first = await runDeepSeekWeb({ mode: 'dry_run', stateDir: dir, store: f.store, urls: [url], client: complete });
    expect(first.requests_spent).toBe(1);
    const second = await runDeepSeekWeb({ mode: 'dry_run', stateDir: dir, store: f.store, urls: [url], client: complete });
    expect(second.extraction_cache_hits).toBe(1);
    expect(second.deepseek_calls_attempted).toBe(0);
    expect(second.blocked).toBe(0);
    expect(second.requests_spent).toBe(0);
    f.close();
  });
  test('pangpang listing enqueues core detail without model call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-pp-'));
    dirs.push(dir);
    const f = fixture();
    const coreList = `<div><a data-feed-index="0" href="/post/900001"><p class="line-clamp-2 text-base font-bold">Cybex 유모차</p></a><span class="text-category">키즈 &gt; 유모차</span><span>11/4 (월) 오픈</span></div>`;
    const complete = { complete: async () => { throw new Error('model_should_not_run'); } };
    const report = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [PANGPANG_SEARCH],
      client: complete,
      fetchPage: async () => ({ ok: true, text: coreList, finalUrl: PANGPANG_SEARCH }),
    });
    expect(report.requests_spent).toBe(0);
    expect(report.listing_enqueued).toBe(1);
    const mem = await loadMemory(dir);
    expect(mem.pending_urls).toEqual(['https://09pangpang.com/post/900001']);
    f.close();
  });
  test('real 육아템 search fixture: 30 raw, 0 scoped, no model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-pp-real-'));
    dirs.push(dir);
    const f = fixture();
    const searchHtml = await readFile(join(process.cwd(), 'tests/fixtures/external/pangpang/search-yugatem.html'), 'utf8');
    const report = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [PANGPANG_SEARCH],
      client: { complete: async () => { throw new Error('model_should_not_run'); } },
      fetchPage: async () => ({ ok: true, text: searchHtml, finalUrl: PANGPANG_SEARCH }),
    });
    expect(report.requests_spent).toBe(0);
    expect(report.listing_enqueued).toBe(0);
    expect(report.collection_status).toBe('listing_no_candidates');
    const mem = await loadMemory(dir);
    expect(mem.pending_urls).toHaveLength(0);
    expect(mem.next_search_hints.length).toBeGreaterThan(0);
    const outcomes = (await readFile(join(dir, 'outcomes.jsonl'), 'utf8')).trim().split('\n');
    const row = JSON.parse(outcomes[outcomes.length - 1]);
    expect(row.outcome).toBe('listing_scope_no_core');
    expect(row.detail.raw_product_count).toBe(30);
    f.close();
  });
  test('migrated observed pangpang seed runs listing discovery without touching lifetime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-mig-pp-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'memory.json'), `${JSON.stringify({
      version: 2,
      updated_at: '2026-11-08T05:12:44.000Z',
      plan_notes: [],
      observed_urls: [PANGPANG_SEARCH],
      pending_urls: [],
      token_spent: 0,
      tokens_reserved: 0,
      requests_spent: 0,
      requests_reserved: 0,
      cycle: { cycle_id: 'x', token_spent: 0, tokens_reserved: 0, requests_spent: 0, requests_reserved: 0 },
      lifetime: { token_spent: 19871, requests: 3, cycles: 2, model_calls: 3 },
      last_heartbeat_at: '2026-11-08T05:12:44.000Z',
      last_run_id: 'prev',
      last_collection_status: 'idle_dedup',
      listing_discovery: {},
      output_counts: { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 },
    }, null, 2)}\n`);
    const f = fixture();
    const searchHtml = await readFile(join(process.cwd(), 'tests/fixtures/external/pangpang/search-yugatem.html'), 'utf8');
    const fetchSpy = vi.fn(async () => ({ ok: true as const, text: searchHtml, finalUrl: PANGPANG_SEARCH }));
    const report = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [PANGPANG_SEARCH],
      client: { complete: async () => { throw new Error('model_should_not_run'); } },
      fetchPage: fetchSpy,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(report.requests_spent).toBe(0);
    expect(report.lifetime_token_spent).toBe(19871);
    expect(report.listing_enqueued).toBe(0);
    expect(report.collection_status).toBe('listing_no_candidates');
    const mem = await loadMemory(dir);
    expect(mem.pending_urls).toHaveLength(0);
    expect(mem.lifetime.token_spent).toBe(19871);
    expect(mem.listing_discovery[PANGPANG_SEARCH]?.last_enqueue_count).toBe(0);
    expect(mem.next_search_hints.some((u: string) => u.includes('%EC%9C%A0%EB%AA%A8%EC%B0%A8'))).toBe(true);
    f.close();
  });
  test('stable listing within refresh window dedups without refetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-pp-dedup-'));
    dirs.push(dir);
    const f = fixture();
    const searchHtml = await readFile(join(process.cwd(), 'tests/fixtures/external/pangpang/search-yugatem.html'), 'utf8');
    const t0 = Date.parse('2026-11-08T05:00:00.000Z');
    let t = t0;
    const fetchSpy = vi.fn(async () => ({ ok: true as const, text: searchHtml, finalUrl: PANGPANG_SEARCH }));
    await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [PANGPANG_SEARCH],
      client: { complete: async () => { throw new Error('model_should_not_run'); } },
      fetchPage: fetchSpy,
      now: () => t,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();
    t += 60_000;
    const mem = await loadMemory(dir);
    mem.pending_urls = [];
    await (await import('../crawler/src/deepseek-web/memory')).saveMemory(dir, mem);
    const second = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [PANGPANG_SEARCH],
      client: { complete: async () => { throw new Error('model_should_not_run'); } },
      fetchPage: fetchSpy,
      now: () => t,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(second.collection_status).toBe('idle_dedup');
    expect(second.halt_reason).toBe('dedup_observed_seed');
    expect(second.requests_spent).toBe(0);
    f.close();
  });
  test('empty listing reports listing_no_candidates honestly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsw-pp-empty-'));
    dirs.push(dir);
    const f = fixture();
    const emptyList = '<html><body><main><p>no posts</p></main></body></html>';
    const report = await runDeepSeekWeb({
      mode: 'once',
      stateDir: dir,
      store: f.store,
      urls: [PANGPANG_SEARCH],
      client: { complete: async () => { throw new Error('model_should_not_run'); } },
      fetchPage: async () => ({ ok: true, text: emptyList, finalUrl: PANGPANG_SEARCH }),
    });
    expect(report.collection_status).toBe('listing_no_candidates');
    expect(report.listing_enqueued).toBe(0);
    expect(report.requests_spent).toBe(0);
    f.close();
  });
});
