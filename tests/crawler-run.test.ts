import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import settingsJson from '../crawler/config/settings.json';
import { main } from '../crawler/index';
import { loadConfig, parseSettings } from '../crawler/lib/config';
import { CrawlerState } from '../crawler/lib/state';
import { assertHuman, ensureLogin, HaltError, launchBrowser } from '../crawler/lib/browser';
import { captureHalt } from '../crawler/lib/halt';
import { syncFollowing } from '../crawler/lib/following';
import { readSignals } from '../crawler/lib/activity';
import { maybeFollow } from '../crawler/lib/follow';
import { discoverSellers } from '../crawler/lib/discover';
import { saveSession, SessionError } from '../crawler/lib/session';
import { health, initHealth } from '../crawler/lib/health';
import { runExternalSources } from '../crawler/lib/external/run';
import { IngestError } from '../crawler/lib/ingest';
import { loadExternalSettings, parseExternalSettings } from '../crawler/lib/external/sources';
import externalJson from '../crawler/config/external-sources.json';

vi.mock('../crawler/lib/config', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/config')>(), loadConfig: vi.fn() }));
vi.mock('../crawler/lib/browser', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/browser')>(), launchBrowser: vi.fn(), ensureLogin: vi.fn(), assertHuman: vi.fn() }));
vi.mock('../crawler/lib/halt', () => ({ captureHalt: vi.fn() }));
vi.mock('../crawler/lib/following', () => ({ syncFollowing: vi.fn() }));
vi.mock('../crawler/lib/health', () => ({ initHealth: vi.fn(), health: vi.fn(), flushHealth: vi.fn() }));
vi.mock('../crawler/lib/activity', () => ({ readSignals: vi.fn() }));
vi.mock('../crawler/lib/follow', () => ({ maybeFollow: vi.fn() }));
vi.mock('../crawler/lib/discover', () => ({ discoverSellers: vi.fn() }));
// main()은 외부 공구 모음 수집을 기본으로 먼저 호출한다. 모킹하지 않으면 PoliteFetcher의 대기가
// 가짜 타이머에서 끝나지 않고 tests/setup.ts의 fetch 차단이 IngestError를 낸다. 기존 단언은 바꾸지 않는다.
vi.mock('../crawler/lib/external/run', () => ({ runExternalSources: vi.fn() }));
// 설정 파일을 실제로 읽는 비동기 I/O는 vi.runAllTimersAsync()가 타이머를 비운 뒤에야 끝나 휴식 시간 경계 테스트를 멈춘다.
vi.mock('../crawler/lib/external/sources', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/external/sources')>(), loadExternalSettings: vi.fn() }));
vi.mock('../crawler/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/session')>(), saveSession: vi.fn() }));

const initialExitCode = process.exitCode;
const signalListeners = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, new Set(process.listeners(signal))]));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGAMAJUNG_IG_USER', undefined);
  vi.mocked(loadExternalSettings).mockResolvedValue(parseExternalSettings(externalJson));
  vi.mocked(runExternalSources).mockResolvedValue({ sources: 0, items_sent: 0, items_skipped: 0, candidates: 0 });
});
afterEach(() => {
  process.exitCode = initialExitCode;
  vi.useRealTimers();
  for (const [signal, listeners] of signalListeners) {
    for (const listener of process.listeners(signal)) if (!listeners.has(listener)) process.removeListener(signal, listener);
  }
});

test('health initializes before startup configuration can fail, without opening a browser', async () => {
  vi.stubEnv('AGAMAJUNG_API_URL', 'https://ingest.invalid/');
  vi.stubEnv('INGEST_TOKEN', 'offline-token');
  const failure = new SyntaxError('offline invalid config');
  vi.mocked(loadConfig).mockRejectedValueOnce(failure);
  await expect(main()).rejects.toBe(failure);
  expect(initHealth).toHaveBeenCalledOnce();
  expect(vi.mocked(initHealth).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(loadConfig).mock.invocationCallOrder[0]);
  expect(launchBrowser).not.toHaveBeenCalled();
  expect(ensureLogin).not.toHaveBeenCalled();
});

