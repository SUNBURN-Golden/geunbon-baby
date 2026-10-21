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
  return log.trim() ? log.trim().split('\n').map(line => JSON.parse(line).event).filter(event => !['login_state', 'login_recovery'].includes(event)) : [];
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
  expect(mock.goto).toHaveBeenCalledTimes(3); // 35 seconds of blank settling permits one recovery GET.
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
  expect(mock.goto).toHaveBeenCalledTimes(scenario === 'bounce-home' ? 2 : 1);
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

async function loginRecords() {
  await flushHealth();
  const names = (await readdir(join(dir, 'logs'))).filter(name => name.startsWith('health-'));
  const records = (await Promise.all(names.map(name => readFile(join(dir, 'logs', name), 'utf8')))).join('');
  return records.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test.each(['codeentry', 'email-ko', 'email-en'] as const)('%s halts immediately before any credential or prompt interaction', async stage => {
  const mock = loginFixture();
  if (stage === 'codeentry') mock.goto.mockImplementation(async () => mock.setUrl('https://www.instagram.com/auth_platform/codeentry/?opaque=offline-private'));
  else mock.setStage(stage);
  const began = Date.now();
  const outcome = start(mock).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'challenge' });
  expect(Date.now() - began).toBe(0);
  expect(mock.goto.mock.calls.length).toBeLessThanOrEqual(1);
  expect(mock.fill).not.toHaveBeenCalled();
  expect(mock.submit).not.toHaveBeenCalled();
  expect(mock.dismiss).not.toHaveBeenCalled();
  expect(mock.decoy).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).toEqual([]);
});

test.each(['entry', 'submitted', 'home'] as const)('a transient blank %s surface settles without another submission', async phase => {
  const mock = loginFixture({ restored: phase !== 'submitted', prompts: false, afterSubmit: 'blank' });
  if (phase === 'entry') {
    mock.setStage('blank');
    setTimeout(() => mock.setStage('home'), 2500);
  } else if (phase === 'submitted') setTimeout(() => mock.setStage('home'), 2500);
  else {
    const goto = mock.goto.getMockImplementation()!;
    mock.goto.mockImplementation(async (...args) => {
      await goto(...args);
      if (mock.goto.mock.calls.length === 2) {
        mock.setStage('blank');
        setTimeout(() => mock.setStage('home'), 2500);
      }
    });
  }
  const running = start(mock);
  await vi.runAllTimersAsync();
  await running;
  expect(mock.submit.mock.calls.length).toBe(phase === 'submitted' ? 1 : 0);
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(mock.storageState).toHaveBeenCalledOnce();
  expect((await loginRecords()).some(row => row.event === 'login_state' && row.phase === phase && row.state === 'blank-loading')).toBe(true);
});

test.each(['entry', 'submitted', 'home'] as const)('persistent blank %s gets one GET within its original deadline and preserves the session', async phase => {
  const mock = loginFixture({ restored: phase !== 'submitted', afterSubmit: 'blank', prompts: false });
  await mkdir(join(dir, '.session'));
  const previous = JSON.stringify(sessionState());
  await writeFile(file, previous);
  if (phase === 'entry') mock.setStage('blank');
  if (phase === 'home') {
    const goto = mock.goto.getMockImplementation()!;
    mock.goto.mockImplementation(async (...args) => {
      await goto(...args);
      if (mock.goto.mock.calls.length >= 2) mock.setStage('blank');
    });
  }
  const began = Date.now();
  const outcome = start(mock).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'login' });
  expect(Date.now() - began).toBe(120_000 + (phase === 'entry' ? 0 : 5));
  expect(mock.goto).toHaveBeenCalledTimes(phase === 'home' ? 3 : 2);
  expect(mock.submit.mock.calls.length).toBe(phase === 'submitted' ? 1 : 0);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await readFile(file, 'utf8')).toBe(previous);
  const recovery = (await loginRecords()).filter(row => row.event === 'login_recovery');
  expect(recovery).toHaveLength(1);
  if (phase === 'entry') expect((await loginRecords()).filter(row => row.event === 'login_state')).toHaveLength(1);
  expect(recovery[0]).toMatchObject({ phase, state: 'blank-loading', recoveries: 1 });
  expect(recovery[0].elapsed_ms).toBeGreaterThanOrEqual(30_000);
  expect(await events()).not.toContain('login_ok');
});

