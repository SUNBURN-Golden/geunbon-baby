import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import settingsJson from '../crawler/config/settings.json';
import { main } from '../crawler/index';
import { loadConfig, loadEnvironment, parseSettings } from '../crawler/lib/config';
import { CrawlerState, type AccountState } from '../crawler/lib/state';
import { assertHuman, ensureLogin, HaltError, launchBrowser } from '../crawler/lib/browser';
import { captureHalt } from '../crawler/lib/halt';
import { syncFollowing } from '../crawler/lib/following';
import { readSignals } from '../crawler/lib/activity';
import { collectAccount } from '../crawler/lib/collect';
import { loadExternalSettings, parseExternalSettings } from '../crawler/lib/external/sources';
import externalSettingsJson from '../crawler/config/external-sources.json';
import { maybeFollow } from '../crawler/lib/follow';
import { discoverSellers } from '../crawler/lib/discover';
import { saveSession, SessionError } from '../crawler/lib/session';
import { health, initHealth } from '../crawler/lib/health';

vi.mock('../crawler/lib/config', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/config')>(), loadConfig: vi.fn(), loadEnvironment: vi.fn() }));
vi.mock('../crawler/lib/browser', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/browser')>(), launchBrowser: vi.fn(), ensureLogin: vi.fn(), assertHuman: vi.fn() }));
vi.mock('../crawler/lib/halt', () => ({ captureHalt: vi.fn() }));
vi.mock('../crawler/lib/following', () => ({ syncFollowing: vi.fn() }));
vi.mock('../crawler/lib/health', () => ({ initHealth: vi.fn(), health: vi.fn(), flushHealth: vi.fn() }));
vi.mock('../crawler/lib/activity', () => ({ readSignals: vi.fn() }));
vi.mock('../crawler/lib/collect', () => ({ collectAccount: vi.fn() }));
vi.mock('../crawler/lib/external/sources', () => ({ loadExternalSettings: vi.fn(), parseExternalSettings: vi.fn() }));
vi.mock('../crawler/lib/follow', () => ({ maybeFollow: vi.fn() }));
vi.mock('../crawler/lib/discover', () => ({ discoverSellers: vi.fn() }));
vi.mock('../crawler/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/session')>(), saveSession: vi.fn() }));

const initialExitCode = process.exitCode;
const signalListeners = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, new Set(process.listeners(signal))]));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadEnvironment).mockImplementation(() => {});
  vi.stubEnv('COLLECTOR_DB', undefined);
  vi.stubEnv('AGAMAJUNG_IG_USER', undefined);
  vi.stubEnv('AGAMAJUNG_EXTERNAL_DRY_RUN', undefined);
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', undefined);
  vi.stubEnv('AGAMAJUNG_ONCE', undefined);
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

const realLoadConfig = async (dir: string) => (await vi.importActual<typeof import('../crawler/lib/config')>('../crawler/lib/config')).loadConfig(dir);
async function crawlerDir(seeds: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'crawler-run-'));
  await mkdir(join(dir, 'config'));
  await copyFile(resolve('crawler/config/settings.json'), join(dir, 'config/settings.json'));
  await writeFile(join(dir, 'config/accounts.json'), JSON.stringify({ seed_accounts: seeds }));
  return dir;
}
function clearConfigEnv() {
  for (const key of ['AGAMAJUNG_OCR', 'AGAMAJUNG_OCR_LANG', 'AGAMAJUNG_QUIET_WINDOWS', 'AGAMAJUNG_QUIET_WINDOW']) vi.stubEnv(key, undefined);
}

