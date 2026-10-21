// 아가마중 크롤러 v2 진입점(오케스트레이터).
// 준실시간 폴링: 알림·스토리 트레이 신호 → 우선순위 큐 → 새 게시물/스토리 수집 →
// 자동 추출 제안과 함께 /api/v1/ingest 검수 대기열 전송 → 보수적 자동 팔로우 → 해시태그 셀러 발견.
// 챌린지·차단·API 실패 시 즉시 중단하며 자동 재시도하지 않는다(종료코드 75/1).
import { loadConfig } from './lib/config';
import { CrawlerState, statePath } from './lib/state';
import { health, initHealth, flushHealth } from './lib/health';
import { launchBrowser, ensureLogin, HaltError } from './lib/browser';
import { readSignals } from './lib/activity';
import { collectAccount } from './lib/collect';
import { maybeFollow } from './lib/follow';
import { syncFollowing } from './lib/following';
import { discoverSellers } from './lib/discover';
import { IngestError } from './lib/ingest';
import { sleep } from './lib/util';
import { planScans } from './lib/schedule';
import { runMainLoop } from './lib/main-loop';
import { QuietWindowError } from './lib/quiet-window';
import { captureHalt } from './lib/halt';
import { pathToFileURL } from 'node:url';

export async function main() {
  const endpoint = process.env.AGAMAJUNG_API_URL;
  const token = process.env.INGEST_TOKEN;
  if (!endpoint || !token) throw new Error('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  const api = new URL('/api/v1/ingest', endpoint);
  if (api.username || api.password || (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)))) throw new Error('외부 API는 HTTPS가 필요합니다.');

  const crawlerDir = import.meta.dirname;
  const { settings, accounts } = await loadConfig(crawlerDir);
  await initHealth(crawlerDir);
  const state = await CrawlerState.open(statePath(crawlerDir));
  const username = process.env.AGAMAJUNG_IG_USER ?? 'jaytparkitrighthere@gmail.com';

  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  health('run_start', { seeds: accounts.seed_accounts.length, ocr: settings.ocr.enabled, follow_daily_cap: settings.follow.daily_cap, poll: settings.poll_interval_minutes.join('-') });
  try {
    await runMainLoop({ quietWindows: settings.quiet_windows, pollMinutes: settings.poll_interval_minutes, once: process.env.AGAMAJUNG_ONCE === '1' }, {
      now: Date.now,
      random: Math.random,
      sleep,
      schedule: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
      stopped: () => stopped,
      open: check => launchBrowser(crawlerDir, check),
      login: ({ context, page, sessionFile }) => ensureLogin(context, page, settings, username, sessionFile),
      close: async ({ context, browser }) => { try { await context.close(); } finally { await browser.close(); } },
      save: () => state.save(),
      flush: flushHealth,
      log: health,
      isFatal: error => error instanceof HaltError || error instanceof IngestError,
      onFatal: async (error, session, signal) => {
        if (error instanceof HaltError) {
          process.exitCode = 75;
          await captureHalt(crawlerDir, error.reason, session?.diagnosticPage, signal);
        }
      },
      cycle: async ({ page }, check) => {
        check();
        await syncFollowing(page, { state, settings }, check);
        check();
        const signals = await readSignals(page, settings);
        check();
        const queue = planScans(signals, state, accounts.seed_accounts, settings);
        health('queue', { size: queue.length, accounts: queue.map(job => job.account).join(',') });
        let posts = 0;
        let stories = 0;
        for (const job of queue) {
          if (stopped) break;
          check();
          const { account } = job;
          try {
            const collected = await collectAccount(page, { account, crawlerDir, state, settings, api, token, scanPosts: job.posts, scanStories: job.stories });
            posts += collected.posts;
            stories += collected.stories;
          } catch (error) {
            if (error instanceof QuietWindowError || error instanceof HaltError || error instanceof IngestError) throw error;
            health('error', { scope: 'collect', account });
          }
        }
        if (stopped) return;
        check();
        const follow = await maybeFollow(page, { accounts: accounts.seed_accounts, state, settings });
        if (!stopped) {
          check();
          try { await discoverSellers(page, { accounts, state, settings }); }
          catch (error) {
            if (error instanceof QuietWindowError || error instanceof HaltError || error instanceof IngestError) throw error;
            health('error', { scope: 'discovery' });
          }
        }
        health('poll', { posts, stories, follow, followed_today: state.countDay('follow') });
      },
    });
  } finally {
    health('run_stop', {});
    await flushHealth();
  }
}

export async function handleFailure(error: unknown) {
  // Set this before logging/flush: diagnostic failures must not allow a retry.
  const code = error instanceof HaltError ? 75 : 1;
  process.exitCode = code;
  const reason = error instanceof HaltError ? error.reason : error instanceof IngestError ? 'api' : 'unknown';
  try {
    health(reason === 'challenge' || reason === 'blocked' ? reason : 'error', { scope: reason });
    await flushHealth();
    console.error(`크롤러 중단(${reason}): 인증·차단·환경변수·화면 구조를 수동 점검하세요. 상세는 crawler/logs 상태 로그와 비밀값을 가린 halt 진단 파일 확인.`);
  } finally {
    // A failed browser close can leave live handles. Exit after the diagnostics
    // and flush have finished rather than depending on an empty event loop.
    process.exit(code);
  }
}

// Preserve direct CLI/systemd usage; importing from run.mjs or tests is inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(handleFailure);
}
