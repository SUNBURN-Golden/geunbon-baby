// Instagram UI 언어·A/B 테스트에 대비한 다중 후보 셀렉터 도우미.
// aria role·버튼/링크 이름 정규식(한국어+영어)을 우선하고 CSS 셀렉터는 마지막 대안으로 쓴다.
// 후보가 하나도 잡히지 않으면 selector_miss 상태 로그를 남기고 진행하거나(soft) 상위에서 중단한다.
import type { Locator, Page } from 'playwright';
import { canonicalPost } from './util';
import { QuietWindowError } from './quiet-window';

export async function firstVisible(candidates: Locator[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    try {
      for (let i = 0; i < await candidate.count(); i++) {
        const match = candidate.nth(i);
        if (await match.isVisible()) return match;
      }
    } catch (error) {
      if (error instanceof QuietWindowError) throw error;
      /* 렌더링 교체 중 사라진 후보는 건너뛴다 */
    }
  }
  return null;
}

export async function clickFirst(candidates: Locator[]): Promise<boolean> {
  for (const candidate of candidates) {
    const target = await firstVisible([candidate]);
    if (!target) continue;
    try { await target.click({ timeout: 5000 }); return true; }
    catch (error) {
      if (error instanceof QuietWindowError) throw error;
      /* Detached or covered: try the next selector. */
    }
  }
  return false;
}

export async function hasText(page: Page, pattern: RegExp): Promise<boolean> {
  try {
    const hit = page.getByText(pattern).first();
    return (await hit.count()) > 0 && await hit.isVisible();
  } catch (error) {
    if (error instanceof QuietWindowError) throw error;
    return false;
  }
}

// Require an email verification instruction together with a code-entry control.
// A generic mention of a code (for example a promotion) is not a challenge.
export async function emailCodeChallenge(page: Page): Promise<boolean> {
  return await hasText(page, /이메일을? 확인(?:하세요|해)|이메일(?: 주소)?로 (?:보낸|전송된|받은).{0,40}코드|Check your (?:e-?mail|inbox)|(?:code.{0,40}(?:sent|send).{0,40}e-?mail)|(?:enter.{0,20}code.{0,40}e-?mail)/i) &&
    !!await firstVisible([
      page.getByRole('textbox', { name: /^(?:코드|확인 코드|이메일 코드|Code|Confirmation code|Email code)$/i }),
      page.locator('input[name="code"], input[name="email_code"], input[name="confirmationCode"], input[name="confirmation_code"], input[name="emailCode"], input[inputmode="numeric"]'),
    ]);
}

// The result contains no page text or input values. Failed reads are unknown,
// never evidence of a blank page. Keep this callback self-contained for Playwright.
export async function blankLoginSurface(page: Page): Promise<boolean> {
  try {
    return await page.locator('body').evaluate(body => {
      const controls = body.querySelectorAll('input:not([type="hidden"]), button, a[href], select, textarea, [role="button"], [role="link"], [role="textbox"], [role="dialog"], [role="alertdialog"], [contenteditable="true"]');
      return !(body as HTMLElement).innerText.trim() && !Array.from(controls).some(element => {
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      });
    }, undefined, { timeout: 1000 }) === true;
  } catch (error) {
    if (error instanceof QuietWindowError) throw error;
    return false;
  }
}

export const loginInputs = (page: Page) => [
  page.getByRole('textbox', { name: /전화번호.*사용자|Phone number.*username|사용자 이름/i }),
  page.locator('input[name="username"]'),
  page.locator('input[autocomplete="username"]'),
  page.locator('input[name="password"]'),
  page.locator('input[type="password"]'),
];

export const authenticatedNavigation = (page: Page) => [
  page.getByRole('link', { name: /^(프로필|Profile)$/i }),
  page.getByRole('link', { name: /^(메시지|Messages|Direct)$/i }),
  page.locator('a[href^="/direct/inbox"]'),
  page.getByRole('link', { name: /^(알림|Notifications)$/i }),
  page.getByRole('button', { name: /^(알림|Notifications)$/i }),
];

const loginPrompts = [
  { kind: 'save', title: /Save (?:your )?login info(?:rmation)?|로그인 정보를? 저장|로그인 정보 저장/i },
  { kind: 'notifications', title: /Turn on notifications|알림 (?:설정|켜기)|알림을 (?:설정|켜)/i },
] as const;

export async function loginPrompt(page: Page) {
  for (const prompt of loginPrompts) {
    if (!await hasText(page, prompt.title)) continue;
    // Scope an exact dismissal to the recognized dialog/full-page prompt.
    const scope = await firstVisible([
      page.getByRole('dialog').filter({ hasText: prompt.title }),
      page.locator('main, [role="main"]').filter({ hasText: prompt.title }),
      // Older save-info pages have no semantic container. Only allow the
      // whole page on the known interstitial route, never on an ordinary feed.
      ...(/\/accounts\/onetap\/?(?:\?|$)/i.test(page.url()) && prompt.kind === 'save'
        ? [page.locator('body').filter({ hasText: prompt.title })] : []),
    ]);
    const dismiss = scope && await firstVisible([
      scope.getByRole('button', { name: /^(Not now|나중에 하기|나중에)$/i }),
      scope.getByRole('link', { name: /^(Not now|나중에 하기|나중에)$/i }),
    ]);
    return { kind: prompt.kind, dismiss };
  }
  return null;
}

export const followButton = (page: Page) => [
  page.getByRole('button', { name: /^(Follow|팔로우)$/ }),
  page.getByRole('button', { name: /팔로우 하기/ }),
  page.getByRole('button', { name: /^Follow$/i }),
  page.locator('header [role="button"]').filter({ hasText: /^(Follow|팔로우)$/i }),
];
export const followingButton = (page: Page) => [
  page.getByRole('button', { name: /^(Following|팔로잉|Requested|요청됨)(?:\s|$)/i }),
  page.getByRole('button', { name: /^Following$/i }),
];
export const nextStoryButton = (page: Page) => [
  page.getByRole('button', { name: /^(Next|다음)$/ }),
  page.getByRole('button', { name: /다음 스토리|Next story/i }),
  page.locator('button[aria-label*="Next" i]'),
];
// 프로필 링크만 남긴다(explore/reels/direct/accounts/stories/p/tv 등 예약 경로 제외).
export const HANDLE_HREF = /^\/([A-Za-z0-9._]{1,30})\/?$/;
export const RESERVED = /^(explore|reels|direct|accounts|stories|p|reel|tv|about|legal|developer|directory|web|challenge|emails|terms|privacy)$/i;
export function parseHandle(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.instagram.com/');
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password) return null;
    const handle = HANDLE_HREF.exec(url.pathname)?.[1]?.toLowerCase();
    return handle && !RESERVED.test(handle) ? handle : null;
  } catch { return null; }
}
export async function visibleHandles(page: Page, scope?: Locator): Promise<string[]> {
  const base = scope ?? page.locator('body');
  const hrefs = await base.locator('a[href]').evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs.map(parseHandle).filter((h): h is string => h !== null))];
}
export async function postLinks(page: Page): Promise<string[]> {
  const hrefs = await page.locator('a[href*="/p/"], a[href*="/reel/"]').evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs.map(canonicalPost).filter((url): url is string => url !== null))];
}

export function parseStoryHandle(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.instagram.com/');
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.protocol !== 'https:') return null;
    const handle = /^\/stories\/([A-Za-z0-9._]{1,30})(?:\/\d+)?\/?$/.exec(url.pathname)?.[1];
    return handle && !['highlights', 'archive'].includes(handle) ? handle.toLowerCase() : null;
  } catch { return null; }
}