test.each(['login', 'challenge', 'cycle'])('the orchestrator captures a %s halt before closing, using the unguarded diagnostic page', async phase => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00+09:00'));
  vi.stubEnv('AGAMAJUNG_API_URL', 'https://ingest.invalid/');
  vi.stubEnv('INGEST_TOKEN', 'offline-token');
  vi.mocked(loadConfig).mockResolvedValue({
    settings: parseSettings(settingsJson),
    accounts: { seed_accounts: [], discovery: { hashtags: { base: [], brand: [], extra: [] } } },
  });
  const save = vi.fn(async () => { throw new Error('state save failed'); });
  vi.spyOn(CrawlerState, 'open').mockResolvedValue({ save } as unknown as CrawlerState);
  const page = {} as Page;
  const diagnosticPage = {} as Page;
  const closeContext = vi.fn(async () => { throw new Error('context close failed'); });
  const closeBrowser = vi.fn(async () => { throw new Error('browser close failed'); });
  vi.mocked(launchBrowser).mockResolvedValue({
    page, diagnosticPage, sessionFile: '/unused-offline-session',
    context: { close: closeContext } as unknown as BrowserContext,
    browser: { close: closeBrowser } as unknown as Browser,
  });
  const reason = phase === 'challenge' ? 'challenge' : 'login';
  const halt = new HaltError(reason);
  if (phase !== 'cycle') vi.mocked(ensureLogin).mockRejectedValue(halt);
  else {
    vi.mocked(ensureLogin).mockResolvedValue(undefined);
    vi.mocked(syncFollowing).mockRejectedValue(halt);
  }
  vi.mocked(captureHalt).mockImplementation(async () => {
    expect(process.exitCode).toBe(75);
    expect(closeContext).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
    throw new Error('diagnostics failed');
  });
  await expect(main()).rejects.toBe(halt);
  expect(captureHalt).toHaveBeenLastCalledWith(expect.stringMatching(/\/crawler$/), reason, diagnosticPage, expect.any(AbortSignal));
  expect(closeContext).toHaveBeenCalledTimes(1);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(75);
  expect(saveSession).not.toHaveBeenCalled();
});

test.each(['healthy', 'persistence', 'login', 'cycle', 'interrupted', 'security', 'persistence-quiet', 'login-persistence-quiet'] as const)('cycle session persistence is conditional on healthy execution: %s', async phase => {
  vi.useFakeTimers();
  const overlap = phase.endsWith('-quiet');
  if (overlap) vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.setSystemTime(new Date(overlap ? '2026-10-21T12:59:59+09:00' : '2026-10-21T12:00:00+09:00'));
  vi.stubEnv('AGAMAJUNG_API_URL', 'https://ingest.invalid/');
  vi.stubEnv('INGEST_TOKEN', 'offline-token');
  vi.stubEnv('AGAMAJUNG_ONCE', '1');
  vi.mocked(loadConfig).mockResolvedValue({
    settings: parseSettings(settingsJson),
    accounts: { seed_accounts: [], discovery: { hashtags: { base: [], brand: [], extra: [] } } },
  });
  const save = vi.fn(async () => {});
  vi.spyOn(CrawlerState, 'open').mockResolvedValue({ save, followingHandles: [], countDay: () => 0 } as unknown as CrawlerState);
  const closeContext = vi.fn(async () => {});
  const closeBrowser = vi.fn(async () => {});
  const page = {} as Page;
  const context = { close: closeContext } as unknown as BrowserContext;
  const file = '/unused-offline-session';
  vi.mocked(launchBrowser).mockResolvedValue({ page, diagnosticPage: page, sessionFile: file, context, browser: { close: closeBrowser } as unknown as Browser });
  vi.mocked(ensureLogin).mockResolvedValue(undefined);
  vi.mocked(syncFollowing).mockResolvedValue(undefined);
  vi.mocked(readSignals).mockResolvedValue({ storyAccounts: [], freshAccounts: [] });
  vi.mocked(maybeFollow).mockResolvedValue('none');
  vi.mocked(discoverSellers).mockResolvedValue(0);
  vi.mocked(assertHuman).mockResolvedValue(undefined);
  vi.mocked(saveSession).mockResolvedValue(undefined);
  vi.mocked(captureHalt).mockResolvedValue(undefined);
  const failure = phase.includes('persistence') ? new SessionError() : new HaltError(phase === 'security' ? 'challenge' : 'login');
  if (phase === 'login') vi.mocked(ensureLogin).mockRejectedValue(failure);
  if (phase === 'cycle') vi.mocked(readSignals).mockRejectedValue(failure);
  if (phase === 'security') vi.mocked(assertHuman).mockRejectedValue(failure);
  if (phase === 'persistence') vi.mocked(saveSession).mockRejectedValue(failure);
  if (overlap) {
    const operation = phase === 'persistence-quiet' ? vi.mocked(saveSession) : vi.mocked(ensureLogin);
    operation.mockImplementationOnce(async () => {
      // Fire the real loop boundary timer while persistence is in flight.
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      throw failure;
    });
  }
  if (phase === 'interrupted') vi.mocked(syncFollowing).mockImplementation(async () => { process.emit('SIGTERM'); });
  if (overlap) {
    const outcome = main().then(() => undefined, error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);
    expect(launchBrowser).toHaveBeenCalledOnce();
    expect(ensureLogin).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledWith('quiet_window_enter', expect.anything());
    expect(captureHalt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } else if (phase === 'healthy' || phase === 'interrupted') await main();
  else await expect(main()).rejects.toBe(failure);
  expect(ensureLogin).toHaveBeenCalledWith(context, page, expect.anything(), 'agamajung', file, expect.any(Function));
  if (phase === 'healthy' || phase === 'persistence' || phase === 'persistence-quiet') expect(saveSession).toHaveBeenCalledExactlyOnceWith(context, file, expect.any(Function), expect.any(Function));
  else expect(saveSession).not.toHaveBeenCalled();
  expect(vi.mocked(health).mock.calls.some(([event]) => event === 'poll')).toBe(phase === 'healthy');
  expect(closeContext).toHaveBeenCalledOnce();
  expect(closeBrowser).toHaveBeenCalledOnce();
});

// ── 외부 공구 모음 수집 연동 ──────────────────────────────────────────────────
function healthyInstagram() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00+09:00'));
  vi.stubEnv('AGAMAJUNG_API_URL', 'https://ingest.invalid/');
  vi.stubEnv('INGEST_TOKEN', 'offline-token');
  vi.stubEnv('AGAMAJUNG_ONCE', '1');
  vi.mocked(loadConfig).mockResolvedValue({ settings: parseSettings(settingsJson), accounts: { seed_accounts: [], discovery: { hashtags: { base: [], brand: [], extra: [] } } } });
  vi.spyOn(CrawlerState, 'open').mockResolvedValue({ save: vi.fn(async () => {}), followingHandles: [], countDay: () => 0 } as unknown as CrawlerState);
  const page = {} as Page;
  vi.mocked(launchBrowser).mockResolvedValue({ page, diagnosticPage: page, sessionFile: '/unused-offline-session', context: { close: vi.fn(async () => {}) } as unknown as BrowserContext, browser: { close: vi.fn(async () => {}) } as unknown as Browser });
  vi.mocked(ensureLogin).mockResolvedValue(undefined);
  vi.mocked(syncFollowing).mockResolvedValue(undefined);
  vi.mocked(readSignals).mockResolvedValue({ storyAccounts: [], freshAccounts: [] });
  vi.mocked(maybeFollow).mockResolvedValue('none');
  vi.mocked(discoverSellers).mockResolvedValue(0);
  vi.mocked(assertHuman).mockResolvedValue(undefined);
  vi.mocked(saveSession).mockResolvedValue(undefined);
  vi.mocked(captureHalt).mockResolvedValue(undefined);
}

