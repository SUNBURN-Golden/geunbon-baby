import { expect, test, vi } from 'vitest';
import { parseOfferConfig } from '../crawler/src/offers/config';
import raw from '../crawler/deepseek-web/offers.json';
import { claimSource, enqueueSource, finishSource, offerCycle, reserveDetail } from '../crawler/src/offers/frontier';
import { providerClient } from '../crawler/src/offers/providers';
import type { OfferTransport } from '../crawler/src/offers/transport';
import { temporaryOfferStore } from './helpers/offer-store';

test('the frontier applies an exact source override before the claim and persists finite counters', () => {
  let now = Date.parse('2026-11-23T14:59:59Z');
  const f = temporaryOfferStore(() => now);
  try {
    const config = parseOfferConfig({ ...raw, limits: { ...raw.limits, max_pages: 0, max_queue_urls: 0 },
      source_limits: { 'offers.example.com': { max_pages: 2, max_depth: 1, max_queue_urls: 3 } } });
    const enqueue = (source: string, path: string, depth: number) => enqueueSource(f.store, config, {
      source, destination: 'https://' + source + '/' + path, depth, parent: '', locator: path, relation: 'seed', category: '',
    });
    enqueue('default.example.com', 'default', 0);
    for (let i = 0; i < 5; i++) enqueue('offers.example.com', String(i), i === 0 ? 2 : 1);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM offer_frontier WHERE gone=0').get()).toEqual({ n: 3 });
    const first = claimSource(f.store, 'web', config)!;
    const second = claimSource(f.store, 'web', config)!;
    expect(first.url).not.toBe(second.url);
    expect(claimSource(f.store, 'web', config)).toBeUndefined();
    finishSource(f.store, first, { delay: 0, cursor: 9 });
    f.reopen();
    expect(claimSource(f.store, 'web', config)).toBeUndefined();
    expect(reserveDetail(f.store, offerCycle(now), first.source, 0)).toBe(false);
    expect(reserveDetail(f.store, offerCycle(now), first.source, 1)).toBe(true);
    expect(reserveDetail(f.store, offerCycle(now), first.source, 1)).toBe(false);
    now += 1000;
    const resumed = [claimSource(f.store, 'web', config), claimSource(f.store, 'web', config)];
    expect(resumed.find(job => job?.url === first.url)?.cursor).toBe(9);
    expect(reserveDetail(f.store, offerCycle(now), first.source, 1)).toBe(true);
  } finally { f.close(); }
});

test('unlimited defaults exceed prior page and detail limits and a provider call retains its caller cycle', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key');
  const now = Date.parse('2026-11-23T15:00:00Z');
  const f = temporaryOfferStore(() => now);
  try {
    const config = parseOfferConfig(raw);
    for (let i = 0; i < 210; i++) enqueueSource(f.store, config, { source: 'example.com', destination: 'https://example.com/' + i,
      depth: i, parent: '', locator: 'seed', relation: 'seed', category: '' });
    for (let i = 0; i < 210; i++) {
      const job = claimSource(f.store, 'web', config);
      expect(job).toBeTruthy();
      expect(reserveDetail(f.store, offerCycle(now), job!.source, null)).toBe(true);
      finishSource(f.store, job!, { delay: i + 1 });
    }
    const transport = vi.fn(async () => ({ status: 200, body: JSON.stringify({ model: 'deepseek-flash',
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) })) as unknown as OfferTransport;
    const extraction = config.providers.extraction;
    extraction.budget.cycle.calls = 1;
    const client = providerClient(f.store, config, transport);
    const scope = { run: 'run-one', cycle: 'cycle-one' };
    const input = { system: 'test', user: 'fixture' };
    await client('extraction', input, scope);
    await expect(client('extraction', input, scope)).rejects.toThrow('offer_provider_budget');
    await client('extraction', input, { ...scope, cycle: 'cycle-two' });
    expect(transport).toHaveBeenCalledTimes(2);
  } finally { f.close(); vi.unstubAllEnvs(); }
});
