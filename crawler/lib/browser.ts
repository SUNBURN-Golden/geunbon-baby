// 브라우저 실행·로그인·이상 상태 감지. 챌린지/차단/로그인 이탈은 HaltError 로 즉시 중단하며
// 어디서도 자동 재시도하지 않는다. 비밀번호는 환경변수에서만 읽고 로그에 남기지 않는다.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jitter, sleep } from './util';
import { authenticatedNavigation, firstVisible, hasText, loginInputs, loginPrompt } from './selectors';
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
  if (/\/(challenge|checkpoint)(?:\/|\?|$)|\/accounts\/(?:login\/two_factor|two_factor)/i.test(url) || await hasText(page, /Enter (the )?security code|two.factor authentication|security check|CAPTCHA|보안 (?:코드|확인)|인증 코드|본인 확인|로봇이 아닙니다/i) ||
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

async function completeLogin(context: BrowserContext, originalPage: Page, settings: Settings, username: string, sessionFile: string, check: () => void) {
  const page = guardPage(originalPage, check);
  let deadline = Date.now() + 120_000;
  let submitted = false;
  let revisited = false;
  const dismissed = new Set<string>();
  let awaitingPrompt: string | undefined;
  const interstitial = () => firstVisible([page.getByRole('dialog'), page.getByRole('alertdialog')]);
  const verify = async () => {
    await assertHuman(page);
    if (await loginPrompt(page) || await interstitial() || !await firstVisible(authenticatedNavigation(page))) throw new HaltError('login');
  };
  const pause = async (min: number, max = min) => {
    const until = Math.min(deadline, Date.now() + jitter(min, max));
    while (Date.now() < until) {
      check();
      await sleep(Math.min(1000, until - Date.now()));
    }
    check();
  };
  const navigate = async () => {
    check();
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
    await pause(...settings.delays_ms.navigation);
  };
  await navigate();
  while (Date.now() < deadline) {
    check();
    await assertHuman(page, { allowLogin: true });
    const prompt = await loginPrompt(page);
    if (prompt) {
      if (!dismissed.has(prompt.kind) && prompt.dismiss) {
        await assertHuman(page, { allowLogin: true });
        await prompt.dismiss.click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
        dismissed.add(prompt.kind);
        awaitingPrompt = prompt.kind;
        await pause(...settings.delays_ms.action);
      } else if (dismissed.has(prompt.kind) && awaitingPrompt !== prompt.kind) {
        throw new HaltError('login'); // A completed prompt must not recur.
      } else await pause(1000);
      continue;
    }
    awaitingPrompt = undefined;
    if (await interstitial()) {
      await pause(1000);
      continue;
    }
    const form = await firstVisible(loginInputs(page));
    if (form) {
      if (revisited) throw new HaltError('login');
      if (!submitted) {
        const password = process.env.AGAMAJUNG_IG_PASSWORD;
        if (!password) throw new Error('AGAMAJUNG_IG_PASSWORD 환경변수가 필요합니다.');
        const login = await firstVisible(loginInputs(page).slice(0, 3));
        const passwordField = await firstVisible([page.getByLabel(/^(Password|비밀번호)$/i), page.locator('input[name="password"]'), page.locator('input[type="password"]')]);
        const submit = await firstVisible([page.getByRole('button', { name: /^(Log in|로그인)$/i }), page.locator('button[type="submit"]')]);
        if (login && passwordField && submit) {
          await assertHuman(page, { allowLogin: true });
          health('login_attempt');
          await login.fill(username);
          await passwordField.fill(password);
          await assertHuman(page, { allowLogin: true });
          submitted = true;
          deadline = Date.now() + 120_000;
          await submit.click();
          await pause(...settings.delays_ms.login);
          continue;
        }
      }
    } else if (!/\/accounts\//i.test(page.url()) && await firstVisible(authenticatedNavigation(page))) {
      check();
      let cookies;
      try { cookies = await context.cookies('https://www.instagram.com/'); }
      catch { throw new SessionError(); }
      check();
      if (hasSessionCookie(cookies)) {
        await assertHuman(page); // Recheck after the context operation.
        if (!revisited) {
          revisited = true;
          // Login settling and prompt delays must not consume the budget for
          // verifying cookies across navigation. This phase remains bounded.
          deadline = Date.now() + 120_000;
          await navigate();
          continue;
        }
        await saveSession(context, sessionFile, check, verify);
        check();
        health(submitted ? 'login_ok' : 'session_reused');
        return;
      }
    }
    await pause(1000);
  }
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
