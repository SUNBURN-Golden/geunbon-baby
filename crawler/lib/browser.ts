// 브라우저 실행·로그인·이상 상태 감지. 챌린지/차단/로그인 이탈은 HaltError 로 즉시 중단하며
// 실제 빈 로딩 화면에만 제한된 GET 복구를 허용한다. 비밀번호는 환경변수에서만 읽고 로그에 남기지 않는다.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jitter, sleep } from './util';
import { authenticatedNavigation, blankLoginSurface, emailCodeChallenge, firstVisible, hasText, loginInputs, loginPrompt } from './selectors';
import type { Settings } from './config';
import { health } from './health';
import { hasSessionCookie, loadSession, saveSession, SessionError } from './session';
import { QuietWindowError } from './quiet-window';

export class HaltError extends Error {
  constructor(public reason: 'challenge' | 'blocked' | 'login') { super(`halt:${reason}`); }
}
// 챌린지 화면/차단 안내를 감지한다. 차단 문구는 UI 변화를 감안해 넉넉한 후보로 걸러둔다.
export async function assertHuman(page: Page, { allowLogin = false } = {}) {
  const url = page.url();
  if (/\/auth_platform\/codeentry(?:\/|\?|$)|\/(challenge|checkpoint)(?:\/|\?|$)|\/accounts\/(?:login\/two_factor|two_factor)/i.test(url) || await emailCodeChallenge(page) || await hasText(page, /Enter (the )?security code|two.factor authentication|security check|CAPTCHA|보안 (?:코드|확인)|인증 코드|본인 확인|로봇이 아닙니다/i) ||
    await firstVisible([page.locator('input[name="verificationCode"], input[name="security_code"], input[autocomplete="one-time-code"], iframe[src*="captcha" i]')])) throw new HaltError('challenge');
  if (await hasText(page, /Action Blocked|We restrict|temporarily blocked|일시적으로 (사용|차단|제한)|행동이 제한|활동이 제한|게시물에 대한 활동이 마음에 들지 않는지|잠시 차단/i)) throw new HaltError('blocked');
  if (!allowLogin && (/\/accounts\/login/.test(url) || await firstVisible(loginInputs(page)))) throw new HaltError('login');
}

