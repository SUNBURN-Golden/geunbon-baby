import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { emptyMemory, loadMemory, saveMemory } from '../crawler/src/deepseek-web/memory';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import type { DeepSeekWebConfig, ScopedCategory } from '../crawler/src/deepseek-web/types';
import { fixture } from './helpers/collector';

const ALL_CATEGORIES: ScopedCategory[] = ['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer'];
const dirs: string[] = [];
const stores: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of stores.splice(0)) f.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsw-rotation-run-'));
  dirs.push(dir);
  return dir;
}
function configWith(pages: number, categories: ScopedCategory[] = []): DeepSeekWebConfig {
  const config = structuredClone(loadDeepSeekWebConfig());
  for (const source of config.official_sources) source.enabled = false;
  config.selection.max_pages_per_cycle = pages;
  config.selection.category_quota_per_cycle = 1;
  config.selection.legacy_budget_per_cycle = 0;
  config.scope_categories = config.scope_categories.filter(category => !categories.length || categories.includes(category.id));
  config.fetch.min_interval_ms = 0;
  config.fetch.jitter_ms = [0, 0];
  return config;
}
async function seedBacklog(dir: string) {
  const memory = emptyMemory();
  let start = 910100;
  for (const [category, count] of [['stroller', 10], ['carrier', 2], ['bouncer', 2]] as [ScopedCategory, number][]) {
    for (let i = 0; i < count; i++) {
      const url = `https://09pangpang.com/post/${start + i}`;
      memory.pending_urls.push(url);
      memory.pending_catalog_meta[url] = { catalog_product_id: `catalog-${category}`, category };
    }
    start += 100;
  }
  await saveMemory(dir, memory);
}
const noModel = { complete: vi.fn() };
const rejectDetail = async (url: string) => ({ ok: true as const, text: '<html><body>no deal</body></html>', finalUrl: url });

describe('deepseek-web runner rotation', () => {
  test('a two-page cycle visits every enabled category within three cycles', async () => {
    const f = fixture();
    stores.push(f);
    const config = configWith(2);
    const dir = stateDir();
    const served = new Set<ScopedCategory>();
    const pages: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const report = await runDeepSeekWeb({
        mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config,
        now: () => Date.parse('2026-10-23T01:00:00Z'), client: noModel,
        fetchPage: async url => {
          pages.push(1);
          return { ok: true, text: '<html><body>no products</body></html>', finalUrl: url };
        },
      });
      expect(report.outcome).toBe('completed');
      for (const category of report.coverage!.rotation.served) served.add(category);
    }
    expect([...served].sort()).toEqual([...ALL_CATEGORIES].sort());
    expect(pages).toHaveLength(6);
    expect(noModel.complete).not.toHaveBeenCalled();
  }, 20000);

  test('a stroller-heavy backlog cannot starve carriers or bouncers', async () => {
    const f = fixture();
    stores.push(f);
    const config = configWith(3);
    const dir = stateDir();
    await seedBacklog(dir);
    const calls: string[][] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const cycleCalls: string[] = [];
      const report = await runDeepSeekWeb({
        mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config,
        now: () => Date.parse('2026-10-23T01:00:00Z') + cycle * 600000, client: noModel,
        fetchPage: async url => { cycleCalls.push(url); return rejectDetail(url); },
      });
      expect(report.coverage!.rotation.planned_pages).toBeLessThanOrEqual(3);
      calls.push(cycleCalls);
      if (cycle === 0) expect(report.coverage!.rotation.served).toEqual(expect.arrayContaining(['stroller', 'high_chair', 'car_seat']));
    }
    expect(calls.every(cycle => cycle.length <= 3)).toBe(true);
    const memory = await loadMemory(dir);
    const remaining = memory.pending_urls.map(url => memory.pending_catalog_meta[url]?.category);
    expect(remaining.filter(category => category === 'stroller')).toHaveLength(7);
    expect(remaining.filter(category => category !== 'stroller')).toHaveLength(0);
  }, 30000);

  test('explicit operator URLs bypass rotation and leave cursors untouched', async () => {
    const f = fixture();
    stores.push(f);
    const config = configWith(6);
    const dir = stateDir();
    const extraction = async () => ({ content: '{"brand":"A","model":"B","category":"정보 없음","gonggu_price":"정보 없음","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":false}', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'deepseek-chat' });
    const first = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config,
      now: () => Date.parse('2026-10-23T01:00:00Z'), client: { complete: extraction },
      urls: ['https://fixture.example/deepseek-web-sample'],
    });
    expect(first.outcome).toBe('completed');
    let memory = await loadMemory(dir);
    expect(memory.rotation.category_cursor).toBe(0);
    expect(memory.rotation.search_cursor).toEqual({});
    const second = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config,
      now: () => Date.parse('2026-10-23T02:00:00Z'), client: { complete: extraction },
      urls: ['https://fixture.example/deepseek-web-sample'],
    });
    expect(second.outcome).toBe('completed');
    memory = await loadMemory(dir);
    expect(memory.rotation.category_cursor).toBe(0);
  }, 20000);
});
