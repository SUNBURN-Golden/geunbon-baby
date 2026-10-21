// 느리고 사람 속도를 흉내 내는 자동 팔로우. 일일·시간당 상한, 무작위 간격을 지키고
// 챌린지·차단·로그인 이탈이 보이면 즉시 전체 크롤러를 멈춘다(HaltError 전파).
// unverified 핸들은 settings.follow.allow_unverified=false 면 절대 팔로우하지 않는다.
import type { Page } from 'playwright';
import type { CrawlerState } from './state';
import type { SeedAccount, Settings } from './config';
import { assertHuman } from './browser';
import { firstVisible, followButton, followingButton } from './selectors';
import { jitter, sleep } from './util';
import { health } from './health';

export type FollowOutcome = 'followed' | 'capped' | 'resting' | 'none';

export async function maybeFollow(page: Page, ctx: { accounts: SeedAccount[]; state: CrawlerState; settings: Settings }): Promise<FollowOutcome> {
  const { accounts, state, settings } = ctx;
  if (state.countDay('follow') >= settings.follow.daily_cap) return 'capped';
  if (!state.canSpend('follow', { hourly: settings.hourly_caps.follows })) return 'capped';
  if (state.nextFollowAt && Date.now() < Date.parse(state.nextFollowAt)) return 'resting';
  if (!state.nextFollowAt && state.lastFollowAt && Date.now() - Date.parse(state.lastFollowAt) < settings.follow.gap_seconds[1] * 1000) return 'resting';
  const target = accounts.find(a => (!state.account(a.handle).last_follow_attempt || Date.now() - Date.parse(state.account(a.handle).last_follow_attempt!) >= settings.staleness.account_recheck_minutes * 60000) && a.follow && !state.isFollowing(a.handle) && (a.verified || settings.follow.allow_unverified));
  if (!target) return 'none';
  if (!await state.reserve('profile_visits', { hourly: settings.hourly_caps.profile_visits })) return 'capped';
  state.account(target.handle).last_follow_attempt = new Date().toISOString();
  await state.save();
  await page.goto(`https://www.instagram.com/${target.handle}/`, { waitUntil: 'domcontentloaded' });
  await sleep(...settings.delays_ms.navigation);
  await assertHuman(page);
  if (await firstVisible(followingButton(page))) { // 이미 팔로우 중이면 기록만 갱신
    state.setFollowing(target.handle, true);
    return 'none';
  }
  const button = await firstVisible(followButton(page));
  if (!button) {
    health('follow_skip', { handle: target.handle, reason: 'button_not_found' });
    return 'none';
  }
  state.nextFollowAt = new Date(Date.now() + jitter(...settings.follow.gap_seconds) * 1000).toISOString();
  state.lastFollowAt = new Date().toISOString();
  if (!await state.reserve('follow', { hourly: settings.hourly_caps.follows, daily: settings.follow.daily_cap })) return 'capped';
  await button.click();
  await sleep(...settings.delays_ms.action);
  await assertHuman(page); // 팔로우 직후 차단 안내 감지
  const confirmed = await firstVisible(followingButton(page));
  state.setFollowing(target.handle, Boolean(confirmed));
  if (confirmed) {
    health('follow', { handle: target.handle, daily: state.countDay('follow') });
  } else {
    health('follow_skip', { handle: target.handle, reason: 'unconfirmed' });
  }
  await state.save();
  return confirmed ? 'followed' : 'none';
}