export async function launchBrowser(crawlerDir: string, check: () => void = () => {}): Promise<{ browser: Browser; context: BrowserContext; page: Page; diagnosticPage: Page; sessionFile: string }> {
  check();
  const sessionDir = resolve(crawlerDir, '.session');
  const cacheDir = resolve(crawlerDir, '.cache');
  try {
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await chmod(sessionDir, 0o700);
  } catch { throw new SessionError(); }
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700).catch(() => {});
  const sessionFile = resolve(sessionDir, 'state.json');
  const storageState = await loadSession(sessionFile);
  check();
  const browser = await chromium.launch({ headless: process.env.AGAMAJUNG_HEADLESS !== '0' });
  // 한국어 UI·KST 시각을 고정한다(셀렉터의 한글 버튼명·날짜 해석 전제).
  try {
    check();
    let context: BrowserContext;
    try { context = await browser.newContext({ storageState, locale: 'ko-KR', timezoneId: 'Asia/Seoul' }); }
    catch { throw new SessionError(); }
    check();
    const page = await context.newPage();
    check();
    page.setDefaultTimeout(15000);
    // Keep the original page available for diagnostics after stop/quiet guards trip.
    return { browser, context, page: guardPage(page, check), diagnosticPage: page, sessionFile };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function ensureLogin(context: BrowserContext, originalPage: Page, settings: Settings, username: string, sessionFile: string, check: () => void = () => {}) {
  try { await completeLogin(context, originalPage, settings, username, sessionFile, check); }
  catch (error) {
    // Observed halts and session failures must not become quiet-window retries.
    if (error instanceof HaltError || error instanceof SessionError) throw error;
    check();
    if (error instanceof QuietWindowError) throw error;
    // Playwright call logs can contain fill values. Never expose the raw error.
    throw new Error('크롤러 로그인 실패: 자격 증명·화면 구조·브라우저 상태를 수동 점검하세요.');
  }
}

type LoginState = 'challenge' | 'blocked' | 'login-form' | 'known-prompt' | 'authenticated' | 'blank-loading' | 'unknown';
// Internal control flow only; saveSession removes its temporary file on this error.
class LoginNotReady extends Error {}

async function completeLogin(context: BrowserContext, originalPage: Page, settings: Settings, username: string, sessionFile: string, check: () => void) {
  const page = guardPage(originalPage, check);
  let deadline = Date.now() + 120_000;
  let phase: 'entry' | 'submitted' | 'home' = 'entry';
  let phaseStarted = Date.now();
  let state: LoginState | undefined;
  let blankSince: number | undefined;
  let recoveries = 0;
  let submitted = false;
  let revisited = false;
  const dismissed = new Set<string>();
  let awaitingPrompt: string | undefined;
  const interstitial = () => firstVisible([page.getByRole('dialog'), page.getByRole('alertdialog')]);
  const record = (next: LoginState, recovery = false) => {
    if (next !== state || recovery) health(recovery ? 'login_recovery' : 'login_state', {
      phase, state: next, elapsed_ms: Date.now() - phaseStarted, recoveries,
    });
    if (next !== 'blank-loading') blankSince = undefined;
    else if (blankSince === undefined) blankSince = Date.now();
    state = next;
  };
  const human = async () => {
    try { await assertHuman(page, { allowLogin: true }); }
    catch (error) {
      if (error instanceof HaltError && (error.reason === 'challenge' || error.reason === 'blocked')) record(error.reason);
      throw error;
    }
  };
  const observe = async (navigationDelay = false) => {
    check();
    await human();
    // During the configured navigation jitter, inspect safety/loading only.
    // Credential and authenticated-menu reads wait for that pacing delay.
    if (navigationDelay) {
      const next = await blankLoginSurface(page) ? 'blank-loading' : 'unknown';
      await human();
      record(next);
      return { state: next, prompt: null, form: null };
    }
    const prompt = await loginPrompt(page);
    const form = await firstVisible(loginInputs(page));
    const next: LoginState = form ? 'login-form' : prompt ? 'known-prompt'
      : await interstitial() ? 'unknown'
      : !/\/accounts\//i.test(page.url()) && await firstVisible(authenticatedNavigation(page)) ? 'authenticated'
      : await blankLoginSurface(page) ? 'blank-loading' : 'unknown';
    // A challenge may have appeared while the ordinary UI was being read.
    await human();
    record(next);
    return { state: next, prompt, form };
  };
  const beginPhase = (next: typeof phase) => {
    phase = next;
    phaseStarted = Date.now();
    deadline = phaseStarted + 120_000;
    state = undefined;
    blankSince = undefined;
    recoveries = 0;
  };
  const verify = async () => {
    const current = await observe();
    if (current.state === 'blank-loading') throw new LoginNotReady();
    await assertHuman(page);
    if (current.state !== 'authenticated') throw new HaltError('login');
    if (Date.now() >= deadline) throw new HaltError('login');
  };
  const navigate = async () => {
    check();
    await human(); // Never navigate away from an observed security screen.
    if (Date.now() >= deadline) return;
    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
    } catch (error) {
      check();
      await human();
      // Only a navigation timeout may settle through the bounded login loop.
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    }
    await observe(true);
  };
  const pause = async (min: number, max = min, navigationDelay = false) => {
    let until = Math.min(deadline, Date.now() + jitter(min, max));
    while (Date.now() < until) {
      await observe(navigationDelay);
      if (state === 'blank-loading' && blankSince !== undefined && Date.now() - blankSince >= 30_000 && recoveries === 0) {
        check();
        const current = await observe();
        if (current.state === 'blank-loading' && Date.now() < deadline) {
          recoveries++;
          record('blank-loading', true);
          await navigate();
          // Recovery GETs need the same pacing as entry/home navigation.
          // Extend this wait without extending the phase deadline, and keep
          // monitoring security screens before reading credentials or menus.
          until = Math.min(deadline, Math.max(until, Date.now() + jitter(...settings.delays_ms.navigation)));
          navigationDelay = true;
        }
      }
      check();
      if (Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
    }
    check();
    await human();
  };
  await navigate();
  await pause(...settings.delays_ms.navigation, true);
  while (Date.now() < deadline) {
    const current = await observe();
    const { prompt, form } = current;
    if (prompt && !form) {
      if (!dismissed.has(prompt.kind) && prompt.dismiss) {
        await human();
        await prompt.dismiss.click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
        dismissed.add(prompt.kind);
        awaitingPrompt = prompt.kind;
        await pause(...settings.delays_ms.action);
      } else if (dismissed.has(prompt.kind) && awaitingPrompt !== prompt.kind) {
        throw new HaltError('login');
      } else await pause(1000);
      continue;
    }
    awaitingPrompt = undefined;
    if (form) {
      if (revisited) throw new HaltError('login');
      if (!submitted) {
        const password = process.env.AGAMAJUNG_IG_PASSWORD;
        if (!password) throw new Error('AGAMAJUNG_IG_PASSWORD 환경변수가 필요합니다.');
        const login = await firstVisible(loginInputs(page).slice(0, 3));
        const passwordField = await firstVisible([page.getByLabel(/^(Password|비밀번호)$/i), page.locator('input[name="password"]'), page.locator('input[type="password"]')]);
        const submit = await firstVisible([page.getByRole('button', { name: /^(Log in|로그인)$/i }), page.locator('button[type="submit"]')]);
        if (login && passwordField && submit) {
          await human();
          health('login_attempt');
          await login.fill(username);
          await passwordField.fill(password);
          await human();
          submitted = true;
          beginPhase('submitted');
          await submit.click();
          await pause(...settings.delays_ms.login);
          continue;
        }
      }
    } else if (current.state === 'authenticated') {
      check();
      let cookies;
      try { cookies = await context.cookies('https://www.instagram.com/'); }
      catch { throw new SessionError(); }
      check();
      await human();
      if (hasSessionCookie(cookies)) {
        const ready = await observe();
        if (ready.state !== 'authenticated') {
          if (ready.form && (submitted || revisited)) throw new HaltError('login');
          await pause(1000);
          continue;
        }
        await assertHuman(page);
        if (!revisited) {
          revisited = true;
          beginPhase('home');
          await navigate();
          await pause(...settings.delays_ms.navigation, true);
          continue;
        }
        try {
          await verify();
          await saveSession(context, sessionFile, check, verify);
        } catch (error) {
          if (!(error instanceof LoginNotReady)) throw error;
          await pause(1000);
          continue;
        }
        check();
        health(submitted ? 'login_ok' : 'session_reused');
        return;
      }
    }
    await pause(1000);
  }
  await human(); // A final security check takes precedence over the login timeout.
  throw new HaltError('login');
}

// Guard reads as well as writes: a scan, cached locator click, or login fill must
// recheck the clock immediately before calling Playwright, including after delays.
export function guardPage(page: Page, check: () => void): Page {
  const locatorMethods = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'frameLocator', 'nth', 'first', 'last', 'filter', 'and', 'or']);
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        check();
        const result = Reflect.apply(value, object, args);
        return locatorMethods.has(String(key)) ? wrap(result) : result;
      };
    },
  });
  return wrap(page);
}
