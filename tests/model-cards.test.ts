import { expect, test } from 'vitest';
import { buildModelCards, discountLabel, showStrike } from '../lib/model-cards';
import { ILLUSTRATED_MODEL_IDS, modelIllustration } from '../lib/model-illustrations';
import type { Gap } from '../lib/deals';

const model = (id: string, official: number | null = 430000) => ({ id, name: `name-${id}`, brand: 'Stokke', official_price: official, verify_level: 'page_body' });
const summaries = (...rows: [string, number, number | null][]) => new Map(rows.map(([model_id, active_count, lowest_price]) => [model_id, { model_id, active_count, lowest_price }]));
const gap = (relation: Gap['relation'], percent: number): Gap => ({ relation, won: 1, percent });

test.each(['page_text', 'search_summary'])('gates %s prices before calculating model card discounts', verify_level => {
  const [card] = buildModelCards([{ ...model('model-1', 500000), verify_level }], summaries(['model-1', 2, 400000]));
  expect(card.official_price).toBeNull();
  expect(card.gap).toBeNull();
  expect(card.deal).toEqual({ price: 400000 });
  expect(showStrike(card.gap)).toBe(false);
  expect(discountLabel(card.gap)).toBeNull();
});

test('page_body prices retain model card discounts and strikethroughs', () => {
  const [card] = buildModelCards([model('model-1', 500000)], summaries(['model-1', 2, 400000]));
  expect(card.official_price).toBe(500000);
  expect(card.gap).toEqual({ relation: 'below', won: 100000, percent: 20 });
  expect(showStrike(card.gap)).toBe(true);
  expect(discountLabel(card.gap)).toBe('-20%');
});

test('uses the aggregated minimum without loading deal history', () => {
  const [card] = buildModelCards([model('model-1')], summaries(['model-1', 3, 390000]));
  expect(card.deal).toEqual({ price: 390000 });
  expect(card.gap?.relation).toBe('below');
  expect(discountLabel(card.gap)).toBe('-9%');
});

test('an active deal without any price keeps a null-price deal and no gap', () => {
  const [card] = buildModelCards([model('model-3')], summaries(['model-3', 2, null]));
  expect(card.deal).toEqual({ price: null });
  expect(card.gap).toBeNull();
  const [mixed] = buildModelCards([model('model-3')], summaries(['model-3', 2, 400000]));
  expect(mixed.deal).toEqual({ price: 400000 });
});

test('no gap when the official price is unknown', () => {
  const [card] = buildModelCards([model('model-1', null)], summaries(['model-1', 1, 390000]));
  expect(card.deal).toEqual({ price: 390000 });
  expect(card.gap).toBeNull();
});

test('active models come first, otherwise input order is kept and inputs are not mutated', () => {
  const models = [model('a'), model('b'), model('c'), model('d')];
  const deals = summaries(['d', 1, 1], ['b', 1, 2], ['a', 0, null]);
  const modelsCopy = structuredClone(models);
  const dealsCopy = structuredClone(deals);
  const cards = buildModelCards(models, deals);
  expect(cards.map(c => c.id)).toEqual(['b', 'd', 'a', 'c']);
  expect(models).toEqual(modelsCopy);
  expect(deals).toEqual(dealsCopy);
  expect(cards.every(c => c.deal === null || c.deal.price !== undefined)).toBe(true);
});

test('discount pill only for a rounded drop of at least 1%', () => {
  expect(discountLabel(gap('below', 18.4))).toBe('-18%');
  expect(discountLabel(gap('below', 0.4))).toBeNull();
  expect(discountLabel(gap('below', 0.5))).toBe('-1%');
  expect(discountLabel(gap('equal', 0))).toBeNull();
  expect(discountLabel(gap('above', 12))).toBeNull();
  expect(discountLabel(null)).toBeNull();
});

test('strikethrough follows the same condition as the pill', () => {
  for (const g of [gap('below', 18.4), gap('below', 0.4), gap('below', 0.5), gap('equal', 0), gap('above', 12), null]) {
    expect(showStrike(g)).toBe(discountLabel(g) !== null);
  }
});

test('illustrations resolve only for listed IDs', () => {
  for (const id of ILLUSTRATED_MODEL_IDS) {
    expect(modelIllustration(id)).toEqual({
      src: `/img/models/${id}.svg`,
      width: 1080, height: 1080,
    });
  }
  for (const id of ['model-42', 'model-0', '../model-1', 'model-1/../model-2', '', 'MODEL-1']) expect(modelIllustration(id)).toBeNull();
});
