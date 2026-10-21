import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLogin, HaltError } from '../crawler/lib/browser';
import settingsJson from '../crawler/config/settings.json';
import { parseSettings } from '../crawler/lib/config';
import { flushHealth, initHealth } from '../crawler/lib/health';
import { QuietWindowError } from '../crawler/lib/quiet-window';
import { SessionError } from '../crawler/lib/session';
import { loginFixture, loginSettings, sessionState } from './helpers/login';
import { mockLocator } from './helpers/page';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crawler-login-'));
  file = join(dir, '.session', 'state.json');
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'login-test-password');
  vi.stubEnv('INGEST_TOKEN', 'login-test-token');
  await initHealth(dir);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T11:30:00Z'));
});
afterEach(async () => {
  vi.useRealTimers();
  await flushHealth();
  await rm(dir, { recursive: true, force: true });
});
async function events() {
  await flushHealth();
  const name = (await readdir(join(dir, 'logs'))).find(name => name.startsWith('health-'));
  const log = name ? await readFile(join(dir, 'logs', name), 'utf8') : '';
  for (const secret of ['login-test-password', 'login-test-token', 'offline-user', 'offline-cookie-only', 'offline-storage-only']) expect(log).not.toContain(secret);
  return log.trim() ? log.trim().split('\n').map(line => JSON.parse(line).event) : [];
}
function start(mock: ReturnType<typeof loginFixture>, check?: () => void) {
  return ensureLogin(mock.context, mock.page, loginSettings(), 'offline-user', file, check);
}

test.each(['en', 'ko'] as const)('delayed login handles %s prompts before navigation verification, save and success', async language => {
  const mock = loginFixture({ language, fullPage: language === 'ko', submitDelay: 1500 });
  const running = start(mock);
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.submit).toHaveBeenCalledTimes(1);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual(['login_attempt']);
  await vi.runAllTimersAsync();
  await running;
  expect(mock.dismiss).toHaveBeenCalledTimes(2);
  expect(mock.decoy).not.toHaveBeenCalled();
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(sessionState());
  expect(await events()).toEqual(['login_attempt', 'login_ok']);
});

test('a restored authenticated session works without a password or credential submission', async () => {
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', '');
  const mock = loginFixture({ restored: true });
  const running = start(mock);
  await vi.runAllTimersAsync();
  await running;
  expect(mock.fill).not.toHaveBeenCalled();
  expect(mock.submit).not.toHaveBeenCalled();
  expect(mock.decoy).not.toHaveBeenCalled();
  expect(await events()).toEqual(['session_reused']);
});

test.each([0, 0.5, 1])('healthy login and home verification use separate budgets with production jitter=%s', async random => {
  vi.spyOn(Math, 'random').mockReturnValue(random);
  const settings = parseSettings(settingsJson);
  const mock = loginFixture({ submitDelay: 35_000 });
  let submittedAt = 0;
  const submit = mock.submit.getMockImplementation()!;
  mock.submit.mockImplementation(() => { submittedAt = Date.now(); submit(); });
  const outcome = ensureLogin(mock.context, mock.page, settings, 'offline-user', file).then(() => undefined, error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toBeUndefined();
  expect(mock.submit).toHaveBeenCalledOnce();
  expect(mock.dismiss).toHaveBeenCalledTimes(2);
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(mock.storageState).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(sessionState());
  expect(await events()).toEqual(['login_attempt', 'login_ok']);
  if (random === 1) expect(Date.now() - submittedAt).toBeGreaterThan(120_000);
});

test('home verification still times out within its own bounded budget', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const settings = parseSettings(settingsJson);
  const mock = loginFixture({ restored: true });
  const goto = mock.goto.getMockImplementation()!;
  mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    if (mock.goto.mock.calls.length === 2) mock.setStage('unknown');
  });
  const startedAt = Date.now();
  const rejected = expect(ensureLogin(mock.context, mock.page, settings, 'offline-user', file)).rejects.toMatchObject({ reason: 'login' });
  await vi.runAllTimersAsync();
  await rejected;
  expect(Date.now() - startedAt).toBe(settings.delays_ms.navigation[1] + 120_000);
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual([]);
});

