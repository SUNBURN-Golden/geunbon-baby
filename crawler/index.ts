// 아가마중 크롤러 v2 진입점(오케스트레이터).
// 준실시간 폴링: 알림·스토리 트레이 신호 → 우선순위 큐 → 새 게시물/스토리 수집 →
// 자동 추출 제안과 함께 /api/v1/ingest 검수 대기열 전송 → 보수적 자동 팔로우 → 해시태그 셀러 발견.
// 챌린지·차단·API 실패 시 즉시 중단하며 자동 재시도하지 않는다(종료코드 75/1).
import { loadConfig, type SeedAccount, type Settings } from './lib/config';
import { CrawlerState, statePath } from './lib/state';
import { health, initHealth } from './lib/health';
import { launchBrowser, ensureLogin, HaltError } from './lib/browser';
import { readSignals, type Signals } from './lib/activity';
import { collectAccount } from './lib/collect';
import { maybeFollow } from './lib/follow';
import { discoverSellers } from './lib/discover';
import { IngestError } from './lib/ingest';
import { sleep } from './lib/util';

// 새 글·스토리 링·활동 신호가 있는 계정을 먼저, 나머지는 오래된 순으로.
// 고정 개수 순환이 아니라 신호 + 최근 확인 시점 기반이다.
export function prioritize(signals: Signals, state: CrawlerState, seeds: SeedAccount[], settings: Settings): string[] {
  const ring = new Set(signals.storyAccounts);
  const active = new Set(signals.freshAccounts);
  const watch = new Set([...seeds.map(s => s.handle), ...state.followingHandles]);
  const pool = [...new Set([
    ...signals.storyAccounts.filter(handle => watch.has(handle)),
    ...signals.freshAccounts.filter(handle => watch.has(handle)),
    ...seeds.filter(s => s.verified || state.isFollowing(s.handle)).map(s => s.handle),
  ])];
  return pool
    .map(handle => {
      const lastChecked = state.account(handle).last_checked;
      const age = lastChecked ? Date.now() - Date.parse(lastChecked) : Infinity;
      const fresh = ring.has(handle) || active.has(handle);
      const skip = !fresh && age < settings.staleness.account_recheck_minutes * 60_000;
      const score = (ring.has(handle) ? 3 : 0) + (active.has(handle) ? 2 : 0) + (watch.has(handle) ? 1 : 0) + Math.min(age / 3_600_000, 2);
      return { handle, skip, score };
    })
    .filter(entry => !entry.skip)
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
    .slice(0, settings.per_tick.max_accounts)
    .map(entry => entry.handle);
}

async function main() {
  const endpoint = process.env.AGAMAJUNG_API_URL;
  const token = process.env.INGEST_TOKEN;
  if (!endpoint || !token) throw new Error('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  const api = new URL('/api/v1/ingest', endpoint);
  if (api.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(api.hostname)) throw new Error('외부 API는 HTTPS가 필요합니다.');

  const crawlerDir = import.meta.dirname;
  const { settings, accounts } = await loadConfig(crawlerDir);
  await initHealth(crawlerDir);
  const state = await CrawlerState.open(statePath(crawlerDir));
  const username = process.env.AGAMAJUNG_IG_USER ?? 'jaytparkitrighthere@gmail.com';

  const { browser, context, page, sessionFile } = await launchBrowser(crawlerDir);
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  health('run_start', { seeds: accounts.seed_accounts.length, ocr: settings.ocr.enabled, follow_daily_cap: settings.follow.daily_cap, poll: settings.poll_interval_minutes.join('-') });
  try {
    await ensureLogin(context, page, settings, username, sessionFile);
    while (!stopped) {
      const signals = await readSignals(page, settings);
      const queue = prioritize(signals, state, accounts.seed_accounts, settings);
      health('queue', { size: queue.length, accounts: queue.join(',') });
      let posts = 0;
      let stories = 0;
      for (const account of queue) {
        if (stopped) break;
        if (!state.canSpend('profile_visits', { hourly: settings.hourly_caps.profile_visits })) { health('queue', { size: 0, accounts: 'profile_visit_cap' }); break; }
        state.spend('profile_visits');
        try {
          const collected = await collectAccount(page, { account, crawlerDir, state, settings, api, token });
          posts += collected.posts;
          stories += collected.stories;
        } catch (error) {
          if (error instanceof HaltError || error instanceof IngestError) throw error;
          // 셀렉터 미스·일시적 렌더 오류는 해당 계정만 건너뛰고 계속 진행한다.
          health('error', { scope: 'collect', account });
        }
      }
      const follow = await maybeFollow(page, { accounts: accounts.seed_accounts, state, settings });
      await discoverSellers(page, { accounts, state, settings });
      await state.save();
      health('poll', { posts, stories, follow, followed_today: state.countDay('follow') });
      if (process.env.AGAMAJUNG_ONCE === '1') break;
      const [minMinutes, maxMinutes] = settings.poll_interval_minutes;
      await sleep(minMinutes * 60_000, maxMinutes * 60_000);
    }
  } finally {
    await state.save();
    await context.close();
    await browser.close();
    health('run_stop', {});
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof HaltError ? error.reason : error instanceof IngestError ? 'api' : 'unknown';
  console.error(`크롤러 중단(${reason}): 인증·차단·환경변수·화면 구조를 수동 점검하세요. 상세는 crawler/logs 상태 로그 확인. 비밀번호·토큰·원문은 기록하지 않습니다.`);
  process.exitCode = error instanceof HaltError ? 75 : 1;
});
