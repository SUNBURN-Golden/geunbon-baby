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
export function verdict(answer: string): 'APPROVE' | 'CHANGES' | undefined {
  const matches = [...answer.matchAll(/^\s*VERDICT:\s*(APPROVE|CHANGES)\s*$/gm)];
  // Ambiguous reviews fail closed; prose mentioning APPROVE is not a verdict.
  if (!matches.length || new Set(matches.map(m => m[1])).size !== 1) return undefined;
  return matches[0][1] as 'APPROVE' | 'CHANGES';
}