test('a string image policy fails before state, browser or network activity', async () => {
  healthyInstagram();
  clearConfigEnv();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
  const dir = await crawlerDir([{ handle: 'seller', scope: 'kr', verified: true, follow: false, collect_images: 'false' }]);
  try {
    vi.mocked(loadConfig).mockImplementationOnce(() => realLoadConfig(dir));
    await expect(main()).rejects.toThrow('seed_accounts[0].collect_images');
    for (const operation of [CrawlerState.open, launchBrowser, ensureLogin, syncFollowing, readSignals, collectAccount, fetch]) expect(operation).not.toHaveBeenCalled();
    expect(vi.mocked(health).mock.calls.some(([event]) => event === 'run_start')).toBe(false);
    expect(initHealth).toHaveBeenCalledOnce();
    expect(vi.mocked(initHealth).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(loadConfig).mock.invocationCallOrder[0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real configuration and scheduling preserve false and default omitted image policies to true', async () => {
  healthyInstagram();
  clearConfigEnv();
  const dir = await crawlerDir([
    { handle: 'seller', scope: 'kr', verified: true, follow: false, collect_images: false },
    { handle: 'stokke', scope: 'global', verified: true, follow: false },
  ]);
  try {
    vi.mocked(loadConfig).mockImplementationOnce(() => realLoadConfig(dir));
    const records: Record<string, AccountState> = {};
    const account = vi.fn((handle: string) => (records[handle] ??= {}));
    vi.spyOn(CrawlerState, 'open').mockResolvedValue({
      save: vi.fn(async () => {}), followingHandles: [], countDay: () => 0,
      account, isFollowing: (handle: string) => account(handle).following === true,
    } as unknown as CrawlerState);
    vi.mocked(collectAccount).mockResolvedValue({ posts: 0, stories: 0 });
    await main();
    const { page } = await vi.mocked(launchBrowser).mock.results[0].value;
    expect(account).toHaveBeenCalledWith('seller');
    expect(account).toHaveBeenCalledWith('stokke');
    expect(health).toHaveBeenCalledWith('queue', expect.objectContaining({ size: 2 }));
    expect(collectAccount).toHaveBeenCalledTimes(2);
    expect(collectAccount).toHaveBeenCalledWith(page, expect.objectContaining({ account: 'seller', scanPosts: true, collectImages: false }));
    expect(collectAccount).toHaveBeenCalledWith(page, expect.objectContaining({ account: 'stokke', scanPosts: true, collectImages: true }));
    expect(health).not.toHaveBeenCalledWith('error', expect.objectContaining({ scope: 'collect' }));
    expect(health).toHaveBeenCalledWith('poll', expect.anything());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

type FlagSource = 'injected' | 'env-file';
type ExternalConfig = 'enabled' | 'disabled' | 'source-error' | 'missing';

function externalConfig(variant: ExternalConfig) {
  if (variant === 'source-error' || variant === 'missing') {
    vi.mocked(loadExternalSettings).mockRejectedValue(Object.assign(new Error(variant), variant === 'missing' ? { code: 'ENOENT' } : {}));
    return;
  }
  vi.mocked(loadExternalSettings).mockResolvedValue({
    ...externalSettingsJson,
    jitter_ms: [0, 1500],
    sources: [{ id: 'pangpang', enabled: variant === 'enabled', origin: 'https://09pangpang.com', entries: ['/'], render: false, item_selector: '' }],
  });
}

function dryRunFlag(source: FlagSource, value = '1') {
  if (source === 'injected') vi.stubEnv('AGAMAJUNG_EXTERNAL_DRY_RUN', value);
  else vi.mocked(loadEnvironment).mockImplementation(() => { vi.stubEnv('AGAMAJUNG_EXTERNAL_DRY_RUN', value); });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function expectNoInstagram(source: FlagSource) {
  for (const operation of [loadConfig, CrawlerState.open, launchBrowser, ensureLogin, syncFollowing, readSignals,
    collectAccount, maybeFollow, discoverSellers, assertHuman, saveSession, fetch, loadExternalSettings, parseExternalSettings]) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
  expect(vi.mocked(health).mock.calls.some(([event]) => event === 'run_start' || event === 'quiet_window_enter')).toBe(false);
  if (source === 'injected') {
    expect(initHealth).not.toHaveBeenCalled();
    expect(loadEnvironment).not.toHaveBeenCalled();
  } else {
    expect(initHealth).toHaveBeenCalledOnce();
    expect(loadEnvironment).toHaveBeenCalledOnce();
  }
}

const dryRunCases = (['injected', 'env-file'] as const).flatMap(source =>
  (['present', 'missing', 'invalid-url'] as const).flatMap(credentials =>
    [true, false].flatMap(password =>
      [true, false].flatMap(once =>
        (['outside', 'inside', 'boundary'] as const).map(clock => ({ source, credentials, password, once, clock }))))));

test.each(dryRunCases)('external dry-run never enters Instagram: $source, credentials=$credentials, password=$password, once=$once, clock=$clock', async ({ source, credentials, password, once, clock }) => {
  healthyInstagram();
  if (credentials === 'missing') {
    vi.stubEnv('AGAMAJUNG_API_URL', undefined);
    vi.stubEnv('INGEST_TOKEN', undefined);
  } else if (credentials === 'invalid-url') vi.stubEnv('AGAMAJUNG_API_URL', 'http://example.invalid/');
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', password ? 'offline-password' : undefined);
  vi.stubEnv('AGAMAJUNG_ONCE', once ? '1' : undefined);
  if (clock === 'inside') vi.setSystemTime(new Date('2026-10-21T13:30:00+09:00'));
  if (clock === 'boundary') {
    vi.setSystemTime(new Date('2026-10-21T12:59:59+09:00'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  }
  externalConfig('enabled');
  const notice = dryRunFlag(source);
  // Await directly: waiting until quiet hours end must never pass as dry-run.
  await main();
  expectNoInstagram(source);
  expect(notice).toHaveBeenCalledExactlyOnceWith('외부 수집은 npm run collector:worker -- discover --dry-run 으로 이관되었습니다.');
});

const externalCases = (['injected', 'env-file'] as const).flatMap(source =>
  (['enabled', 'disabled', 'source-error', 'missing'] as const).map(config => ({ source, config })));

test.each(externalCases)('external dry-run ignores legacy config: $source, $config', async ({ source, config }) => {
  healthyInstagram();
  externalConfig(config);
  dryRunFlag(source);
  await main();
  expectNoInstagram(source);
});

const invalidCases = (['injected', 'env-file'] as const).flatMap(source =>
  ['true', 'yes', ' 1', '2', '1\n'].map(value => ({ source, value })));

test.each(invalidCases)('invalid external dry-run fails before Instagram: $source, $value', async ({ source, value }) => {
  healthyInstagram();
  dryRunFlag(source, value);
  await expect(main()).rejects.toThrow('AGAMAJUNG_EXTERNAL_DRY_RUN은 0 또는 1이어야 합니다.');
  expectNoInstagram(source);
});

test('deprecated external dry-run exits before configuration, state, credentials or Instagram', async () => {
  healthyInstagram();
  vi.stubEnv('AGAMAJUNG_API_URL', undefined);
  vi.stubEnv('INGEST_TOKEN', undefined);
  dryRunFlag('injected');
  await main();
  expectNoInstagram('injected');
});

test('Instagram runs independently after external collection migration',async()=>{healthyInstagram();await main();expect(launchBrowser).toHaveBeenCalledOnce();expect(vi.mocked(health).mock.calls.some(([event])=>event==='poll')).toBe(true);});

test.each(['0', ''])('external dry-run=%j preserves the healthy Instagram cycle', async value => {
  healthyInstagram();
  vi.stubEnv('AGAMAJUNG_EXTERNAL_DRY_RUN', value);
  await main();
  expect(launchBrowser).toHaveBeenCalledOnce();
  expect(vi.mocked(health).mock.calls.some(([event]) => event === 'poll')).toBe(true);
});
