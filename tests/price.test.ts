import { test } from 'vitest';
import assert from 'node:assert/strict';
import { models } from '../seed/models.json';
import { comparison, displayableOfficialPrice, importerStatusLabel, isImporterStatus, money, type Model, type Deal } from '../lib/data';

const model = (i: number): Model => {
  const m = models[i - 1];
  assert.ok(isImporterStatus(m.kr_importer_status), m.model);
  return { id: `model-${i}`, brand: m.brand, name: m.model, category: m.category, importer: m.kr_importer, importer_status: m.kr_importer_status, official_price: m.kr_official_price_krw, source_url: m.source_url, checked: m.checked, verify_level: m.verify_level, note: m.note };
};

test.each([
  ['confirmed', null], ['unconfirmed', '수입사 미확인'], ['recheck_failed', '기존 정보, 재확인 실패'],
] as const)('importer status %s has a neutral label', (status, label) => {
  assert.equal(isImporterStatus(status), true);
  assert.equal(importerStatusLabel(status), label);
});

test.each([null, undefined, '', 'bogus', 'toString', '__proto__'])('unknown importer status %s stays unconfirmed', status => {
  assert.equal(isImporterStatus(status), false);
  assert.equal(importerStatusLabel(status), '수입사 미확인');
});

test.each([430000, 0])('page_body official price %s is displayable', official_price => {
  assert.equal(displayableOfficialPrice({ official_price, verify_level: 'page_body' }), official_price);
});

test.each([null, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid official price %s is hidden', official_price => {
  assert.equal(displayableOfficialPrice({ official_price, verify_level: 'page_body' }), null);
});

test.each(['page_text', 'search_summary', 'official_unpublished', 'manual', '', null])('official price with level %s is hidden', verify_level => {
  assert.equal(displayableOfficialPrice({ official_price: 430000, verify_level }), null);
  const result = comparison({ ...model(1), official_price: 430000, verify_level: verify_level ?? '' }, []);
  assert.deepEqual(result.official, {
    price: null, source: model(1).source_url, checked: model(1).checked, verify_level: verify_level ?? '',
  });
});

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
    image_url: null, price: 390000, source_url: 'https://example.com/deal', verify_level: 'manual',
    checked: '2026-10-21', starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-10-22T00:00:00Z',
  };
  const deals = [base, { ...base, id: 'unknown', price: null }, { ...base, id: 'free', price: 0 },
    { ...base, id: 'other-model', model_id: 'model-2', price: 999999 }];
  assert.deepEqual(comparison(model(1), deals).gonggu, deals.slice(0, 3).map(d => ({ ...d, advertisement: true })));
  assert.equal(comparison(model(2), deals).gonggu[0].price, 999999);
  assert.deepEqual(comparison(model(27), deals).gonggu, []);
});
