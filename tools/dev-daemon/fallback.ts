import { isLimited, parseReset } from './limits';
import { modelCommand } from './runner';
import { inspectVerdict, normalizeAnswer, verdict } from './stages';
import { clarificationPrompt } from './prompts';
import type { AnswerSource, Choice, Decision, Execute, ModelsConfig, Result, ReviewInvocation, ReviewProgress } from './types';

const diagnosticLine = /^\s*(?:error\b|api error\b|http\b|429\b|you['’]ve hit your\b|(?:usage|rate)[- _]?limit|quota\b|(?:limit\s+)?resets?\b)/i;
export function providerDiagnostics(result: Result, prompt: string): string {
  const input = normalizeAnswer(prompt);
  const promptLines = new Set(input.split('\n').map(line => line.trim()).filter(Boolean));
  const withoutPrompt = (text: string) => (input ? normalizeAnswer(text).split(input).join('') : normalizeAnswer(text))
    .split('\n').filter(line => !promptLines.has(line.trim()));
  const errors = withoutPrompt(result.stdout ?? result.output).filter(line => diagnosticLine.test(line) && isLimited(line));
  return [...withoutPrompt(result.stderr ?? '').filter(line => diagnosticLine.test(line) ||
    /^\s*(?:account limited\b|your account (?:is |has been )?limited\b|(?:warning|warn):)/i.test(line)), ...errors].join('\n');
}

/** Review-only answer selection. Ordinary command results retain their streams. */
export function reviewAnswer(result: Result, prompt: string, isolated: boolean): { answer: string; source: AnswerSource; decision?: Decision } {
  if (isolated) return { answer: result.answer, source: 'final-answer-file', decision: verdict(result.answer) };
  const clean = (text: string) => {
    let answer = normalizeAnswer(text);
    if (prompt && answer.includes(normalizeAnswer(prompt))) {
      answer = answer.split(normalizeAnswer(prompt)).join('');
      answer = answer.replace(/^\s*(?:user|prompt:)\s*\n/i, '');
    }
    return answer.split('\n').filter(line => !(diagnosticLine.test(line) && isLimited(line)) &&
      !/^\s*(?:warning: rejected a tool call|\[claude-code:[^\]]+\])/.test(line)).join('\n');
  };
  if (result.stdout === undefined && result.stderr === undefined) {
    const answer = clean(result.answer);
    return { answer, source: 'stream-unknown', decision: verdict(answer) };
  }
  const stdout = clean(result.stdout ?? ''), stderr = clean(result.stderr ?? '');
  const a = inspectVerdict(stdout), b = inspectVerdict(stderr);
  const conflict = a.malformed || b.malformed || new Set([...a.decisions, ...b.decisions]).size > 1;
  // Unknown prompt/transcript framing requires clarification, never an approval.
  const uncertain = /^(?:(?:user|system|assistant)(?::.*)?|prompt:.*)\s*$/im.test(stdout + '\n' + stderr);
  const answer = [stdout, stderr].filter(text => text.trim()).join('\n');
  if (a.decision && !conflict && !uncertain) return { answer: stdout, source: 'stdout', decision: a.decision };
  return { answer, source: 'combined', decision: conflict || uncertain ? undefined : verdict(answer) };
}

export type FallbackResult = { kind: 'success'; answer: string; decision?: Decision; answerSource?: AnswerSource } |
  { kind: 'pause'; wakeAt: string; summary: string } | { kind: 'failed'; summary: string };
export async function fallback(options: {
  config: ModelsConfig; choices: Choice[]; prompt: string; cwd: string; readOnly: boolean;
  logPath: (choice: Choice, index: number, phase?: 'original' | 'clarification', cycle?: number) => string; execute: Execute;
  protectedRoots?: string[]; now?: () => number; unknownResetMs?: number;
  review?: { progress: ReviewProgress; save: () => Promise<void> };
}): Promise<FallbackResult> {
  const now = options.now ?? Date.now;
  const resets: number[] = [], failures: string[] = [];
  let allLimited = true;
  const progress = options.review?.progress;
  if (progress?.quotaPause) {
    if (Date.parse(progress.quotaPause.wakeAt) > now()) return { kind: 'pause', ...progress.quotaPause };
    progress.cycle++;
    delete progress.quotaPause;
    await options.review!.save();
  }
  for (const [index, choice] of options.choices.entries()) {
    const isolated = options.config.models[choice.model].provider === 'codex';
    let attempt = progress?.attempts.find(a => a.cycle === progress.cycle && a.modelIndex === index);
    if (progress && !attempt) {
      attempt = { cycle: progress.cycle, modelIndex: index, original: {
        status: 'issued', log: options.logPath(choice, index, 'original', progress.cycle) } };
      progress.attempts.push(attempt);
      await options.review!.save();
    } else if (attempt?.original.status === 'issued') {
      allLimited = false;
      attempt.original.outcome = 'interrupted original invocation';
      await options.review!.save();
      failures.push(`${choice.model}: interrupted original invocation`);
      continue;
    }
    const invoke = async (record: ReviewInvocation | undefined, prompt: string, phase: 'original' | 'clarification') => {
      if (record?.status === 'completed') return record.result!;
      const result = await options.execute(modelCommand(options.config, choice, prompt, options.cwd,
        record?.log ?? options.logPath(choice, index, phase, progress?.cycle), options.readOnly, options.protectedRoots));
      if (record) {
        record.status = 'completed';
        // Codex tool transcripts stay in process logs, not the durable review
        // checkpoint. Print-mode streams remain separate for conflict checks.
        const diagnostics = providerDiagnostics(result, prompt);
        record.result = isolated ? { code: result.code, answer: result.answer, output: '', stdout: '', stderr: diagnostics } :
          { code: result.code, answer: result.stdout === undefined && result.stderr === undefined ? result.answer : '',
            output: diagnostics, stdout: result.stdout, stderr: result.stderr };
        const selected = reviewAnswer(result, prompt, isolated);
        record.answerSource = selected.source;
        record.outcome = isLimited(providerDiagnostics(result, prompt)) ? 'restriction' :
          result.code !== 0 ? `exit ${result.code}` : selected.decision ?? 'missing/ambiguous VERDICT';
        await options.review!.save();
      }
      return result;
    };
    const result = await invoke(attempt?.original, options.prompt, 'original');
    // Preserve ordinary generation behavior; reviews check restrictions first.
    if (!options.review && result.code === 0 && result.answer.trim()) return { kind: 'success', answer: result.answer };
    const diagnostics = providerDiagnostics(result, options.prompt);
    const limited = isLimited(diagnostics);
    allLimited &&= limited; // Only ORIGINAL invocations determine all-quota pause.
    if (limited) {
      failures.push(`${choice.model}: quota/usage restriction`);
      const reset = parseReset(diagnostics, options.config.models[choice.model].provider, now());
      if (reset) resets.push(reset);
      continue;
    }
    if (result.code !== 0) { failures.push(`${choice.model}: exit ${result.code}`); continue; }
    if (!options.review) { failures.push(`${choice.model}: empty answer`); continue; }
    const original = reviewAnswer(result, options.prompt, isolated);
    if (original.decision) return { kind: 'success', answer: original.answer, decision: original.decision, answerSource: original.source };
    const prompt = clarificationPrompt(options.prompt, original.answer);
    if (!attempt!.clarification) {
      attempt!.clarification = { status: 'issued', log: options.logPath(choice, index, 'clarification', progress!.cycle) };
      await options.review.save();
    } else if (attempt!.clarification.status === 'issued') {
      attempt!.clarification.outcome = 'interrupted clarification (consumed)';
      await options.review.save();
      failures.push(`${choice.model}: interrupted clarification (consumed)`);
      continue;
    }
    const clarified = await invoke(attempt!.clarification, prompt, 'clarification');
    if (isLimited(providerDiagnostics(clarified, prompt))) { failures.push(`${choice.model}: malformed original VERDICT; restricted clarification`); continue; }
    if (clarified.code !== 0) { failures.push(`${choice.model}: malformed original VERDICT; clarification exit ${clarified.code}`); continue; }
    const selected = reviewAnswer(clarified, prompt, isolated);
    if (selected.decision === 'CHANGES') return { kind: 'failed', summary:
      `${choice.model}: incomplete review; clarification-only VERDICT: CHANGES. Inspect original response and clarification logs.` };
    if (selected.decision === 'APPROVE') return { kind: 'success', answer: original.answer,
      decision: selected.decision, answerSource: selected.source };
    failures.push(`${choice.model}: missing/ambiguous VERDICT after one clarification`);
  }
  const summary = failures.join('; ');
  if (allLimited && options.choices.length) {
    const pause = { summary, wakeAt: new Date(resets.length ? Math.min(...resets) :
      now() + (options.unknownResetMs ?? 15 * 60000)).toISOString() };
    if (progress) { progress.quotaPause = pause; await options.review!.save(); }
    return { kind: 'pause', ...pause };
  }
  return { kind: 'failed', summary: `All fallbacks exhausted: ${summary}` };
}
