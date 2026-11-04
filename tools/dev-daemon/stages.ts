import type { Choice, Stage } from './types';

const design: Choice[] = [{ model: 'opus55', effort: 'medium' }, { model: 'astra6', effort: 'high' }, { model: 'glm' }, { model: 'swe2' }];
const build: Choice[] = [{ model: 'sol61', effort: 'high' }, { model: 'sonnet', effort: 'high' }, { model: 'glm' }, { model: 'swe2' }];
export const chains: Partial<Record<Stage, Choice[]>> = {
  design,
  'design-review': [{ model: 'astra6', effort: 'high' }, { model: 'opus55', effort: 'medium' }, { model: 'glm' }, { model: 'swe2' }],
  'design-revise': design,
  build,
  'build-review': [{ model: 'glm' }, { model: 'sonnet', effort: 'medium' }, { model: 'sol61', effort: 'high' }, { model: 'swe2' }],
  'review-fix': build,
  're-review': [{ model: 'glm' }, { model: 'sol61', effort: 'high' }, { model: 'sonnet', effort: 'medium' }, { model: 'swe2' }],
  audit: [{ model: 'fable', effort: 'medium' }, { model: 'astra6', effort: 'high' }, { model: 'glm' }, { model: 'swe2' }],
};
export const readOnly = (stage: Stage) => !['build', 'review-fix'].includes(stage);
export const isReview = (stage: Stage) => ['design-review', 'build-review', 're-review'].includes(stage);
export const normalizeAnswer = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, '').replace(/\r\n/g, '\n');
export interface VerdictInspection {
  decision?: 'APPROVE' | 'CHANGES';
  decisions: ('APPROVE' | 'CHANGES')[];
  malformed: boolean;
}
export function inspectVerdict(answer: string): VerdictInspection {
  const decisions: ('APPROVE' | 'CHANGES')[] = [];
  let malformed = false, lastDecision = -1, lastAnswer = -1;
  let fence: { char: string; length: number } | undefined;
  for (const [index, line] of normalizeAnswer(answer).split('\n').entries()) {
    if (line.trim()) lastAnswer = index;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
    if (/^(?: {4}| *\t| {0,3}>)/.test(line)) continue;
    // Token-only Markdown is supported. Whole-line wrapping and malformed
    // declarations poison the answer, even if followed by a valid approval.
    const match = /^ {0,3}VERDICT: *(?:(APPROVE|CHANGES)|\*\*(APPROVE|CHANGES)\*\*|\*(APPROVE|CHANGES)\*|`(APPROVE|CHANGES)`) *$/.exec(line);
    if (match) {
      decisions.push(match.slice(1).find(Boolean) as 'APPROVE' | 'CHANGES');
      lastDecision = index;
    } else if (/^ {0,3}(?:[*_`]+[ \t]*)?VERDICT\b/.test(line)) malformed = true;
  }
  return { decisions, malformed, decision: !malformed && decisions.length && lastDecision === lastAnswer &&
    new Set(decisions).size === 1 ? decisions[0] : undefined };
}
export function verdict(answer: string): 'APPROVE' | 'CHANGES' | undefined {
  return inspectVerdict(answer).decision;
}
