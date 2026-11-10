/** Explicit manual-promotion mapping. Never parse period/notes or infer a year. */
import { isCheckedExtraction } from '../crawler/src/deepseek-web/extract';
import { publishDate } from '../crawler/lib/deal-fact-check';
import type { GongguExtraction } from '../crawler/src/deepseek-web/types';
export function reviewPromotionFacts(extraction: GongguExtraction) {
  if (!isCheckedExtraction(extraction)) return { price: null, starts_at: null, ends_at: null };
  return { price: extraction.fact_check!.fields.gonggu_price.value,
    starts_at: publishDate(extraction.fact_check!.fields.start_date.value),
    ends_at: publishDate(extraction.fact_check!.fields.end_date.value, true) };
}
