import type { DealBundleItem } from './data';

export async function bundleItemsForDeal(db: D1Database, dealId: string) {
  return (await db.prepare('SELECT id, deal_id, position, brand, product_name, model_id, price FROM deal_bundle_items WHERE deal_id = ? ORDER BY position')
    .bind(dealId).all<DealBundleItem>()).results;
}
