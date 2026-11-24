import { expect, test } from 'vitest';
import { checkedAt } from './helpers/verified-deal-prices';
import { seal, verifiedFixture } from './helpers/verified-offer';
import { verifyBody } from '../lib/verified-offers';
import { OFFER_FRESHNESS_MS } from '../shared/verified-offer';

const now = Date.parse(checkedAt);
test('whole-item free passes while list-price and sub-1% offers stay private', async () => {
  for (const [deal, list, valid] of [[0,430000,true],[390000,430000,true],[430000,430000,false],[430001,430000,false],[429999,430000,false]] as const) {
    const { offer } = await verifiedFixture(deal, list);
    expect(!!await verifyBody(offer, now)).toBe(valid);
  }
});

test('Worker derives publication facts from independent readings and bound captures', async () => {
  const { offer } = await verifiedFixture();
  expect(await verifyBody(offer, now)).toBeTruthy();
  expect(await verifyBody(offer, now + OFFER_FRESHNESS_MS + 1)).toBeNull();
  const updates = [
    { deal_price_krw: 390001 }, { list_price_krw: 430001 }, { price_source_url: 'https://other.example.com/' },
    { list_price_source_url: 'https://other.example.com/' }, { price_checked_at: '2026-11-21T00:00:00.000Z' },
    { ends_at: '2026-11-25T14:59:59.999Z' }, { orders_open: true }, { deadline_precision: 'hour' },
    { configuration: { ...offer.facts.configuration, quantity: '2개' } },
  ];
  for (const update of updates) {
    expect(await verifyBody({ ...offer, facts: { ...offer.facts, ...update } }, now)).toBeNull();
    expect(await verifyBody(await seal({ ...offer, facts: { ...offer.facts, ...update } }), now)).toBeNull();
  }
  for (const broken of [
    (draft: typeof offer) => { draft.price_evidence.offer!.readings[1]!.amount = 380000; },
    (draft: typeof offer) => { draft.price_evidence.official!.source.hash = '0'.repeat(64); },
    (draft: typeof offer) => { draft.price_evidence.offer!.readings[0]!.deadline = null; draft.facts.availability = 'ongoing'; },
    (draft: typeof offer) => { draft.price_evidence.official_approval!.variant!.site_model_id = 'model-2'; },
    (draft: typeof offer) => { draft.metadata[1].seller!.value = 'https://other.example.com/'; },
    (draft: typeof offer) => { draft.liveness.url = 'https://other.example.com/'; },
  ]) {
    const draft = structuredClone(offer);
    broken(draft);
    expect(await verifyBody(await seal(draft), now)).toBeNull();
  }
});
