import { describe, expect, it, vi } from 'vitest';
import config from '../tools/dev-daemon/models.json';
import { fallback } from '../tools/dev-daemon/fallback';
import { isLimited, parseReset } from '../tools/dev-daemon/limits';
import { modelCommand, redactor } from '../tools/dev-daemon/runner';
import { chains, verdict } from '../tools/dev-daemon/stages';
import type { ModelsConfig, Result } from '../tools/dev-daemon/types';

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
    expect(chains.design?.map(c => `${c.model}:${c.effort ?? ''}`)).toEqual(['fable:medium', 'astra6:high', 'glm:', 'swe2:']);
    expect(chains['design-review']?.map(c => c.model)).toEqual(['opus55', 'astra6', 'glm', 'swe2']);
    expect(chains.build?.map(c => c.model)).toEqual(['sol61', 'sonnet', 'glm', 'swe2']);
    expect(chains['build-review']?.map(c => c.model)).toEqual(['opus55', 'sol61', 'glm', 'swe2']);
    expect(chains['re-review']?.[0]).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(chains['design-revise']).toEqual(chains.design);
    expect(chains['review-fix']).toEqual(chains.build);
    expect(chains.audit).toEqual(chains.design);
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
  it('places Claude prompt before variadic flags and isolates the Fable profile', () => {
    const command = modelCommand(models, { model: 'opus55', effort: 'medium' }, 'review task', '/repo', '/log', true);
    expect(command.args.slice(0, 2)).toEqual(['-p', 'review task']);
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
