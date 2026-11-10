/**
 * Per-item bundle model matching. Pure: no fetch, model, persistence or publication.
 * Model matching happens exactly once, at the extraction-checking boundary; durable
 * validators only read the stored match.
 */
import { canonicalBrand, extractModels, modelCategory, modelRefiners } from '../../lib/extract';
import type { ItemModelMatch, RawBundleItem } from './types';

export type ItemMatch = {
  brand: string | null;
  model_match: ItemModelMatch | null;
  model_status: 'matched' | 'ambiguous' | 'no_match';
};

export function matchItemModel(item: RawBundleItem): ItemMatch {
  const canonical = item.source_brand === null ? undefined : canonicalBrand(item.source_brand);
  // An explicitly named brand we do not know must not be silently replaced by a
  // model guess from the product-name text.
  if (item.source_brand !== null && canonical === null) {
    return { brand: null, model_match: null, model_status: 'no_match' };
  }
  const text = [item.source_brand, item.product_name, item.option_text].filter(Boolean).join(' ');
  let suggestions = extractModels(text).filter(s => s.confidence >= 0.90);
  if (canonical) suggestions = suggestions.filter(s => s.brand === canonical);
  if (item.category) suggestions = suggestions.filter(s => modelCategory(s.model_id) === item.category);
  // When any candidate has every declared refiner present, drop the variants that
  // are missing one (STYLE/CLASSIC when the page says LUX).
  const complete = suggestions.filter(s => modelRefiners(s.model_id).every(r => s.matched.includes(r)));
  if (complete.length) suggestions = complete;
  suggestions.sort((a, b) => b.confidence - a.confidence || b.matched.length - a.matched.length || a.model_id.localeCompare(b.model_id));
  if (!suggestions.length) return { brand: canonical ?? null, model_match: null, model_status: 'no_match' };
  const top = suggestions[0];
  const tied = suggestions.filter(s => s.confidence === top.confidence && s.matched.length === top.matched.length);
  if (tied.length > 1) return { brand: canonical ?? null, model_match: null, model_status: 'ambiguous' };
  const model_match: ItemModelMatch = {
    model_id: top.model_id,
    brand: top.brand,
    confidence: top.confidence,
    matched: top.matched.slice(0, 8).join(', ').slice(0, 120),
  };
  return { brand: model_match.brand, model_match, model_status: 'matched' };
}
