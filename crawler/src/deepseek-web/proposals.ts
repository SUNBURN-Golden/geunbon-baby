import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ruleDiagnostics } from '../agamajung/rules';
import type { GongguExtraction, ParserFixProposal } from './types';
export async function maybeProposeParserFix(dir: string, url: string, text: string, extraction: GongguExtraction): Promise<ParserFixProposal | null> {
  const candidates = ruleDiagnostics(text, 'deepseek-web:page').candidates;
  const hasRulePrice = candidates.some(c => ['clue_price', 'official_msrp'].includes(c.assertion.field));
  const modelPrice = extraction.gonggu_price !== '정보 없음' || extraction.regular_price !== '정보 없음';
  if (!modelPrice || hasRulePrice) return null;
  const proposal: ParserFixProposal = {
    kind: 'parser_fix_proposal',
    created_at: new Date().toISOString(),
    url,
    parser_ref: 'crawler/src/agamajung/rules.ts',
    symptom: '모델은 가격을 추출했으나 규칙 파서 후보에 가격 필드가 없음',
    evidence_quote: text.split(/\r?\n/).find(l => /\d[\d,]{3,}\s*원|₩|KRW|\$|€/i.test(l))?.slice(0, 300) ?? text.slice(0, 300),
    suggested_change: '가격 행 패턴을 규칙 extractRules에 추가하는 수정안을 검토 큐에 올린다. 런타임은 파서 파일을 수정하지 않는다.',
    self_edit: false,
  };
  await mkdir(join(dir, 'proposals'), { recursive: true });
  await writeFile(join(dir, 'proposals', `${randomUUID()}.json`), `${JSON.stringify(proposal, null, 2)}\n`);
  return proposal;
}
