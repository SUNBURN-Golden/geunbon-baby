import { isCheckedExtraction } from './extract';
import { atomicState, readState } from './atomic-state';
import { sha256 } from './page-content';
import { join } from 'node:path';
import { ruleDiagnostics } from '../agamajung/rules';
import type { GongguExtraction, ParserFixProposal } from './types';
export const PROPOSAL_VERSION = 2;
export function buildParserProposal(url: string, text: string, extraction: GongguExtraction, at: string): ParserFixProposal | null {
  if (!isCheckedExtraction(extraction)) return null;
  const candidates = ruleDiagnostics(text, 'deepseek-web:page').candidates;
  const hasRulePrice = candidates.some(c => ['clue_price', 'official_msrp'].includes(c.assertion.field));
  const modelPrice = extraction.gonggu_price !== null || extraction.regular_price !== null;
  if (!modelPrice || hasRulePrice) return null;
  const proposal: ParserFixProposal = {
    kind: 'parser_fix_proposal',
    created_at: at,
    url,
    parser_ref: 'crawler/src/agamajung/rules.ts',
    symptom: '모델은 가격을 추출했으나 규칙 파서 후보에 가격 필드가 없음',
    evidence_quote: (extraction.fact_check!.fields.gonggu_price.evidence ?? extraction.fact_check!.fields.regular_price.evidence)!.quote,
    suggested_change: '가격 행 패턴을 규칙 extractRules에 추가하는 수정안을 검토 큐에 올린다. 런타임은 파서 파일을 수정하지 않는다.',
    self_edit: false,
  };
  return proposal;
}
export function deliverProposal(dir: string, cacheKey: string, proposal: ParserFixProposal | null) {
  if (!proposal) return false;
  const path = join(dir, 'proposals', `${sha256(`${cacheKey}:proposal@${PROPOSAL_VERSION}`)}.json`);
  try {
    const prior = JSON.parse(readState(path));
    if (JSON.stringify({ ...prior, created_at: proposal.created_at }) !== JSON.stringify(proposal)) throw new Error('proposal_state_unavailable');
    return false;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('proposal_state_unavailable'); }
  try { atomicState(path, proposal); } catch { throw new Error('proposal_state_unavailable'); }
  return true;
}
export async function maybeProposeParserFix(dir: string, url: string, text: string, extraction: GongguExtraction) {
  const proposal = buildParserProposal(url, text, extraction, new Date().toISOString());
  return deliverProposal(dir, sha256(url + text), proposal) ? proposal : null;
}
