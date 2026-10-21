import { isLimited, parseReset } from './limits';
import { modelCommand } from './runner';
import type { Choice, Execute, ModelsConfig, Result } from './types';

function providerDiagnostics(result: Result, prompt: string): string {
  const clean = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  const input = clean(prompt);
  const promptLines = new Set(input.split('\n').map(line => line.trim()).filter(Boolean));
  const withoutPrompt = (text: string) => (input ? clean(text).split(input).join('') : clean(text))
    .split('\n').filter(line => !promptLines.has(line.trim()));
  // Print-mode providers can report errors on stdout. Only recognize diagnostic
  // lines there; Codex also echoes the task and tool transcript on that stream.
  const errors = withoutPrompt(result.stdout ?? result.output).filter(line =>
    /^\s*(?:error\b|api error\b|http\b|429\b|you['’]ve hit your\b|(?:usage|rate)[- _]?limit|quota\b|(?:limit\s+)?resets?\b)/i.test(line) && isLimited(line));
  return [...withoutPrompt(result.stderr ?? ''), ...errors].join('\n');
}

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
    if (result.code === 0 && result.answer.trim()) return { kind: 'success', answer: result.answer };
    const diagnostics = providerDiagnostics(result, options.prompt);
    const limited = isLimited(diagnostics);
    allLimited &&= limited;
    failures.push(`${choice.model}: ${limited ? 'quota/usage restriction' : `exit ${result.code}${!result.answer.trim() ? ', empty answer' : ''}`}`);
    if (limited) {
      const reset = parseReset(diagnostics, options.config.models[choice.model].provider, now());
      if (reset) resets.push(reset);
    }
  }
  const summary = failures.join('; ');
  if (allLimited && options.choices.length) return { kind: 'pause', summary,
    wakeAt: new Date(resets.length ? Math.min(...resets) : now() + (options.unknownResetMs ?? 15 * 60000)).toISOString() };
  return { kind: 'failed', summary: `All fallbacks exhausted: ${summary}` };
}