test.each(['cookie', 'ui'] as const)('authentication waits for the delayed %s signal', async signal => {
  const mock = loginFixture({ restored: true });
  if (signal === 'cookie') mock.setCookies([]);
  else mock.setStage('unknown');
  const running = start(mock);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual([]);
  mock.setCookies(sessionState().cookies);
  mock.setStage('home');
  await vi.runAllTimersAsync();
  await running;
  expect(await events()).toEqual(['session_reused']);
});

test.each(['challenge', 'blocked'] as const)('%s after submission halts with no save or success', async afterSubmit => {
  const mock = loginFixture({ afterSubmit });
  await mkdir(join(dir, '.session'));
  const previous = JSON.stringify(sessionState());
  await writeFile(file, previous);
  const rejected = expect(start(mock)).rejects.toMatchObject({ reason: afterSubmit });
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(mock.dismiss).not.toHaveBeenCalled();
  expect(await readFile(file, 'utf8')).toBe(previous);
  expect(await events()).toEqual(['login_attempt']);
});

test.each(['challenge', 'blocked'] as const)('%s before submission halts before any interaction', async stage => {
  const mock = loginFixture();
  mock.setStage(stage);
  const rejected = expect(start(mock)).rejects.toMatchObject({ reason: stage });
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.fill).not.toHaveBeenCalled();
  expect(mock.submit).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual([]);
});

test.each(['form', 'unknown', 'stuck-prompt', 'stale-cookie', 'expired-cookie', 'missing-cookie', 'bounce-home'] as const)('%s cannot produce premature success', async scenario => {
  const mock = loginFixture({ restored: ['expired-cookie', 'missing-cookie', 'unknown', 'bounce-home'].includes(scenario),
    afterSubmit: scenario === 'form' || scenario === 'stale-cookie' ? 'login' : undefined,
    stuckPrompt: scenario === 'stuck-prompt', staleCookie: scenario === 'stale-cookie', bounceHome: scenario === 'bounce-home' });
  if (scenario === 'unknown') mock.setStage('unknown');
  if (scenario === 'expired-cookie') mock.setCookies(sessionState().cookies.map(cookie => ({ ...cookie, expires: 1 })));
  if (scenario === 'missing-cookie') mock.setCookies([]);
  const rejected = expect(start(mock)).rejects.toBeInstanceOf(HaltError);
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.submit.mock.calls.length).toBeLessThanOrEqual(1);
  expect(mock.dismiss.mock.calls.length).toBeLessThanOrEqual(1);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).not.toContain('login_ok');
  expect(await events()).not.toContain('session_reused');
});

