import { matchCatalogProduct, type CatalogMatch, type GeunbonCatalog } from './catalog';
import type { PreparedPage } from './page-content';
import type { DeepSeekWebConfig } from './types';
export const CANDIDATE_FILTER_VERSION = 1;
export type CandidateCode = 'candidate_pangpang_deal' | 'candidate_text_deal' | 'candidate_listing' | 'candidate_ambiguous_product' | 'candidate_excluded_category' | 'candidate_accessory' | 'candidate_no_catalog_match' | 'candidate_no_deal_evidence' | 'candidate_empty' | 'candidate_evidence_unavailable' | 'candidate_preparation_limit';
export type CandidateDecision = { accepted: boolean; code: CandidateCode; match: CatalogMatch | null };
const deal = /공구|공동\s*구매/;
const negative = /(?:공구|공동\s*구매)(?:가)?\s*(?:아님|아니|없음|없다)/;
export function candidateDecision(page: PreparedPage, catalog: GeunbonCatalog, config: DeepSeekWebConfig): CandidateDecision {
  const reject = (code: CandidateCode): CandidateDecision => ({ accepted: false, code, match: null });
  if (page.failure) return reject(page.failure);
  // Only product content can establish identity, never URL/seller/discovery hints.
  const identity = `${page.title}\n${page.category}\n${page.identity_description}`;
  if (/기저귀|분유|diapers?|infant\s*formula/i.test(identity)) return reject('candidate_excluded_category');
  if (/(?:쿠션|트레이|시트라이너|레인커버|컵홀더|어댑터|발판|커버|전용\s*가방)/i.test(page.title) && !/세트|번들|본품\s*포함/.test(page.title)) return reject('candidate_accessory');
  if (catalog.accessory_exclude_patterns.some(p => `${page.title}\n${page.category}`.includes(p))) return reject('candidate_accessory');
  const match = matchCatalogProduct({ title: page.title, category_text: page.category, text: page.identity_description }, catalog);
  if (!match) return reject('candidate_no_catalog_match');
  if (!config.scope_categories.some(c => c.id === match.category)) return reject('candidate_excluded_category');
  const dealLines = page.deal_text.split('\n');
  // Negative wording in the product/offer region invalidates both textual and
  // structure-only evidence; it must never reach the model.
  const denied = dealLines.some(line => negative.test(line));
  const textual = dealLines.some(line => deal.test(line) && !negative.test(line));
  if (page.pangpang && page.seller && page.schedule && !denied) return { accepted: true, code: 'candidate_pangpang_deal', match };
  if (textual || page.pangpang && page.description.split('\n').some(line => deal.test(line) && !negative.test(line))) return { accepted: true, code: 'candidate_text_deal', match };
  return reject('candidate_no_deal_evidence');
}
