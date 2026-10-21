import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { ensureLogin, launchBrowser } from '../crawler/lib/browser';
import { hasSessionCookie, loadSession, saveSession, SessionError } from '../crawler/lib/session';
import { QuietWindowError } from '../crawler/lib/quiet-window';
import { loginFixture, loginSettings, sessionState } from './helpers/login';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename) };
});

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'crawler-session-'));
  file = join(dir, '.session', 'state.json');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});
const context = () => ({ storageState: vi.fn(async () => sessionState()) }) as unknown as BrowserContext;

async function seed() {
  await fs.mkdir(join(dir, '.session'));
  await fs.writeFile(file, JSON.stringify(sessionState()));
}

test('atomic session replacement preserves cookies, attributes and origin storage with private permissions', async () => {
  await seed();
  await fs.chmod(join(dir, '.session'), 0o777);
  await fs.chmod(file, 0o644);
  const original = await fs.open(file, 'r');
  const mock = context();
  const updated = sessionState();
  updated.cookies.push({ ...updated.cookies[0], name: 'csrftoken', value: 'offline-rotated-cookie', expires: 2_000_000_000, sameSite: 'Lax' });
  vi.mocked(mock.storageState).mockResolvedValue(updated);
  try {
    await saveSession(mock, file);
    expect(mock.storageState).toHaveBeenCalledWith();
    expect(await loadSession(file)).toEqual(updated);
    // An open descriptor still reads the old inode after replacement.
    expect(JSON.parse(await original.readFile('utf8'))).toEqual(sessionState());
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(dir, '.session'))).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(join(dir, '.session'))).toEqual(['state.json']);
  } finally { await original.close(); }
});

test.each(['storage', 'open', 'write', 'rename', 'interruption'] as const)('%s failure preserves the previous valid state and removes temporary files', async phase => {
  await seed();
  const old = await fs.readFile(file, 'utf8');
  const mock = context();
  const unsafe = new Error('offline-cookie-only offline-storage-only password=offline-password');
  if (phase === 'storage') vi.mocked(mock.storageState).mockRejectedValueOnce(unsafe);
  if (phase === 'open') vi.mocked(fs.open).mockRejectedValueOnce(unsafe);
  if (phase === 'write') {
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(unsafe);
      return handle;
    });
  }
  if (phase === 'rename') vi.mocked(fs.rename).mockRejectedValueOnce(unsafe);
  let checks = 0;
  const check = () => { if (phase === 'interruption' && ++checks === 4) throw new QuietWindowError(); };
  const error = await saveSession(mock, file, check).catch(error => error);
  expect(error).toBeInstanceOf(phase === 'interruption' ? QuietWindowError : SessionError);
  for (const secret of ['offline-cookie-only', 'offline-storage-only', 'offline-password']) expect(String(error)).not.toContain(secret);
  expect(await fs.readFile(file, 'utf8')).toBe(old);
  expect(await fs.readdir(join(dir, '.session'))).toEqual(['state.json']);
});

test('a guard tripped during storage capture prevents all filesystem writes', async () => {
  const mock = context();
  let quiet = false;
  vi.mocked(mock.storageState).mockImplementation(async () => { quiet = true; return sessionState(); });
  await expect(saveSession(mock, file, () => { if (quiet) throw new QuietWindowError(); })).rejects.toBeInstanceOf(QuietWindowError);
  expect(await fs.readdir(dir)).toEqual([]);
});

test.each(['{}', '{"cookies":[],"origins":"offline-storage-only"}', 'offline-cookie-only', '{"cookies":[{}],"origins":[]}'])('malformed state fails closed with a sanitized error', async raw => {
  await fs.mkdir(join(dir, '.session'));
  await fs.writeFile(file, raw);
  const error = await loadSession(file).catch(error => error);
  expect(error).toBeInstanceOf(SessionError);
  expect(String(error)).not.toContain('offline-storage-only');
  expect(String(error)).not.toContain('offline-cookie-only');
  expect(await fs.readFile(file, 'utf8')).toBe(raw);
});

test('missing state is first run; other read failures are not silently ignored', async () => {
  expect(await loadSession(file)).toBeUndefined();
  await fs.writeFile(join(dir, 'not-directory'), 'fixture');
  await expect(loadSession(join(dir, 'not-directory', 'state.json'))).rejects.toBeInstanceOf(SessionError);
});

test('malformed session prevents launching a browser', async () => {
  await fs.mkdir(join(dir, '.session'));
  await fs.writeFile(file, '{}');
  const calls = vi.mocked(chromium.launch).mock.calls.length;
  await expect(launchBrowser(dir)).rejects.toBeInstanceOf(SessionError);
  expect(vi.mocked(chromium.launch).mock.calls.length).toBe(calls);
});

test('a second browser context restores the saved state before its first page and authenticates without a password', async () => {
  vi.useFakeTimers();
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'offline-password');
  const first = loginFixture();
  const loggingIn = ensureLogin(first.context, first.page, loginSettings(), 'offline-user', file);
  await vi.runAllTimersAsync();
  await loggingIn;
  const saved = await loadSession(file);
  const second = loginFixture({ restored: true });
  const newPage = vi.fn(async () => second.page);
  const restoredContext = { ...second.context, newPage };
  const newContext = vi.fn(async (options: { storageState?: unknown }) => {
    expect(options.storageState).toEqual(saved);
    expect(newPage).not.toHaveBeenCalled();
    return restoredContext;
  });
  const browser = { newContext, close: vi.fn() } as unknown as Browser;
  vi.mocked(chromium.launch).mockResolvedValueOnce(browser);
  // The remaining Page methods are inert mocks; no browser is launched.
  second.page.setDefaultTimeout = vi.fn();
  const restored = await launchBrowser(dir);
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', '');
  const reuse = ensureLogin(restored.context, restored.page, loginSettings(), 'offline-user', file);
  await vi.runAllTimersAsync();
  await reuse;
  expect(newContext).toHaveBeenCalledOnce();
  expect(newPage).toHaveBeenCalledOnce();
  expect(second.submit).not.toHaveBeenCalled();
  expect(second.fill).not.toHaveBeenCalled();
  expect(await loadSession(file)).toEqual(saved);
});

test('context restoration errors are sanitized and close the browser', async () => {
  await seed();
  const close = vi.fn(async () => {});
  const browser = { newContext: vi.fn(async () => { throw new Error('offline-cookie-only offline-storage-only'); }), close };
  vi.mocked(chromium.launch).mockResolvedValueOnce(browser as unknown as Browser);
  const error = await launchBrowser(dir).catch(error => error);
  expect(error).toBeInstanceOf(SessionError);
  expect(String(error)).not.toContain('offline-cookie-only');
  expect(close).toHaveBeenCalledOnce();
});

test('only a usable Instagram session cookie qualifies as authentication evidence', () => {
  const cookie = sessionState().cookies[0];
  expect(hasSessionCookie([cookie])).toBe(true);
  for (const patch of [{ value: '' }, { expires: 1 }, { domain: 'evilinstagram.com' }, { name: 'csrftoken' }, { path: '/accounts/login/' }]) {
    expect(hasSessionCookie([{ ...cookie, ...patch }])).toBe(false);
  }
});
