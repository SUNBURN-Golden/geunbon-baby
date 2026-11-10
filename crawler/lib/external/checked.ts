/** Checked derivatives of original product regions; never re-parse synthesized payloads. */
import { canonicalUrl, filterText } from '../../../shared/privacy-rules';
import { checkDealFacts, dateTimestamp, publishDate, validFactCheck, type FactCheck, type FactCandidates } from '../deal-fact-check';
import { extractPrices, type DateSuggestion } from '../extract';
export function sanitizedRegion(text: string, max = 20000) {
  return text.normalize('NFKC').split(/[\r\n]+/).map(l => filterText(l, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, max);
}
export function checkExternalRegion(text: string, source: string, now: Date, candidates?: FactCandidates, scopeTitle?: string): FactCheck {
  const clean = sanitizedRegion(text);
  const price = extractPrices(clean).primary;
  // Offer the primary amount for both roles: label-aware matching verifies a
  // regular price independently while keeping a sale amount out of that fact.
  const raw = price?.raw ?? null;
  return checkDealFacts(candidates ?? { gonggu_price: raw, regular_price: raw, period: clean }, clean, canonicalUrl(source), now.toISOString(), clean.length < text.length && text.length > 20000, scopeTitle);
}
function resolved(checks: FactCheck[]) {
  if (checks.length > 4 || checks.some(c => !validFactCheck(c))) throw new Error('extraction_result_invalid');
  const single = (key: 'gonggu_price' | 'regular_price') => {
    const facts = checks.map(c => c.fields[key]).filter(f => f.value !== null);
    return new Set(facts.map(f => f.value)).size === 1 ? facts[0] : null;
  };
  const price = single('gonggu_price'), regular = single('regular_price');
  let start = checks.map(c => c.fields.start_date).find(f => f.value !== null) ?? null;
  let end = checks.map(c => c.fields.end_date).find(f => f.value !== null) ?? null;
  const a = start?.value, b = end?.value;
  if (a && b) {
    const from = dateTimestamp(a), to = dateTimestamp(b);
    if (from !== null && to !== null && to < from || a.year === null && b.year === null && a.month === b.month && b.day < a.day) { start = null; end = null; }
  }
  return { price, regular, start, end };
}
export function externalValues(checks: FactCheck[]) {
  const {price,start,end} = resolved(checks);
  const dateEvidence = [...new Set([start,end].flatMap(f => f?.evidence ? [f.evidence.quote] : []))].join(' / ').slice(0, 200);
  return { price: price?.value !== null && price?.value !== undefined ? { value: price.value, raw: price.evidence!.quote } : null,
    dates: start || end ? { starts_at: publishDate(start?.value ?? null), ends_at: publishDate(end?.value ?? null, true), raw: dateEvidence, confidence: 1 } satisfies DateSuggestion : null };
}
/** Local assertions use only checked values and the matching original evidence. */
export function checkedExternalAssertions(checks: FactCheck[], locator: string): import('../../../shared/collection-schema').AssertionInput[] {
  const {price,regular,start,end} = resolved(checks);
  const assertions: import('../../../shared/collection-schema').AssertionInput[] = [];
  // A verified regular price stays a price clue (never official MSRP); prefer
  // the group-buy amount when both are verified.
  const clue = price ?? regular;
  if (clue?.value !== null && clue?.value !== undefined) assertions.push({ field: 'clue_price', value: clue.value, quote: clue.evidence!.quote, locator: `${locator}:price:${clue.evidence!.start}-${clue.evidence!.end}`, msrp_explicit: false });
  for (const [key,fact] of [['start_date',start],['end_date',end]] as const) {
    if (!fact?.value) continue;
    const timestamp = publishDate(fact.value, key === 'end_date');
    assertions.push({ field: 'group_buy_terms', value: { terms: fact.evidence!.quote, ...(timestamp ? { date: timestamp } : {}) }, quote: fact.evidence!.quote, locator: `${locator}:${key}:${fact.evidence!.start}-${fact.evidence!.end}`, conditions: timestamp ? { [key === 'start_date' ? 'effective_at' : 'effective_until']: timestamp } : {} });
  }
  // Each endpoint keeps its own source identity/precision in checks, including end-only offers.
  return assertions;
}
