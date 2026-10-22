// 아가마중 크롤러 v2 진입점(오케스트레이터).
// 준실시간 폴링: 알림·스토리 트레이 신호 → 우선순위 큐 → 새 게시물/스토리 수집 →
// 자동 추출 제안과 함께 /api/v1/ingest 검수 대기열 전송 → 보수적 자동 팔로우 → 해시태그 셀러 발견.
// 챌린지·차단·API 실패 시 즉시 중단하며 자동 재시도하지 않는다(종료코드 75/1).
import { loadConfig, loadEnvironment } from './lib/config';
import { CrawlerState, statePath } from './lib/state';
import { health, initHealth, flushHealth } from './lib/health';
import { launchBrowser, ensureLogin, HaltError, assertHuman } from './lib/browser';
import { saveSession, SessionError } from './lib/session';
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
import { failureDetails } from './lib/failure';
import { loadExternalSettings } from './lib/external/sources';
import { runExternalSources } from './lib/external/run';
import { PoliteFetcher } from './lib/external/fetch';
import { renderPage } from './lib/external/render';

export async function main() {
  const crawlerDir = import.meta.dirname;
  await initHealth(crawlerDir);
  loadEnvironment(crawlerDir);
  const endpoint = process.env.AGAMAJUNG_API_URL;
  const token = process.env.INGEST_TOKEN;
  if (!endpoint || !token) throw new Error('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  const api = new URL('/api/v1/ingest', endpoint);
  if (api.username || api.password || (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)))) throw new Error('외부 API는 HTTPS가 필요합니다.');

  const { settings, accounts } = await loadConfig(crawlerDir);
  // 외부 공구 모음 설정 오류는 어떤 수집보다 먼저(실행 전) 중단시킨다.
  const external = process.env.AGAMAJUNG_EXTERNAL !== '0';
  const externalDryRun = process.env.AGAMAJUNG_EXTERNAL_DRY_RUN === '1';
  const externalSettings = external ? await loadExternalSettings(crawlerDir) : null;
  const state = await CrawlerState.open(statePath(crawlerDir));
  const username = process.env.AGAMAJUNG_IG_USER ?? 'agamajung';

  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  health('run_start', { seeds: accounts.seed_accounts.length, ocr: settings.ocr.enabled, follow_daily_cap: settings.follow.daily_cap, poll: settings.poll_interval_minutes.join('-'), external, external_dry_run: external && externalDryRun });
  try {
    // 외부 수집은 Instagram 사이클보다 먼저, 프로세스 시작 시 한 번만 실행한다(연속 모드에서도 반복하지 않음).
    if (externalSettings && !stopped) {
      try {
        const fetcher = new PoliteFetcher(externalSettings, { fetch: (...args) => globalThis.fetch(...args), sleep: ms => sleep(ms), now: Date.now, random: Math.random }, info => health('robots_block', info));
        await runExternalSources({ settings: externalSettings, state, api, token, stopped: () => stopped, fetcher, render: renderPage, dryRun: externalDryRun, log: health });
      } catch (error) {
        // 수집 API 오류는 설정·인증 문제일 수 있어 그대로 중단한다. 그 밖의 외부 오류는 Instagram 수집을 막지 않는다.
        if (error instanceof IngestError) throw error;
        health('error', { scope: 'external' });
      }
    }
    // dry-run은 외부 소스만 점검하는 용도이므로 공유 Instagram 계정으로 로그인하거나 사이클을 돌리지 않고 종료한다.
    if (externalSettings && externalDryRun) return;
    await runMainLoop({ quietWindows: settings.quiet_windows, pollMinutes: settings.poll_interval_minutes, once: process.env.AGAMAJUNG_ONCE === '1' }, {
      now: Date.now,
      random: Math.random,
      sleep,
      schedule: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
      stopped: () => stopped,
      open: check => launchBrowser(crawlerDir, check),
      login: ({ context, page, sessionFile }, check) => ensureLogin(context, page, settings, username, sessionFile, check),
      close: async ({ context, browser }) => { try { await context.close(); } finally { await browser.close(); } },
      save: () => state.save(),
      flush: flushHealth,
      log: health,
      isFatal: error => error instanceof HaltError || error instanceof IngestError || error instanceof SessionError,
      onFatal: async (error, session, signal) => {
        if (error instanceof HaltError) {
          process.exitCode = 75;
          await captureHalt(crawlerDir, error.reason, session?.diagnosticPage, signal);
        }
      },
      cycle: async ({ context, page, sessionFile }, check) => {
        check();
        await syncFollowing(page, { state, settings }, check);
        check();
        const signals = await readSignals(page, settings);
        check();
        const queue = planScans(signals, state, accounts.seed_accounts, settings);
        health('queue', { size: queue.length, accounts: queue.map(job => job.account).join(',') });
        let posts = 0;
        let stories = 0;
        const imagePolicy = new Map(accounts.seed_accounts.map(seed => [seed.handle.toLowerCase(), seed.collect_images]));
        for (const job of queue) {
          if (stopped) break;
          check();
          const { account } = job;
          try {
            const collected = await collectAccount(page, { account, crawlerDir, state, settings, api, token, scanPosts: job.posts, scanStories: job.stories, collectImages: imagePolicy.get(account.toLowerCase()) ?? true });
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
        check();
        await assertHuman(page);
        await saveSession(context, sessionFile, check, () => assertHuman(page));
        check();
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
    const details = failureDetails(error);
    // stderr remains available even when health initialization or disk writes fail.
    console.error(JSON.stringify({ event: 'error', scope: reason, ...details }));
    console.error(`크롤러 중단(${reason}): 인증·차단·환경변수·화면 구조를 수동 점검하세요. 상세는 crawler/logs 상태 로그와 비밀값을 가린 halt 진단 파일 확인.`);
    health(reason === 'challenge' || reason === 'blocked' ? reason : 'error', { scope: reason, ...details });
    await flushHealth();
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
