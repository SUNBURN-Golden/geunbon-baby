import { test } from 'vitest';
import assert from 'node:assert/strict';
import { models } from '../seed/models.json';
import { comparison, money, type Model, type Deal } from '../lib/data';

const model = (i: number): Model => {
  const m = models[i - 1];
  return { id: `model-${i}`, brand: m.brand, name: m.model, category: m.category, importer: m.kr_importer, official_price: m.kr_official_price_krw, source_url: m.source_url, checked: m.checked, verify_level: m.verify_level, note: m.note };
};

test('missing prices are never zero or inferred from notes', () => {
  assert.equal(money(null), '정보 없음');
  assert.equal(money(undefined), '정보 없음');
  assert.equal(money(0), '0원');
  assert.equal(comparison(model(40), []).official.price, null);
  const unknown = { ...model(1), official_price: null, note: 'Retailer 123,456원; used 234,567원; overseas $799' };
  assert.equal(comparison(unknown, []).official.price, null);
});

test('all seed models expose only official and group-buy comparison data, without notes', () => {
  for (let i = 1; i <= models.length; i++) {
    const m = model(i);
    const result = comparison(m, []);
    assert.deepEqual(result, {
      gonggu: [],
      official: { price: m.official_price, source: m.source_url, checked: m.checked, verify_level: m.verify_level },
    });
  }
});

test('group-buy prices come only from matching deals, preserving missing and zero prices', () => {
  const base: Deal = {
    id: 'deal-1', model_id: 'model-1', seller_id: 'seller-1', title: 'Reviewed deal',
    price: 390000, source_url: 'https://example.com/deal', verify_level: 'manual',
    checked: '2026-10-21', starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-22T00:00:00Z',
  };
  const deals = [base, { ...base, id: 'unknown', price: null }, { ...base, id: 'free', price: 0 },
    { ...base, id: 'other-model', model_id: 'model-2', price: 999999 }];
  assert.deepEqual(comparison(model(1), deals).gonggu, deals.slice(0, 3).map(d => ({ ...d, advertisement: true })));
  assert.equal(comparison(model(2), deals).gonggu[0].price, 999999);
  assert.deepEqual(comparison(model(27), deals).gonggu, []);
});