test('missing credentials fail safely', async () => {
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', '');
  const mock = loginFixture();
  const rejected = expect(start(mock)).rejects.toThrow('크롤러 로그인 실패');
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.submit).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test('Playwright credential errors never expose fill values', async () => {
  const mock = loginFixture();
  mock.fill.mockImplementation(() => { throw new Error('login-test-password login-test-token offline-user'); });
  const failed = start(mock).catch(error => error as Error);
  await vi.runAllTimersAsync();
  const error = await failed;
  expect(String(error)).toContain('크롤러 로그인 실패');
  for (const secret of ['login-test-password', 'login-test-token', 'offline-user']) expect(String(error)).not.toContain(secret);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual(['login_attempt']);
});

test('persistence failure cannot log success', async () => {
  const mock = loginFixture({ restored: true });
  await writeFile(join(dir, 'not-directory'), 'fixture');
  file = join(dir, 'not-directory', 'state.json');
  const failed = start(mock).catch(error => error as Error);
  await vi.runAllTimersAsync();
  expect(String(await failed)).toContain('세션');
  expect(await events()).toEqual([]);
});

test.each(['cookies', 'storageState'] as const)('session failure during %s survives an overlapping quiet window', async operation => {
  const mock = loginFixture({ restored: true });
  await mkdir(join(dir, '.session'));
  const previous = JSON.stringify(sessionState());
  await writeFile(file, previous);
  let quiet = false;
  vi.mocked(mock.context[operation]).mockImplementation(async () => {
    quiet = true;
    throw new Error('login-test-password offline-cookie-only');
  });
  const check = () => { if (quiet) throw new QuietWindowError(); };
  const outcome = start(mock, check).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toBeInstanceOf(SessionError);
  expect(await readFile(file, 'utf8')).toBe(previous);
  expect(await events()).toEqual([]);
});

test.each(['navigation', 'settling', 'prompt', 'cookies'] as const)('quiet-window interruption during %s stops login and persistence', async phase => {
  const mock = loginFixture({ restored: phase === 'cookies', submitDelay: 3000 });
  let quiet = false;
  if (phase === 'prompt') mock.setStage('save');
  if (phase === 'cookies') vi.mocked(mock.context.cookies).mockImplementation(async () => { quiet = true; return sessionState().cookies; });
  const check = () => { if (quiet) throw new QuietWindowError(); };
  const rejected = expect(start(mock, check)).rejects.toBeInstanceOf(QuietWindowError);
  if (phase === 'navigation') quiet = true;
  else if (phase !== 'cookies') {
    await vi.advanceTimersByTimeAsync(6);
    quiet = true;
  }
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(mock.dismiss.mock.calls.length).toBeLessThanOrEqual(phase === 'prompt' ? 1 : 0);
  expect(await events()).not.toContain('login_ok');
});

test('a dismissed prompt that reappears halts without clicking it twice', async () => {
  const mock = loginFixture();
  mock.setStage('save');
  mock.dismiss.mockImplementationOnce(() => {
    mock.setStage('unknown');
    setTimeout(() => mock.setStage('save'), 1500);
  });
  const rejected = expect(start(mock)).rejects.toBeInstanceOf(HaltError);
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.dismiss).toHaveBeenCalledOnce();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test.each(['checkpoint', 'two_factor', 'captcha', 'security-code'] as const)('%s halts before credential or prompt interaction', async marker => {
  const mock = loginFixture();
  const locator = mock.page.locator.bind(mock.page);
  if (marker === 'checkpoint' || marker === 'two_factor') {
    mock.goto.mockImplementation(async () => mock.setUrl(marker === 'checkpoint' ? 'https://www.instagram.com/checkpoint/' : 'https://www.instagram.com/accounts/login/two_factor/'));
  } else if (marker === 'captcha') {
    mock.page.getByText = vi.fn(pattern => mockLocator(() => (pattern as RegExp).test('CAPTCHA') ? [{ text: 'CAPTCHA' }] : []));
  } else {
    mock.page.locator = vi.fn(selector => selector.includes('input[name="verificationCode"]')
      ? locator('input[name="username"]') : locator(selector));
  }
  const rejected = expect(start(mock)).rejects.toMatchObject({ reason: 'challenge' });
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.fill).not.toHaveBeenCalled();
  expect(mock.dismiss).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test('an unknown dialog cannot authenticate using cookies and navigation behind it', async () => {
  const mock = loginFixture({ restored: true });
  const getByRole = mock.page.getByRole.bind(mock.page);
  mock.page.getByRole = vi.fn((role, options) => role === 'dialog'
    ? mockLocator(() => [{ text: 'Unknown interstitial' }]) : getByRole(role, options));
  const rejected = expect(start(mock)).rejects.toBeInstanceOf(HaltError);
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.dismiss).not.toHaveBeenCalled();
  expect(mock.decoy).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual([]);
});

test('a challenge appearing during session capture preserves the old session without success', async () => {
  const mock = loginFixture({ restored: true });
  await mkdir(join(dir, '.session'));
  const previous = JSON.stringify(sessionState());
  await writeFile(file, previous);
  mock.storageState.mockImplementation(async () => {
    mock.setStage('challenge');
    const next = sessionState();
    next.cookies[0].value = 'offline-new-cookie';
    return next;
  });
  const rejected = expect(start(mock)).rejects.toMatchObject({ reason: 'challenge' });
  await vi.runAllTimersAsync();
  await rejected;
  expect(await readFile(file, 'utf8')).toBe(previous);
  expect(await readdir(join(dir, '.session'))).toEqual(['state.json']);
  expect(await events()).toEqual([]);
});
