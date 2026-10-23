import { expect, test } from 'vitest';
import { buildModelCards, discountLabel, showStrike } from '../lib/model-cards';
import { ILLUSTRATED_MODEL_IDS, SQUARE_MODEL_IDS, modelIllustration } from '../lib/model-illustrations';
import type { Gap } from '../lib/deals';

const NOW = Date.parse('2026-10-21T03:00:00Z');
const model = (id: string, official: number | null = 430000) => ({ id, name: `name-${id}`, brand: 'Stokke', official_price: official });
const deal = (model_id: string, price: number | null, starts_at: string, ends_at: string) => ({ model_id, price, starts_at, ends_at });
const ACTIVE = ['2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z'] as const;
const gap = (relation: Gap['relation'], percent: number): Gap => ({ relation, won: 1, percent });

test('uses the lowest active price and ignores ended, upcoming and unknown deals', () => {
  const [card] = buildModelCards([model('model-1')], [
    deal('model-1', 410000, ...ACTIVE),
    deal('model-1', 390000, ...ACTIVE),
    deal('model-1', 300000, '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z'),
    deal('model-1', 200000, '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'),
    deal('model-1', 100000, 'bad', 'dates'),
    deal('model-2', 1000, ...ACTIVE),
  ], NOW);
  expect(card.deal).toEqual({ price: 390000 });
  expect(card.gap?.relation).toBe('below');
  expect(discountLabel(card.gap)).toBe('-9%');
});

test('an active deal without any price keeps a null-price deal and no gap', () => {
  const [card] = buildModelCards([model('model-3')], [deal('model-3', null, ...ACTIVE)], NOW);
  expect(card.deal).toEqual({ price: null });
  expect(card.gap).toBeNull();
  const [mixed] = buildModelCards([model('model-3')], [deal('model-3', null, ...ACTIVE), deal('model-3', 400000, ...ACTIVE)], NOW);
  expect(mixed.deal).toEqual({ price: 400000 });
});

test('no gap when the official price is unknown', () => {
  const [card] = buildModelCards([model('model-1', null)], [deal('model-1', 390000, ...ACTIVE)], NOW);
  expect(card.deal).toEqual({ price: 390000 });
  expect(card.gap).toBeNull();
});

test('active models come first, otherwise input order is kept and inputs are not mutated', () => {
  const models = [model('a'), model('b'), model('c'), model('d')];
  const deals = [deal('d', 1, ...ACTIVE), deal('b', 2, ...ACTIVE)];
  const modelsCopy = structuredClone(models);
  const dealsCopy = structuredClone(deals);
  const cards = buildModelCards(models, deals, NOW);
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
    const square = (SQUARE_MODEL_IDS as readonly string[]).includes(id);
    expect(modelIllustration(id)).toEqual({
      src: `/img/models/${id}-540x${square ? 540 : 675}.png`,
      srcSet: `/img/models/${id}-252x${square ? 252 : 315}.png 252w, /img/models/${id}-540x${square ? 540 : 675}.png 540w`,
      width: 540, height: square ? 540 : 675, lineArt: square,
    });
  }
  for (const id of ['model-3', 'model-41', '../model-1', 'model-1/../model-2', '', 'MODEL-1']) expect(modelIllustration(id)).toBeNull();
});
