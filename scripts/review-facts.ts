/** Explicit manual-promotion mapping. Never parse period/notes or infer a year. */
import { isCheckedExtraction } from '../crawler/src/deepseek-web/extract';
import { publishDate } from '../crawler/lib/deal-fact-check';
import { UNKNOWN, type GongguExtraction } from '../crawler/src/deepseek-web/types';
import type { BundleItemInput } from '../lib/promote-external';
export function reviewPromotionFacts(extraction: GongguExtraction) {
  if (!isCheckedExtraction(extraction)) return { price: null, starts_at: null, ends_at: null };
  return { price: extraction.fact_check!.fields.gonggu_price.value,
    starts_at: publishDate(extraction.fact_check!.fields.start_date.value),
    ends_at: publishDate(extraction.fact_check!.fields.end_date.value, true) };
}
/** Bundle items are built only from durable checked rows; option text rides in product_name. */
export function reviewBundleItems(extraction: GongguExtraction): BundleItemInput[] {
  if (!isCheckedExtraction(extraction) || !extraction.bundle_items?.length) return [];
  return extraction.bundle_items.map(item => ({
    brand: item.brand,
    product_name: [item.product_name, item.option_text].filter(Boolean).join(' · ').slice(0, 200),
    model_id: item.model_match?.model_id ?? null,
    price: item.price_fact.value,
  }));
}
export function reviewBundleTitle(extraction: GongguExtraction): string | null {
  if (!isCheckedExtraction(extraction) || !extraction.bundle_items?.length) return null;
  return (extraction.bundle_title ?? `${extraction.brand} ${extraction.model}`).trim().slice(0, 200);
}
export function reviewBundleLabels(extraction: GongguExtraction) {
  if (!isCheckedExtraction(extraction) || !extraction.bundle_items?.length) return {};
  const brands = new Set(extraction.bundle_items.map(item => item.brand).filter((brand): brand is string => Boolean(brand)));
  return {
    ...(brands.size === 1 ? { brand_label: [...brands][0] } : {}),
    ...(extraction.category !== UNKNOWN ? { category_label: extraction.category } : {}),
  };
}