test.each(['before', 'during'] as const)('challenge %s blank recovery prevents any further GET or session save', async timing => {
  const mock = loginFixture({ restored: true });
  mock.setStage('blank');
  let changed = false;
  const began = Date.now();
  const goto = mock.goto.getMockImplementation()!;
  if (timing === 'during') mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    if (mock.goto.mock.calls.length === 2) mock.setStage('email-ko');
  });
  const outcome = start(mock, () => {
    if (timing === 'before' && Date.now() - began >= 30_000 && !changed) {
      changed = true;
      mock.setStage('email-en');
    }
  }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'challenge' });
  expect(mock.goto).toHaveBeenCalledTimes(timing === 'before' ? 1 : 2);
  expect(mock.submit).not.toHaveBeenCalled();
  expect(mock.dismiss).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test('a challenge during production login jitter interrupts within one polling interval', async () => {
  const mock = loginFixture({ afterSubmit: 'email-ko', submitDelay: 2200 });
  const settings = parseSettings(settingsJson);
  vi.spyOn(Math, 'random').mockReturnValue(1);
  let submittedAt = 0;
  const submit = mock.submit.getMockImplementation()!;
  mock.submit.mockImplementation(() => { submittedAt = Date.now(); submit(); });
  const outcome = ensureLogin(mock.context, mock.page, settings, 'offline-user', file).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'challenge' });
  expect(Date.now() - submittedAt).toBeLessThanOrEqual(3200);
  expect(mock.goto).toHaveBeenCalledOnce();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test.each(['recover', 'timeout', 'challenge', 'login', 'unknown'] as const)('a %s surface during session capture discards the temporary state and keeps the old session until verified', async scenario => {
  const mock = loginFixture({ restored: true });
  await mkdir(join(dir, '.session'));
  const previous = JSON.stringify(sessionState());
  await writeFile(file, previous);
  mock.storageState.mockImplementationOnce(async () => {
    mock.setStage(scenario === 'challenge' ? 'email-en' : scenario === 'login' ? 'login' : scenario === 'unknown' ? 'unknown' : 'blank');
    if (scenario === 'recover') mock.surface.mockImplementationOnce(() => {
      setTimeout(() => mock.setStage('home'), 2500);
      return true;
    });
    return { ...sessionState(), cookies: sessionState().cookies.map(cookie => ({ ...cookie, value: 'discarded-snapshot' })) };
  });
  const began = Date.now();
  let completed = false;
  const outcome = start(mock).catch(error => error).finally(() => { completed = true; });
  // Retry timers are installed after real session-file I/O completes.
  for (let attempts = 0; !completed && attempts < 100; attempts++) {
    await vi.runAllTimersAsync();
    await readFile(file, 'utf8');
  }
  expect(completed).toBe(true);
  if (scenario === 'recover') {
    expect(await outcome).toBeUndefined();
    expect(mock.storageState).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(sessionState());
    expect(await events()).toEqual(['session_reused']);
  } else {
    expect(await outcome).toMatchObject({ reason: scenario === 'challenge' ? 'challenge' : 'login' });
    expect(await readFile(file, 'utf8')).toBe(previous);
    expect(mock.storageState).toHaveBeenCalledOnce();
    expect(await events()).toEqual([]);
    if (scenario === 'timeout') expect(Date.now() - began).toBe(120_005);
  }
  expect(await readdir(join(dir, '.session'))).toEqual(['state.json']);
});

test.each(['quiet', 'stop'] as const)('%s interrupts blank waiting before the recovery GET', async interruption => {
  const mock = loginFixture({ restored: true });
  mock.setStage('blank');
  let interrupted = false;
  const stop = new Error('offline stop request');
  const outcome = start(mock, () => { if (interrupted) throw interruption === 'quiet' ? new QuietWindowError() : stop; }).catch(error => error);
  await vi.advanceTimersByTimeAsync(29_500);
  interrupted = true;
  await vi.runAllTimersAsync();
  if (interruption === 'quiet') expect(await outcome).toBeInstanceOf(QuietWindowError);
  else expect(await outcome).toBe(stop);
  expect(mock.goto).toHaveBeenCalledOnce();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test('the last deadline check reports a security screen instead of a login timeout', async () => {
  const mock = loginFixture({ restored: true });
  mock.setStage('unknown');
  setTimeout(() => mock.setStage('email-ko'), 120_000);
  const outcome = start(mock).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'challenge' });
  expect(mock.goto).toHaveBeenCalledOnce();
});

