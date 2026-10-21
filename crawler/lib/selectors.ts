// Instagram UI 언어·A/B 테스트에 대비한 다중 후보 셀렉터 도우미.
// aria role·버튼/링크 이름 정규식(한국어+영어)을 우선하고 CSS 셀렉터는 마지막 대안으로 쓴다.
// 후보가 하나도 잡히지 않으면 selector_miss 상태 로그를 남기고 진행하거나(soft) 상위에서 중단한다.
import type { Locator, Page } from 'playwright';

export async function firstVisible(candidates: Locator[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) > 0 && await candidate.first().isVisible()) return candidate.first();
    } catch { /* 렌더링 교체 중 사라진 후보는 건너뛴다 */ }
  }
  return null;
}

export async function clickFirst(candidates: Locator[]): Promise<boolean> {
  const target = await firstVisible(candidates);
  if (!target) return false;
  await target.click();
  return true;
}

export async function hasText(page: Page, pattern: RegExp): Promise<boolean> {
  try {
    const hit = page.getByText(pattern).first();
    return (await hit.count()) > 0 && await hit.isVisible();
  } catch { return false; }
}

export const followButton = (page: Page) => [
  page.getByRole('button', { name: /^(Follow|팔로우)$/ }),
  page.getByRole('button', { name: /팔로우 하기/ }),
  page.getByRole('button', { name: /^Follow$/i }),
];
export const followingButton = (page: Page) => [
  page.getByRole('button', { name: /^(Following|팔로잉)/ }),
  page.getByRole('button', { name: /^Following$/i }),
];
export const nextStoryButton = (page: Page) => [
  page.getByRole('button', { name: /^(Next|다음)$/ }),
  page.getByRole('button', { name: /다음 스토리|Next story/i }),
  page.locator('button[aria-label*="Next" i]'),
];
// 프로필 링크만 남긴다(explore/reels/direct/accounts/stories/p/tv 등 예약 경로 제외).
export const HANDLE_HREF = /^\/([A-Za-z0-9._]{1,30})\/?$/;
export const RESERVED = /^(explore|reels|direct|accounts|stories|p|reel|tv|about|legal|developer|directory|web|challenge|emails|terms|privacy)/;
export async function visibleHandles(page: Page, scope?: Locator): Promise<string[]> {
  const base = scope ?? page.locator('body');
  const hrefs = await base.locator('a[href]').evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs.map(href => HANDLE_HREF.exec(href)?.[1]).filter((h): h is string => Boolean(h) && !RESERVED.test(h!)))];
}
export async function postLinks(page: Page): Promise<string[]> {
  const hrefs = await page.locator('a[href*="/p/"], a[href*="/reel/"]').evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs.filter(Boolean))];
}
