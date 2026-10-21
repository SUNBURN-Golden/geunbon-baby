import { isLimited, parseReset } from './limits';
import { modelCommand } from './runner';
import type { Choice, Execute, ModelsConfig } from './types';

export type FallbackResult = { kind: 'success'; answer: string } |
  { kind: 'pause'; wakeAt: string; summary: string } | { kind: 'failed'; summary: string };
export async function fallback(options: {
  config: ModelsConfig; choices: Choice[]; prompt: string; cwd: string; readOnly: boolean;
  logPath: (choice: Choice, index: number) => string; execute: Execute;
  protectedRoots?: string[]; now?: () => number; unknownResetMs?: number;
}): Promise<FallbackResult> {
  const now = options.now ?? Date.now;
  const resets: number[] = [];
  const failures: string[] = [];
  let allLimited = true;
  for (const [index, choice] of options.choices.entries()) {
    const result = await options.execute(modelCommand(options.config, choice, options.prompt, options.cwd,
      options.logPath(choice, index), options.readOnly, options.protectedRoots));
    const limited = isLimited(result.output) || isLimited(result.answer);
    if (!limited && result.code === 0 && result.answer.trim()) return { kind: 'success', answer: result.answer };
    allLimited &&= limited;
    failures.push(`${choice.model}: ${limited ? 'quota/usage restriction' : `exit ${result.code}${!result.answer.trim() ? ', empty answer' : ''}`}`);
    if (limited) {
      const reset = parseReset(result.output + '\n' + result.answer, options.config.models[choice.model].provider, now());
      if (reset) resets.push(reset);
    }
  }
  const summary = failures.join('; ');
  if (allLimited && options.choices.length) return { kind: 'pause', summary,
    wakeAt: new Date(resets.length ? Math.min(...resets) : now() + (options.unknownResetMs ?? 15 * 60000)).toISOString() };
  return { kind: 'failed', summary: `All fallbacks exhausted: ${summary}` };
}
