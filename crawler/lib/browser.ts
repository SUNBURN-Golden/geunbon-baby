// 브라우저 실행·로그인·이상 상태 감지. 챌린지/차단/로그인 이탈은 HaltError 로 즉시 중단하며
// 어디서도 자동 재시도하지 않는다. 비밀번호는 환경변수에서만 읽고 로그에 남기지 않는다.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sleep } from './util';
import { firstVisible, hasText } from './selectors';
import type { Settings } from './config';

export class HaltError extends Error {
  constructor(public reason: 'challenge' | 'blocked' | 'login') { super(`halt:${reason}`); }
}
// 챌린지 화면/차단 안내를 감지한다. 차단 문구는 UI 변화를 감안해 넉넉한 후보로 걸러둔다.
export async function assertHuman(page: Page) {
  const url = page.url();
  if (/challenge|checkpoint/i.test(url)) throw new HaltError('challenge');
  if (/\/accounts\/login/.test(url)) throw new HaltError('login');
  if (await hasText(page, /Action Blocked|We restrict|temporarily blocked|일시적으로 (사용|차단|제한)|행동이 제한|활동이 제한|게시물에 대한 활동이 마음에 들지 않는지|잠시 차단/i)) throw new HaltError('blocked');
}

export async function launchBrowser(crawlerDir: string): Promise<{ browser: Browser; context: BrowserContext; page: Page; sessionFile: string }> {
  const sessionDir = resolve(crawlerDir, '.session');
  const cacheDir = resolve(crawlerDir, '.cache');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700).catch(() => {});
  await chmod(cacheDir, 0o700).catch(() => {});
  const sessionFile = resolve(sessionDir, 'state.json');
  let storageState: string | undefined;
  try { await readFile(sessionFile); storageState = sessionFile; } catch { /* 최초 실행이면 세션 없이 시작 */ }
  const browser = await chromium.launch({ headless: process.env.AGAMAJUNG_HEADLESS !== '0' });
  // 한국어 UI·KST 시각을 고정한다(셀렉터의 한글 버튼명·날짜 해석 전제).
  const context = await browser.newContext({ storageState, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return { browser, context, page, sessionFile };
}

export async function ensureLogin(context: BrowserContext, page: Page, settings: Settings, username: string, sessionFile: string) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await sleep(...settings.delays_ms.navigation);
  if (await firstVisible([page.locator('input[name="username"]')])) {
    const password = process.env.AGAMAJUNG_IG_PASSWORD;
    if (!password) throw new Error('AGAMAJUNG_IG_PASSWORD 환경변수가 필요합니다.');
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await sleep(...settings.delays_ms.login);
  }
  await assertHuman(page);
  await context.storageState({ path: sessionFile });
  await chmod(sessionFile, 0o600);
}
