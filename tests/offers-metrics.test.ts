import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { exportOfferMetrics, offerEvent } from '../crawler/src/offers/metrics';
import { stopInstagram } from '../crawler/src/offers/transport';
import { temporaryOfferStore } from './helpers/offer-store';

test('exports completed and idle hours, deduplicates gates/publications, and repairs interrupted tails', () => {
  let now = Date.parse('2026-11-23T14:30:00Z');
  const f = temporaryOfferStore(() => now);
  const path = join(f.dir, 'metrics-hourly.jsonl');
  try {
    offerEvent(f.store, 'scan:fixture', 'scan', {});
    offerEvent(f.store, 'candidate:fixture', 'product', { product: 'same-product' });
    for (const key of ['a','b']) offerEvent(f.store, key, 'rejected', { product: 'same-product', gates: ['missing_deadline','missing_official_coverage'] });
    for (let i = 0; i < 2; i++) offerEvent(f.store, 'published:fixture', 'publication', { committed_at: new Date(now).toISOString() });
    offerEvent(f.store, 'usage:fixture', 'model', { model: 'deepseek-flash', input: 5, output: 2, total: 7, currency: 'USD', rate_basis: 'fixture', cost: 0.25 });
    stopInstagram(f.store, f.dir, 'checkpoint');
    now += 2 * 3600000;
    exportOfferMetrics(f.store, f.dir);
    appendFileSync(path,'{"id":');
    f.reopen();
    exportOfferMetrics(f.store, f.dir);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.type)).toEqual(['instagram_stop','hour','hour']);
    expect(rows[1]).toMatchObject({ candidates: 1, rejected: 1, published: 1, sources_scanned: 1,
      rejected_by_gate: { missing_deadline: 1, missing_official_coverage: 1 },
      models: { 'deepseek-flash': { calls: 1, input_tokens: 5, output_tokens: 2, total_tokens: 7, costs: { 'USD:fixture': 0.25 } } } });
    expect(rows[2]).toMatchObject({ candidates: 0, rejected: 0, published: 0, sources_scanned: 0 });
  } finally { f.close(); }
});
