// 준실시간 신호 수집: 알림(활동) 화면과 홈 스토리 트레이를 폴링해
// "방금 뭔가 올라온 계정"을 가려낸다. 고정 3계정 순환이 아니라 이 신호로 우선순위를 정한다.
// 구조가 잡히지 않으면 빈 신호를 돌려주고(soft fail), 챌린지·로그인 이탈만 즉시 중단한다.
import type { Page } from 'playwright';
import { assertHuman } from './browser';
import { firstVisible, visibleHandles } from './selectors';
import { sleep } from './util';
import { health } from './health';
import type { Settings } from './config';

export type Signals = { storyAccounts: string[]; freshAccounts: string[] };

async function storiesTray(page: Page, settings: Settings): Promise<string[]> {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await sleep(...settings.delays_ms.navigation);
  await assertHuman(page);
  const tray = await firstVisible([page.locator('section'), page.locator('nav + section')]);
  const handles = await visibleHandles(page, tray ?? page.locator('body'));
  return handles.filter(h => h !== 'www.instagram.com').slice(0, 30);
}

async function notifications(page: Page, settings: Settings): Promise<string[]> {
  try {
    await page.goto('https://www.instagram.com/accounts/activity/', { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.action);
    await assertHuman(page);
    if (!/accounts\/activity/.test(page.url())) return []; // UI가 홈으로 돌려보내면 알림 없음으로 처리
    const panel = await firstVisible([page.getByRole('dialog'), page.locator('[role="main"], main')]);
    const handles = await visibleHandles(page, panel ?? page.locator('body'));
    if (!handles.length) health('selector_miss', { scope: 'activity' });
    return handles.slice(0, 20);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('halt:')) throw error;
    health('selector_miss', { scope: 'activity', detail: '알림 화면 구조 확인 필요' });
    return [];
  }
}

export async function readSignals(page: Page, settings: Settings): Promise<Signals> {
  const storyAccounts = await storiesTray(page, settings);
  const freshAccounts = await notifications(page, settings);
  const signals = { storyAccounts, freshAccounts: freshAccounts.filter(h => !storyAccounts.includes(h)) };
  health('signals', { story_accounts: signals.storyAccounts.length, fresh_accounts: signals.freshAccounts.length });
  return signals;
}
