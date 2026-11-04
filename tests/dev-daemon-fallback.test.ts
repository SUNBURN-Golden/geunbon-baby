import { readFile } from 'node:fs/promises';
import manifest from './fixtures/dev-daemon/reviews/manifest.json';
import { describe, expect, it, vi } from 'vitest';
import config from '../tools/dev-daemon/models.json';
import { fallback } from '../tools/dev-daemon/fallback';
import { isLimited, parseReset } from '../tools/dev-daemon/limits';
import { modelCommand, redactor } from '../tools/dev-daemon/runner';
import { chains, readOnly, verdict } from '../tools/dev-daemon/stages';
import type { Choice, ModelsConfig, Result, ReviewProgress } from '../tools/dev-daemon/types';

const models = config as ModelsConfig;
const now = Date.parse('2026-10-21T00:00:00Z');
const result = (output: string, code = 0): Result => ({ code, output, answer: output });
const diagnostic = (output: string, code = 1): Result => ({ code, output, answer: '', stdout: output, stderr: '' });
function run(results: Result[], prompt = 'task') {
  const execute = vi.fn(async () => results.shift()!);
  return { execute, promise: fallback({ config: models, choices: chains.design!, prompt, cwd: '/repo',
    readOnly: true, logPath: (_, index) => `/logs/${index}.log`, execute, now: () => now }) };
}

