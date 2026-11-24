// 아가마중 크롤러 v2 진입점(오케스트레이터).
// 준실시간 폴링: 알림·스토리 트레이 신호 → 우선순위 큐 → 새 게시물/스토리 수집 →
// 검증된 게시물·스토리를 Linux 공구 수집함에 전달한다.
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
import { join } from 'node:path';
import { planScans } from './lib/schedule';
import { runMainLoop } from './lib/main-loop';
import { QuietWindowError } from './lib/quiet-window';
import { captureHalt } from './lib/halt';
import { pathToFileURL } from 'node:url';
import { failureDetails } from './lib/failure';
import { openRuntimeCollectorStore } from './src/deepseek-web/runtime-store';
import { stateDir } from './src/deepseek-web/config';
import { isolatedBrowser, isolatedContext, mediateBrowser } from './src/offers/browser';
import { assertOfficialAccount, recordSocial } from './src/offers/social';
import { instagramStopped, lockHost, offerTransport, stopInstagram } from './src/offers/transport';
import { offerConfig } from './src/offers/config';
import { enqueueSource } from './src/offers/frontier';

// Legacy flag only: dry-run never reaches Instagram. Reject unknown values.
export function externalDryRun(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.AGAMAJUNG_EXTERNAL_DRY_RUN;
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('AGAMAJUNG_EXTERNAL_DRY_RUN은 0 또는 1이어야 합니다.');
}

const DRY_RUN_NOTICE = '외부 수집은 npm run collector:worker -- discover --dry-run 으로 이관되었습니다.';

export async function main() {
  if (externalDryRun()) { console.error(DRY_RUN_NOTICE); return; }
  const crawlerDir = import.meta.dirname;
  await initHealth(crawlerDir);
  loadEnvironment(crawlerDir);
  if (externalDryRun()) { console.error(DRY_RUN_NOTICE); return; }
  const enabled = !!process.env.COLLECTOR_DB;
  const endpoint = process.env.AGAMAJUNG_API_URL, token = process.env.INGEST_TOKEN;
  if (!enabled && (!endpoint || !token)) throw new Error('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  const api = !enabled ? new URL('/api/v1/ingest', endpoint) : null;
  if (api && (api.username || api.password || api.protocol !== 'https:' && !(api.protocol === 'http:' &&
      ['localhost','127.0.0.1','[::1]'].includes(api.hostname)))) throw new Error('외부 API는 HTTPS가 필요합니다.');
  const { settings, accounts } = await loadConfig(crawlerDir);
  const state = await CrawlerState.open(statePath(crawlerDir));
  const username = process.env.AGAMAJUNG_IG_USER ?? 'agamajung';
  if (enabled && username !== 'agamajung') throw new HaltError('challenge');
  const store = enabled ? openRuntimeCollectorStore() : null, dir = stateDir();
  if (store && instagramStopped(store)) { store.close(); return; }
  const config = store && offerConfig(), transport = store && offerTransport(store, dir);
  const checkStop = () => { if (store && instagramStopped(store)) throw new HaltError('blocked'); };

  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  health('run_start', { seeds: accounts.seed_accounts.length, ocr: settings.ocr.enabled, follow_daily_cap: settings.follow.daily_cap, poll: settings.poll_interval_minutes.join('-') });
  let release: Awaited<ReturnType<typeof lockHost>> | undefined;
  try {
    if (store) release = await lockHost(join(dir, 'host-locks'), 'instagram-session-owner', AbortSignal.timeout(15_000)).catch(() => undefined);
    if (store && !release) return;
    await runMainLoop({ quietWindows: settings.quiet_windows, pollMinutes: settings.poll_interval_minutes, once: process.env.AGAMAJUNG_ONCE === '1' }, {
      now: Date.now,
      random: Math.random,
      sleep,
      schedule: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
      stopped: () => stopped,
      open: check => store && config && transport ? launchBrowser(crawlerDir, () => { check(); checkStop(); }, {
        launch: isolatedBrowser, context: isolatedContext,
        install: context => mediateBrowser(context, { store, dir, transport, lane: 'instagram', onRedirect: (parent, destination) => {
          store.transaction(() => enqueueSource(store, config, { parent, destination, source: 'instagram', category: '',
            relation: 'redirect', locator: 'location', depth: 1 }));
        } }),
      }) : launchBrowser(crawlerDir, check),
      login: async ({ context, page, sessionFile }, check) => {
        await ensureLogin(context, page, settings, username, sessionFile, check);
        if (store) await assertOfficialAccount(page);
      },
      close: async ({ context, browser }) => { try { await context.close(); } finally { await browser.close(); } },
      save: () => state.save(),
      flush: flushHealth,
      log: health,
      isFatal: error => error instanceof HaltError || error instanceof IngestError || error instanceof SessionError,
      onFatal: async (error, session, signal) => {
        if (error instanceof HaltError) {
          if (store && error.reason === 'challenge') stopInstagram(store, dir, 'checkpoint');
          process.exitCode = 75;
          await captureHalt(crawlerDir, error.reason, session?.diagnosticPage, signal);
        }
      },
      cycle: async ({ context, page, sessionFile }, check) => {
        check();
        checkStop();
        if (store) await assertOfficialAccount(page);

        await syncFollowing(page, { state, settings, username }, check);
        check();
        const signals = await readSignals(page, settings, username);
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
            const settingsForAccount = { account, crawlerDir, state, settings, scanPosts: job.posts, scanStories: job.stories,
              collectImages: imagePolicy.get(account.toLowerCase()) ?? true };
            const collected = store ? await collectAccount(page, { ...settingsForAccount,
              handoff: async item => { checkStop(); await assertOfficialAccount(page); recordSocial(store, item); } }) :
              await collectAccount(page, { ...settingsForAccount, api: api!, token: token! });
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
    await release?.();
    store?.close();
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
