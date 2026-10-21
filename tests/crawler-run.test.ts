import { afterEach, expect, test, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import settingsJson from '../crawler/config/settings.json';
import { main } from '../crawler/index';
import { loadConfig, parseSettings } from '../crawler/lib/config';
import { CrawlerState } from '../crawler/lib/state';
import { ensureLogin, HaltError, launchBrowser } from '../crawler/lib/browser';
import { captureHalt } from '../crawler/lib/halt';
import { syncFollowing } from '../crawler/lib/following';

vi.mock('../crawler/lib/config', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/config')>(), loadConfig: vi.fn() }));
vi.mock('../crawler/lib/browser', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/browser')>(), launchBrowser: vi.fn(), ensureLogin: vi.fn() }));
vi.mock('../crawler/lib/halt', () => ({ captureHalt: vi.fn() }));
vi.mock('../crawler/lib/following', () => ({ syncFollowing: vi.fn() }));
vi.mock('../crawler/lib/health', () => ({ initHealth: vi.fn(), health: vi.fn(), flushHealth: vi.fn() }));

const initialExitCode = process.exitCode;
const signalListeners = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, new Set(process.listeners(signal))]));
afterEach(() => {
  process.exitCode = initialExitCode;
  vi.useRealTimers();
  for (const [signal, listeners] of signalListeners) {
    for (const listener of process.listeners(signal)) if (!listeners.has(listener)) process.removeListener(signal, listener);
  }
});

test.each(['login', 'cycle'])('the orchestrator captures a %s halt before closing, using the unguarded diagnostic page', async phase => {
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
  const halt = new HaltError('login');
  if (phase === 'login') vi.mocked(ensureLogin).mockRejectedValue(halt);
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
  expect(captureHalt).toHaveBeenLastCalledWith(expect.stringMatching(/\/crawler$/), 'login', diagnosticPage);
  expect(closeContext).toHaveBeenCalledTimes(1);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(75);
});