describe('daemon fallback', () => {
  it('uses the exact requested chains and effort levels', () => {
    const design = [{ model: 'opus55', effort: 'medium' }, { model: 'astra6', effort: 'high' }, { model: 'glm' }, { model: 'swe2' }];
    const build = [{ model: 'sol61', effort: 'high' }, { model: 'sonnet', effort: 'high' }, { model: 'glm' }, { model: 'swe2' }];
    expect(chains).toEqual({
      design,
      'design-review': [{ model: 'astra6', effort: 'high' }, { model: 'opus55', effort: 'medium' }, { model: 'glm' }, { model: 'swe2' }],
      'design-revise': design,
      build,
      'build-review': [{ model: 'glm' }, { model: 'sonnet', effort: 'medium' }, { model: 'sol61', effort: 'high' }, { model: 'swe2' }],
      'review-fix': build,
      're-review': [{ model: 'glm' }, { model: 'sol61', effort: 'high' }, { model: 'sonnet', effort: 'medium' }, { model: 'swe2' }],
      audit: [{ model: 'fable', effort: 'medium' }, { model: 'astra6', effort: 'high' }, { model: 'glm' }, { model: 'swe2' }],
    });
    expect(chains['design-revise']).toBe(chains.design);
    expect(chains['review-fix']).toBe(chains.build);
    expect(chains.audit).not.toBe(chains.design);
  });
  it('falls back on nonzero exit and zero-exit quota output, stopping at success', async () => {
    const { promise, execute } = run([result('CLI failed', 1), diagnostic('quota exceeded', 0), result('completed')]);
    expect(await promise).toEqual({ kind: 'success', answer: 'completed' });
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('tries the next model after an empty response', async () => {
    const { promise } = run([result(''), result('completed')]);
    expect((await promise).kind).toBe('success');
  });
  it('pauses only when every fallback was restricted, at the earliest reset', async () => {
    const { promise } = run([diagnostic('Usage limit; resets 12pm (Asia/Seoul)'), diagnostic('429 retry after 7200'),
      diagnostic('Quota exceeded; resets at 2026-10-21 09:00'), diagnostic('limit resets in 4 hours')]);
    expect(await promise).toMatchObject({ kind: 'pause', wakeAt: '2026-10-21T01:00:00.000Z' });
  });
  it('uses a bounded retry delay when no reset was printed', async () => {
    expect(await run(Array.from({ length: 4 }, () => diagnostic('quota'))).promise)
      .toMatchObject({ kind: 'pause', wakeAt: '2026-10-21T00:15:00.000Z' });
  });
  it('fails exhausted ordinary or mixed failures instead of pretending all were restricted', async () => {
    expect(await run([diagnostic('quota'), result('bad config', 1), diagnostic('429'), diagnostic('quota')]).promise)
      .toMatchObject({ kind: 'failed' });
  });
  it('accepts a successful final answer despite limit words in the prompt, transcript, answer and stderr', async () => {
    const prompt = 'Fix quota handling, HTTP 429, usage limit and resets detection.';
    const answer = "You've hit your quota is now handled. VERDICT: APPROVE";
    const { promise, execute } = run([{ code: 0, output: `${prompt}\n${answer}`, answer,
      stdout: `user\n${prompt}`, stderr: 'Usage limit warning' }], prompt);
    expect(await promise).toEqual({ kind: 'success', answer });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1])('excludes echoed diagnostic-like prompt lines with exit %s and no final answer', async code => {
    const prompt = "Quota exceeded\nYou've hit your usage limit\n429 retry after 60\nresets in 1 hour";
    const echoed = `user\n${prompt}\n`;
    expect(await run(Array.from({ length: 4 }, () => ({ code, output: echoed, answer: '',
      stdout: echoed, stderr: `prompt: ${prompt}\n` })), prompt).promise).toMatchObject({ kind: 'failed' });
  });
  it.each(["You've hit your cap", 'HTTP 429 Too Many Requests', 'API Error: usage_limit_reached',
    'Quota exceeded', 'resets in 1 hour'])('recognizes stdout diagnostics without a final answer: %s', async output => {
    expect(await run(Array.from({ length: 4 }, () => diagnostic(output, 0))).promise).toMatchObject({ kind: 'pause' });
  });
  it('uses stderr diagnostics on a failed run even when a partial answer exists', async () => {
    expect(await run(Array.from({ length: 4 }, () => ({ code: 1, output: 'partial answer\naccount limited',
      answer: 'partial answer', stdout: 'partial answer', stderr: 'account limited' }))).promise)
      .toMatchObject({ kind: 'pause' });
  });
  it('does not scan ordinary transcript text or a failed final answer for limits', async () => {
    expect(await run(Array.from({ length: 4 }, () => ({ code: 1,
      output: 'Implement a usage limit\n--- final answer ---\nQuota exceeded',
      stdout: 'Implement a usage limit\nThe test resets a counter\nlimit', stderr: '', answer: 'Quota exceeded' }))).promise)
      .toMatchObject({ kind: 'failed' });
  });
  it('parses reset times only from diagnostics, excluding echoed task dates', async () => {
    const prompt = 'resets at 2026-10-21T00:01:00Z';
    expect(await run(Array.from({ length: 4 }, () => ({ code: 1, output: `${prompt}\nquota resets in 2 hours`,
      answer: '', stdout: `user\n${prompt}\nTask resets at 2026-10-21T00:02:00Z`, stderr: 'quota resets in 2 hours' })), prompt).promise)
      .toMatchObject({ kind: 'pause', wakeAt: '2026-10-21T02:00:00.000Z' });
  });
});

describe('reset parsing', () => {
  it.each(['usage-limit', 'rate_limit_error', 'usage_limit_reached', 'Quota exceeded', 'HTTP 429', 'limit', 'resets 3pm', '\x1b[31mLimited\x1b[0m'])('recognizes %s', text => expect(isLimited(text)).toBe(true));
  it('does not classify unrelated text as a restriction', () => expect(isLimited('completed successfully')).toBe(false));
  it.each([
    ['resets at 2026-10-21 12:30', 'glm', '2026-10-21T04:30:00.000Z'],
    ['resets at 2026-10-21 12:30', 'claude', '2026-10-21T03:30:00.000Z'],
    ['resets at 2026-10-21T12:30:00+08:00', 'codex', '2026-10-21T04:30:00.000Z'],
    ['resets Oct 22, 3pm (Asia/Seoul)', 'claude', '2026-10-22T06:00:00.000Z'],
    ['resets 1am (Asia/Seoul)', 'claude', '2026-10-21T16:00:00.000Z'],
    ['resets tomorrow 10:00', 'glm', '2026-10-22T02:00:00.000Z'],
    ['retry after 60', 'codex', '2026-10-21T00:01:00.000Z'],
    ['limit resets in 2h 30m', 'glm', '2026-10-21T02:30:00.000Z'],
    ['resets at 1792544400', 'codex', '2026-10-21T01:00:00.000Z'],
  ] as const)('parses %s (%s)', (text, provider, expected) => {
    expect(new Date(parseReset(text, provider, now)!).toISOString()).toBe(expected);
  });
  it('ignores past dated resets and unrelated task dates', () => {
    expect(parseReset('quota\nTask created 2027-01-01T00:00:00Z\nresets 2026-10-20T00:00:00Z', 'glm', now)).toBeUndefined();
  });
});

describe('runner contracts', () => {
  it.each([
    ['build', false],
    ['build-review', true],
    ['review-fix', false],
    ['re-review', true],
  ] as const)('passes the configured Sol high effort and permissions for %s', (stage, expectedReadOnly) => {
    const choice = chains[stage]?.find(c => c.model === 'sol61');
    expect(choice).toEqual({ model: 'sol61', effort: 'high' });
    expect(readOnly(stage)).toBe(expectedReadOnly);
    const command = modelCommand(models, choice!, 'task', '/repo', '/log', readOnly(stage));
    expect(command.bin).toBe('codex');
    expect(command.args.slice(0, 5)).toEqual(['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high']);
    if (expectedReadOnly) {
      expect(command.args.slice(5, 9)).toEqual(['-s', 'read-only', '-c', 'approval_policy="never"']);
      expect(command.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    } else {
      expect(command.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(command.args).not.toContain('-s');
    }
  });
  it('uses Claude stdin and isolates the Fable profile', () => {
    const command = modelCommand(models, { model: 'opus55', effort: 'medium' }, 'review task', '/repo', '/log', true);
    expect(command.args[0]).toBe('-p');
    expect(command.input).toEqual({ text: 'review task', transport: 'stdin' });
    expect(command.args).not.toContain('review task');
    expect(command.args.slice(-4)).toEqual(['--allowedTools', 'Read', 'Grep', 'Glob']);
    expect(command.args).toContain('dontAsk');
    expect(command.env?.CLAUDE_CONFIG_DIR).toBe('/home/box/.claude-fable');
  });
  it('removes CLAUDE_CONFIG_DIR for GLM and bypasses permissions for builds', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/wrong');
    const command = modelCommand(models, { model: 'glm' }, 'build', '/repo', '/log', false);
    expect(command.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(command.args).not.toContain('--model');
    expect(command.args).toContain('--dangerously-skip-permissions');
  });
  it('uses Codex sandbox for reviews, bypass for builds, and a separate final-answer file', () => {
    const review = modelCommand(models, { model: 'astra6', effort: 'high' }, 'review', '/repo', '/log', true);
    expect(review.args).toContain('model_reasoning_effort=high');
    expect(review.args).toContain('read-only');
    expect(review.answerFile).toBe('/log.answer');
    expect(modelCommand(models, { model: 'sol61', effort: 'high' }, 'build', '/repo', '/log', false).args)
      .toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('uses Devin print mode, skips workspace trust, and enforces read-only mounts', () => {
    const command = modelCommand(models, { model: 'swe2' }, 'review', '/repo', '/log', true, ['/shared/.git', '/queue']);
    expect(command.bin).toBe('bwrap');
    expect(command.args).toEqual(expect.arrayContaining(['--ro-bind', '/repo', '/shared/.git', '/queue', '--respect-workspace-trust', 'false', 'swe-2', '-p']));
  });
  it.each([256, 400])('keeps a %s KiB prompt out of argv and environment for every provider', size => {
    const prompt = 'diff --git a/code.ts b/code.ts\n' + 'x'.repeat(size * 1024);
    for (const model of ['fable', 'glm', 'sol61', 'swe2'] as const) {
      const command = modelCommand(models, { model }, prompt, '/repo', '/log', true);
      expect(command.input).toEqual({ text: prompt, transport: model === 'swe2' ? 'file' : 'stdin' });
      expect(JSON.stringify(command.args)).not.toContain(prompt);
      expect(Object.values(command.env ?? {})).not.toContain(prompt);
      expect(Math.max(...command.args.map(arg => Buffer.byteLength(arg)))).toBeLessThan(1024);
      if (model === 'sol61') expect(command.args.at(-1)).toBe('-');
    }
  });
  it('provides the complete large prompt again to every fallback after input failures', async () => {
    const prompt = '한글\n"quoted" '.repeat(40000);
    const { promise, execute } = run([result('Runner prompt delivery failed', 1), result('quota', 1), result('failed', 1), result('complete')], prompt);
    expect(await promise).toEqual({ kind: 'success', answer: 'complete' });
    expect(execute).toHaveBeenCalledTimes(4);
    for (const [command] of execute.mock.calls as unknown as [import('../tools/dev-daemon/types').Command][]) {
      expect(command.input?.text).toBe(prompt);
      expect(command.args).not.toContain(prompt);
    }
  });
  it('accepts only an unambiguous standalone verdict', () => {
    expect(verdict('Looks good\nVERDICT: APPROVE')).toBe('APPROVE');
    expect(verdict('VERDICT: CHANGES\nVERDICT: APPROVE')).toBeUndefined();
    expect(verdict('I would APPROVE')).toBeUndefined();
  });
  it('redacts credentials before recording outputs', () => {
    const scrub = redactor({ API_KEY: 'test-supersecret-value' });
    expect(scrub('test-supersecret-value Bearer abc123 password=hunter2 https://name:pass@example.com'))
      .toBe('[REDACTED] [REDACTED AUTH] password=[REDACTED] https://[REDACTED]@example.com');
  });
});

// Synthetic formatting cases are deliberately separate from the real log fixtures.
describe('precise review verdict grammar (synthetic)', () => {
  it.each(['VERDICT: APPROVE', 'VERDICT: **APPROVE**', 'VERDICT: *CHANGES*', 'VERDICT: `APPROVE`',
    'Findings\r\n\x1b[32mVERDICT: APPROVE\x1b[0m\r\n', 'VERDICT: APPROVE\nVERDICT: APPROVE'])('accepts %j', answer => {
    expect(verdict(answer)).toBe(answer.includes('CHANGES') ? 'CHANGES' : 'APPROVE');
  });
  it.each(['**VERDICT: APPROVE**', '*VERDICT: CHANGES*', '`VERDICT: APPROVE`',
    '```\nVERDICT: APPROVE\n```', '~~~text\nVERDICT: APPROVE\n~~~', '> VERDICT: APPROVE', '    VERDICT: APPROVE',
    '\tVERDICT: APPROVE', 'VERDICT: APPROVE or CHANGES', 'VERDICT: APPROVE (looks fine)', 'prose VERDICT: APPROVE',
    'VERDICT: APPROVE\nMore commentary', 'VERDICT: CHANGES\nVERDICT: APPROVE', 'verdict: APPROVE',
    'VERDICT: approve', 'VERDICT: **APPROVE*\nVERDICT: APPROVE', '**VERDICT: CHANGES**\nVERDICT: APPROVE',
    'VERDICT: MAYBE\nVERDICT: APPROVE', '** VERDICT: CHANGES **\nVERDICT: APPROVE', '` VERDICT: CHANGES `\nVERDICT: APPROVE', '', 'I will inspect the code.'])('rejects %j', answer => {
    expect(verdict(answer)).toBeUndefined();
  });
  it('does not treat quoted or fenced examples as conflicting decisions', () => {
    expect(verdict('> VERDICT: CHANGES\n~~~\nVERDICT: CHANGES\n~~~\nCompleted inspection.\nVERDICT: APPROVE')).toBe('APPROVE');
  });
});

async function reviewRun(results: Result[], progress: ReviewProgress = { key: 'context', cycle: 0, attempts: [] },
  choices: Choice[] = chains['build-review']!, onSave?: () => Promise<void>, clockNow = now) {
  const commands: import('../tools/dev-daemon/types').Command[] = [];
  const execute = vi.fn(async (command: import('../tools/dev-daemon/types').Command) => {
    commands.push(command);
    const next = results.shift();
    if (!next) throw new Error('Unexpected model call: fixture exhausted');
    return next;
  });
  const outcome = await fallback({ config: models, choices, prompt: 'Original task and complete diff context', cwd: '/repo', readOnly: true,
    execute, now: () => clockNow, protectedRoots: ['/repo', '/git', '/queue'],
    review: { progress, save: onSave ?? (async () => {}) },
    logPath: (choice, index, phase, cycle) => `/logs/${index}-${choice.model}-${phase}-${cycle}.log` });
  return { outcome, commands, execute, progress };
}

describe('saved real reviews (historical stream provenance retained)', () => {
  it.each(manifest)('extracts $file from $answerBoundary ($streamProvenance)', async entry => {
    const data = JSON.parse(await readFile(new URL(`./fixtures/dev-daemon/reviews/${entry.file}`, import.meta.url), 'utf8'));
    expect(verdict(data.answer)).toBe(entry.expected ?? undefined);
    if (entry.file.includes('empty-quota')) {
      const { outcome, commands } = await reviewRun([{ code: 0, output: data.diagnostics, answer: data.answer,
        stdout: data.diagnostics, stderr: '' }], undefined, [{ model: 'astra6', effort: 'high' }]);
      expect(outcome.kind).toBe('pause');
      expect(commands).toHaveLength(1);
    } else if (entry.expected) {
      const model = entry.provider === 'codex' ? 'astra6' : 'swe2';
      const { outcome } = await reviewRun([result(data.answer)], undefined, [{ model }]);
      expect(outcome).toMatchObject({ kind: 'success', decision: entry.expected,
        answerSource: entry.provider === 'codex' ? 'final-answer-file' : 'stream-unknown' });
    }
  });
});

describe('bounded review-aware fallback', () => {
  it('clarifies once with the same model, effort, full context and read-only protections, then follows the exact chain', async () => {
    const { outcome, commands, progress } = await reviewRun([
      result('Inspecting now'), result('Still inspecting'), result('Narration'), result('unclear'),
      result('Incomplete'), result('no decision'), result('Ready.\nVERDICT: **APPROVE**'),
    ]);
    expect(outcome).toMatchObject({ kind: 'success', decision: 'APPROVE', answer: 'Ready.\nVERDICT: **APPROVE**' });
    expect(commands).toHaveLength(7);
    for (const index of [0, 2, 4]) {
      expect(commands[index + 1].bin).toBe(commands[index].bin);
      expect(commands[index + 1].args).toEqual(commands[index].args.map(arg =>
        arg === commands[index].answerFile ? commands[index + 1].answerFile! : arg));
      expect(commands[index + 1].input?.text).toContain('Original task and complete diff context');
      expect(commands[index + 1].input?.text).toContain('<original_review_json>');
      expect(commands[index + 1].input?.text).toContain('Incomplete inspection');
      expect(commands[index + 1].log).not.toBe(commands[index].log);
    }
    expect(commands[0].args).toContain('Read');
    expect(commands[2].args).toContain('medium');
    expect(commands[4].args).toContain('model_reasoning_effort=high');
    expect(commands[6].args).toContain('--ro-bind');
    expect(progress.attempts.map(a => a.modelIndex)).toEqual([0, 1, 2, 3]);
  });
  it('returns an original valid CHANGES immediately without asking another model or clarification', async () => {
    const { outcome, commands } = await reviewRun([result('Blocking defect.\nVERDICT: CHANGES')]);
    expect(outcome).toMatchObject({ kind: 'success', decision: 'CHANGES' });
    expect(commands).toHaveLength(1);
  });
  it('accepts clarification approval separately and retains the original response', async () => {
    const { outcome, progress } = await reviewRun([result('I inspected the patch.'), result('VERDICT: APPROVE')]);
    expect(outcome).toMatchObject({ kind: 'success', answer: 'I inspected the patch.', decision: 'APPROVE' });
    expect(progress.attempts[0].clarification?.result?.answer).toBe('VERDICT: APPROVE');
    expect(progress.attempts[0].clarification?.outcome).toBe('APPROVE');
  });
  it('terminates on clarification-only CHANGES without requesting another reviewer', async () => {
    const { outcome, commands } = await reviewRun([result('I will inspect now'), result('VERDICT: CHANGES')]);
    expect(outcome).toMatchObject({ kind: 'failed', summary: expect.stringContaining('incomplete review') });
    expect(commands).toHaveLength(2);
  });
  it('checks zero-exit restrictions before partial or even valid verdicts, skipping clarification', async () => {
    for (const answer of ['Reviewing', 'VERDICT: APPROVE']) {
      const { outcome, commands } = await reviewRun([{ code: 0, answer, output: answer, stdout: answer,
        stderr: 'Usage limit; resets in 1 hour' }, result('VERDICT: CHANGES')]);
      expect(outcome).toMatchObject({ kind: 'success', decision: 'CHANGES' });
      expect(commands).toHaveLength(2);
      expect(commands.every(c => !c.log.includes('clarification'))).toBe(true);
    }
  });
  it('fails a mixed chain when an unrestricted malformed original has a restricted clarification', async () => {
    const { outcome, commands } = await reviewRun([result('Inspecting'), diagnostic('quota', 0),
      diagnostic('quota'), diagnostic('quota'), diagnostic('quota')]);
    expect(outcome.kind).toBe('failed');
    expect(commands.filter(c => c.log.includes('clarification'))).toHaveLength(1);
  });
  it('pauses only all-original-restricted chains and begins a new cycle after the pause', async () => {
    const progress: ReviewProgress = { key: 'context', cycle: 0, attempts: [] };
    const first = await reviewRun(Array.from({ length: 4 }, () => diagnostic('quota resets in 1 hour', 0)), progress);
    expect(first.outcome).toMatchObject({ kind: 'pause', wakeAt: '2026-10-21T01:00:00.000Z' });
    expect(progress.attempts.every(a => !a.clarification)).toBe(true);
    const beforeWake = await reviewRun([], structuredClone(progress));
    expect(beforeWake.outcome).toEqual(first.outcome);
    expect(beforeWake.commands).toHaveLength(0);
    const second = await reviewRun([result('VERDICT: APPROVE')], progress, undefined, undefined, now + 3600001);
    expect(second.outcome.kind).toBe('success');
    expect(progress.cycle).toBe(1);
    expect(second.commands[0].log).toContain('-original-1.log');
  });
  it.each(['original-issued', 'original-completed', 'clarification-issued', 'clarification-completed'] as const)(
    'resumes %s without repeating an issued invocation', async point => {
      let durable: ReviewProgress = { key: 'context', cycle: 0, attempts: [] };
      const progress = structuredClone(durable);
      let interrupted = false;
      const results = [result('Inspection narration'), result('VERDICT: APPROVE')];
      const save = async () => {
        durable = structuredClone(progress);
        const first = progress.attempts[0];
        const reached = point === 'original-issued' ? first?.original.status === 'issued' :
          point === 'original-completed' ? first?.original.status === 'completed' && !first.clarification :
          point === 'clarification-issued' ? first?.clarification?.status === 'issued' : first?.clarification?.status === 'completed';
        if (reached && !interrupted) { interrupted = true; throw new Error('Daemon stopping'); }
      };
      await expect(reviewRun(results, progress, undefined, save)).rejects.toThrow('Daemon stopping');
      const restarted = await reviewRun(point === 'original-completed' ? [result('VERDICT: APPROVE')] :
        point === 'clarification-completed' ? [] : [result('VERDICT: CHANGES')], durable);
      expect(restarted.commands).toHaveLength(point === 'clarification-completed' ? 0 : 1);
      if (point.endsWith('issued')) expect(restarted.commands[0].log).toContain('/1-sonnet-original');
      if (point === 'original-completed') expect(restarted.commands[0].log).toContain('/0-glm-clarification');
    });
  it('does not reset exhausted ambiguity or the clarification budget on restart', async () => {
    const progress: ReviewProgress = { key: 'context', cycle: 0, attempts: [] };
    expect((await reviewRun(Array.from({ length: 8 }, () => result('Progress only')), progress)).outcome.kind).toBe('failed');
    const again = await reviewRun([], structuredClone(progress));
    expect(again.commands).toHaveLength(0);
    expect(again.outcome.kind).toBe('failed');
  });
});

describe('clarification preserves conflicting answer evidence', () => {
  it('includes both conflicting answer streams in the same-reviewer clarification', async () => {
    const { outcome, commands } = await reviewRun([
      { code: 0, output: '', answer: '', stdout: 'VERDICT: APPROVE', stderr: 'Blocking data loss.\nVERDICT: CHANGES' },
      result('VERDICT: CHANGES'),
    ]);
    expect(outcome).toMatchObject({ kind: 'failed', summary: expect.stringContaining('incomplete review') });
    expect(commands[1].input?.text).toContain('Blocking data loss.');
    expect(commands[1].input?.text).toContain('VERDICT: APPROVE\\nBlocking data loss.\\nVERDICT: CHANGES');
  });
});

describe('durable quota wakeup', () => {
  it('reuses a pause checkpoint even when shutdown preceded the stage wakeAt checkpoint', async () => {
    const progress: ReviewProgress = { key: 'context', cycle: 0, attempts: [] };
    let durable = structuredClone(progress);
    await expect(reviewRun(Array.from({ length: 4 }, () => diagnostic('quota resets in 1 hour', 0)), progress, undefined, async () => {
      durable = structuredClone(progress);
      if (progress.quotaPause) throw new Error('Daemon stopping');
    })).rejects.toThrow('Daemon stopping');
    const restarted = await reviewRun([], durable);
    expect(restarted.outcome).toMatchObject({ kind: 'pause', wakeAt: '2026-10-21T01:00:00.000Z' });
    expect(restarted.commands).toHaveLength(0);
  });
});

describe('restriction classification survives compact Codex checkpoints', () => {
  it('retains stderr-only quota diagnostics when restoring a code-zero partial approval', async () => {
    const progress: ReviewProgress = { key: 'context', cycle: 0, attempts: [] };
    let durable = structuredClone(progress);
    const choices: Choice[] = [{ model: 'astra6', effort: 'high' }];
    await expect(reviewRun([{ code: 0, answer: 'VERDICT: APPROVE', output: '',
      stdout: 'Tool transcript', stderr: 'account limited' }], progress, choices, async () => {
      durable = structuredClone(progress);
      if (progress.attempts[0]?.original.status === 'completed') throw new Error('Daemon stopping');
    })).rejects.toThrow('Daemon stopping');
    const restarted = await reviewRun([], durable, choices);
    expect(restarted.outcome.kind).toBe('pause');
    expect(restarted.commands).toHaveLength(0);
  });
});
