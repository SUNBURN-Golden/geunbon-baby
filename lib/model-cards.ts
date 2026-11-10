import { displayableOfficialPrice, type Model } from './data';
import { priceGap, type Gap, type ModelDealSummary } from './deals';

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
  summaries: ReadonlyMap<string, ModelDealSummary>,
): ModelCardData[] {
  const cards = models.map((m): ModelCardData => {
    const summary = summaries.get(m.id);
    const deal = summary && summary.active_count > 0 ? { price: summary.lowest_price } : null;
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