test('each phase can recover once, with a single credential submission for the entire run', async () => {
  const mock = loginFixture({ afterSubmit: 'blank', prompts: false });
  mock.setStage('blank');
  const goto = mock.goto.getMockImplementation()!;
  mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    const count = mock.goto.mock.calls.length;
    if (count === 2) mock.setStage('login'); // Entry recovery reveals the login form.
    if (count === 3 || count === 5) mock.setStage('home');
    if (count === 4) mock.setStage('blank'); // Independent home verification budget.
  });
  const running = start(mock);
  await vi.runAllTimersAsync();
  await running;
  expect(mock.goto).toHaveBeenCalledTimes(5);
  expect(mock.submit).toHaveBeenCalledOnce();
  expect(mock.storageState).toHaveBeenCalledOnce();
  const recoveries = (await loginRecords()).filter(row => row.event === 'login_recovery');
  expect(recoveries.map(row => [row.phase, row.recoveries])).toEqual([['entry', 1], ['submitted', 1], ['home', 1]]);
  expect(await events()).toEqual(['login_attempt', 'login_ok']);
});

test('an intervening unknown page resets the continuous blank interval', async () => {
  const mock = loginFixture({ restored: true });
  mock.setStage('blank');
  setTimeout(() => mock.setStage('unknown'), 20_000);
  setTimeout(() => mock.setStage('blank'), 25_000);
  const goto = mock.goto.getMockImplementation()!;
  mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    if (mock.goto.mock.calls.length === 2) mock.setStage('home');
  });
  const running = start(mock);
  await vi.runAllTimersAsync();
  await running;
  const [recovery] = (await loginRecords()).filter(row => row.event === 'login_recovery');
  expect(recovery.elapsed_ms).toBeGreaterThanOrEqual(55_000);
  expect(mock.goto).toHaveBeenCalledTimes(3);
});

test('failed DOM observations time out as unknown without recovery or secret exposure', async () => {
  const mock = loginFixture({ restored: true });
  mock.setStage('blank');
  mock.surface.mockImplementation(() => { throw new Error('login-test-password login-test-token offline-user'); });
  const outcome = start(mock).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'login' });
  expect(mock.goto).toHaveBeenCalledOnce();
  expect(mock.storageState).not.toHaveBeenCalled();
  expect((await loginRecords()).filter(row => row.event === 'login_recovery')).toEqual([]);
  expect(String(await outcome)).not.toContain('login-test-password');
  expect(await events()).toEqual([]);
});

test.each(['cookies', 'dismiss', 'home-navigation'] as const)('a challenge at %s takes priority over login progress', async operation => {
  const mock = loginFixture({ restored: operation !== 'dismiss' });
  if (operation === 'cookies') vi.mocked(mock.context.cookies).mockImplementation(async () => {
    mock.setStage('email-ko');
    return sessionState().cookies;
  });
  if (operation === 'dismiss') mock.dismiss.mockImplementationOnce(() => { mock.setStage('email-ko'); });
  if (operation === 'home-navigation') {
    const goto = mock.goto.getMockImplementation()!;
    mock.goto.mockImplementation(async (...args) => {
      await goto(...args);
      if (mock.goto.mock.calls.length === 2) mock.setStage('email-en');
    });
  }
  const outcome = start(mock).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'challenge' });
  expect(mock.goto).toHaveBeenCalledTimes(operation === 'home-navigation' ? 2 : 1);
  expect(mock.dismiss.mock.calls.length).toBe(operation === 'dismiss' ? 1 : 0);
  expect(mock.storageState).not.toHaveBeenCalled();
  expect(await events()).not.toContain('login_ok');
  expect(await events()).not.toContain('session_reused');
});