test('external collection runs once before the browser opens, with live (non-dry) settings by default', async () => {
  healthyInstagram();
  await main();
  expect(runExternalSources).toHaveBeenCalledOnce();
  expect(runExternalSources).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, token: 'offline-token' }));
  expect(vi.mocked(runExternalSources).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(launchBrowser).mock.invocationCallOrder[0]);
  expect(health).toHaveBeenCalledWith('run_start', expect.objectContaining({ external: true, external_dry_run: false }));
});

test('a generic external failure does not stop the Instagram cycle', async () => {
  healthyInstagram();
  vi.mocked(runExternalSources).mockRejectedValue(new Error('parse failed'));
  await main();
  expect(health).toHaveBeenCalledWith('error', { scope: 'external' });
  expect(launchBrowser).toHaveBeenCalledOnce();
  expect(vi.mocked(health).mock.calls.some(([event]) => event === 'poll')).toBe(true);
});

test('an external ingest API error aborts before Instagram opens', async () => {
  healthyInstagram();
  const failure = new IngestError('수집 API 요청 실패(401)', 401);
  vi.mocked(runExternalSources).mockRejectedValue(failure);
  await expect(main()).rejects.toBe(failure);
  expect(launchBrowser).not.toHaveBeenCalled();
});

test('AGAMAJUNG_EXTERNAL=0 skips external collection entirely', async () => {
  healthyInstagram();
  vi.stubEnv('AGAMAJUNG_EXTERNAL', '0');
  await main();
  expect(runExternalSources).not.toHaveBeenCalled();
  expect(loadExternalSettings).not.toHaveBeenCalled();
  expect(launchBrowser).toHaveBeenCalledOnce();
});

test('AGAMAJUNG_EXTERNAL_DRY_RUN=1 passes dryRun to the collector', async () => {
  healthyInstagram();
  vi.stubEnv('AGAMAJUNG_EXTERNAL_DRY_RUN', '1');
  await main();
  expect(runExternalSources).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  expect(health).toHaveBeenCalledWith('run_start', expect.objectContaining({ external_dry_run: true }));
});

test('AGAMAJUNG_EXTERNAL_DRY_RUN=1 exits after the external run without touching Instagram', async () => {
  healthyInstagram();
  vi.stubEnv('AGAMAJUNG_EXTERNAL_DRY_RUN', '1');
  await main();
  expect(runExternalSources).toHaveBeenCalledOnce();
  expect(launchBrowser).not.toHaveBeenCalled();
  expect(ensureLogin).not.toHaveBeenCalled();
});
