import { displayableOfficialPrice, type Deal, type Model } from './data';
import { dealTiming, priceGap, type Gap } from './deals';

export type ModelCardData = {
  id: string;
  name: string;
  brand: string;
  official_price: number | null;
  deal: { price: number | null } | null;
  gap: Gap | null;
};

export function buildModelCards(
  models: readonly Pick<Model, 'id' | 'name' | 'brand' | 'official_price' | 'verify_level'>[],
  deals: readonly Pick<Deal, 'model_id' | 'price' | 'starts_at' | 'ends_at'>[],
  nowMs: number,
): ModelCardData[] {
  const best = new Map<string, number | null>();
  for (const deal of deals) {
    if (dealTiming(deal.starts_at, deal.ends_at, nowMs).state !== 'active') continue;
    const price = deal.price !== null && deal.price >= 0 ? deal.price : null;
    const current = best.get(deal.model_id);
    if (current === undefined || (price !== null && (current === null || price < current))) best.set(deal.model_id, price);
  }
  const cards = models.map((m): ModelCardData => {
    const price = best.get(m.id);
    const deal = price === undefined ? null : { price };
    const official = displayableOfficialPrice(m);
    return {
      id: m.id, name: m.name, brand: m.brand, official_price: official, deal,
      gap: deal && deal.price !== null ? priceGap(deal.price, official) : null,
    };
  });
  return [...cards.filter(c => c.deal !== null), ...cards.filter(c => c.deal === null)];
}

// The pill and the strikethrough share one condition so they never disagree.
export function discountLabel(gap: Gap | null): string | null {
  if (!gap || gap.relation !== 'below') return null;
  const percent = Math.round(gap.percent);
  return percent >= 1 ? `-${percent}%` : null;
}

export function showStrike(gap: Gap | null): boolean {
  return discountLabel(gap) !== null;
}