test('navigation timeout can settle into authentication without another GET', async () => {
  const mock = loginFixture({ restored: true });
  mock.goto.mockImplementationOnce(async () => {
    mock.setStage('blank');
    setTimeout(() => mock.setStage('home'), 2500);
    const timeout = new Error('offline private navigation details');
    timeout.name = 'TimeoutError';
    throw timeout;
  });
  const running = start(mock);
  await vi.runAllTimersAsync();
  await running;
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(await events()).toEqual(['session_reused']);
});

test.each(['entry', 'submitted', 'home'] as const)('blank %s recovery waits for navigation pacing before credentials or authentication reads', async phase => {
  const mock = loginFixture({ restored: phase === 'home', afterSubmit: phase === 'submitted' ? 'blank' : 'home', prompts: false });
  const settings = loginSettings();
  settings.delays_ms.navigation = [15_000, 15_000];
  if (phase === 'entry') mock.setStage('blank');
  let recoveredAt = 0;
  let fills = 0;
  let cookieReads = 0;
  const goto = mock.goto.getMockImplementation()!;
  mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    const count = mock.goto.mock.calls.length;
    if (phase === 'home' && count === 2) mock.setStage('blank');
    if (count === (phase === 'home' ? 3 : 2)) {
      recoveredAt = Date.now();
      fills = mock.fill.mock.calls.length;
      cookieReads = vi.mocked(mock.context.cookies).mock.calls.length;
      mock.setStage(phase === 'entry' ? 'login' : 'home');
    }
  });
  const running = ensureLogin(mock.context, mock.page, settings, 'offline-user', file);
  for (let elapsed = 0; !recoveredAt && elapsed < 60_000; elapsed += 1000) await vi.advanceTimersByTimeAsync(1000);
  expect(recoveredAt).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(recoveredAt + 14_999 - Date.now());
  expect(mock.fill).toHaveBeenCalledTimes(fills);
  expect(mock.context.cookies).toHaveBeenCalledTimes(cookieReads);
  expect(mock.storageState).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  await running;
  expect(mock.submit).toHaveBeenCalledTimes(phase === 'home' ? 0 : 1);
  expect(mock.storageState).toHaveBeenCalledOnce();
});

test.each(['challenge', 'quiet', 'stop'] as const)('%s interrupts the navigation delay after a recovery GET', async interruption => {
  const mock = loginFixture();
  mock.setStage('blank');
  const settings = loginSettings();
  settings.delays_ms.navigation = [15_000, 15_000];
  let recoveredAt = 0;
  let interrupted = false;
  const stop = new Error('offline stop request');
  const goto = mock.goto.getMockImplementation()!;
  mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    if (mock.goto.mock.calls.length === 2) {
      recoveredAt = Date.now();
      mock.setStage('login');
      setTimeout(() => {
        if (interruption === 'challenge') mock.setStage('email-ko');
        else interrupted = true;
      }, 2000);
    }
  });
  const outcome = ensureLogin(mock.context, mock.page, settings, 'offline-user', file, () => {
    if (interrupted) throw interruption === 'quiet' ? new QuietWindowError() : stop;
  }).catch(error => error);
  await vi.runAllTimersAsync();
  if (interruption === 'challenge') expect(await outcome).toMatchObject({ reason: 'challenge' });
  else if (interruption === 'quiet') expect(await outcome).toBeInstanceOf(QuietWindowError);
  else expect(await outcome).toBe(stop);
  expect(Date.now() - recoveredAt).toBeLessThanOrEqual(3000);
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(mock.fill).not.toHaveBeenCalled();
  expect(mock.submit).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
});

test('recovery navigation pacing is capped by the remaining phase deadline', async () => {
  const mock = loginFixture();
  mock.setStage('unknown');
  setTimeout(() => mock.setStage('blank'), 80_000);
  const settings = loginSettings();
  settings.delays_ms.navigation = [15_000, 15_000];
  const goto = mock.goto.getMockImplementation()!;
  mock.goto.mockImplementation(async (...args) => {
    await goto(...args);
    if (mock.goto.mock.calls.length === 2) {
      mock.setStage('login');
    }
  });
  const began = Date.now();
  const outcome = ensureLogin(mock.context, mock.page, settings, 'offline-user', file).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'login' });
  expect(Date.now() - began).toBe(120_000);
  expect(mock.goto).toHaveBeenCalledTimes(2);
  expect(mock.fill).not.toHaveBeenCalled();
  expect(mock.storageState).not.toHaveBeenCalled();
});
