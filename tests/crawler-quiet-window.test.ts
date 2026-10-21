import { afterEach, expect, test, vi } from 'vitest';
import settingsJson from '../crawler/config/settings.json';
import { parseSettings } from '../crawler/lib/config';
import { DEFAULT_QUIET_WINDOW, parseQuietWindow, QuietWindowError, quietWindowAt } from '../crawler/lib/quiet-window';
import { runMainLoop } from '../crawler/lib/main-loop';
import { ensureLogin, guardPage, HaltError, launchBrowser } from '../crawler/lib/browser';
import { mockPage } from './helpers/page';
import type { BrowserContext } from 'playwright';

const at = (local: string) => Date.parse(`${local}+09:00`);
const window = DEFAULT_QUIET_WINDOW;
afterEach(() => { vi.useRealTimers(); });

test.each([
  ['2026-10-21T06:44:59.999', false],
  ['2026-10-21T06:45:00.000', true],
  ['2026-10-21T07:15:00.000', true],
  ['2026-10-21T07:59:59.999', true],
  ['2026-10-21T08:00:00.000', false],
  ['2026-10-21T23:00:00.000', false],
])('KST default window at %s is active=%s', (local, active) => {
  const result = quietWindowAt(window, at(local));
  expect(result.active).toBe(active);
  expect(result.endAt).toBe(active ? at('2026-10-21T08:00:00') : null);
});

test.each([
  ['2026-10-21T22:59:59.999', false, null],
  ['2026-10-21T23:00:00.000', true, '2026-10-22T02:00:00'],
  ['2026-10-22T00:00:00.000', true, '2026-10-22T02:00:00'],
  ['2026-10-22T01:59:59.999', true, '2026-10-22T02:00:00'],
  ['2026-10-22T02:00:00.000', false, null],
])('midnight-crossing window at %s is active=%s', (local, active, end) => {
  const result = quietWindowAt({ ...window, start: '23:00', end: '02:00' }, at(local));
  expect(result.active).toBe(active);
  expect(result.endAt).toBe(end ? at(end) : null);
});

test('next start advances by KST calendar day at the inclusive boundary', () => {
  expect(quietWindowAt(window, at('2026-12-31T06:44:59')).nextStartAt).toBe(at('2026-12-31T06:45:00'));
  expect(quietWindowAt(window, at('2026-12-31T06:45:00')).nextStartAt).toBe(at('2027-01-01T06:45:00'));
});

test('settings default, configured window and env override are validated without reading process env', () => {
  const { quiet_window: omitted, ...legacy } = settingsJson;
  expect(omitted.start).toBe('06:45');
  expect(parseSettings(legacy).quiet_window).toEqual(window);
  const raw = { ...settingsJson, quiet_window: { ...window, start: '22:00', end: '01:00', jitter_ms: [0, 5000] } };
  expect(parseSettings(raw).quiet_window).toMatchObject({ start: '22:00', end: '01:00', jitter_ms: [0, 5000] });
  expect(parseSettings(raw, { AGAMAJUNG_QUIET_WINDOW: '23:30-02:15' }).quiet_window).toEqual({ ...raw.quiet_window, start: '23:30', end: '02:15' });
  expect(() => parseSettings(raw, { AGAMAJUNG_QUIET_WINDOW: '' })).toThrow('AGAMAJUNG_QUIET_WINDOW');
  expect(() => parseSettings(raw, { AGAMAJUNG_QUIET_WINDOW: '24:00-08:00' })).toThrow('quiet_window');
});

test.each([
  { start: '6:45' }, { end: '08:60' }, { end: '06:45' },
  { timezone: 'UTC' }, { jitter_ms: [-1, 30] }, { jitter_ms: [30, 1] },
])('invalid quiet settings fail closed: %j', invalid => {
  expect(() => parseQuietWindow({ ...window, ...invalid })).toThrow('quiet_window');
});

function harness(local: string, quietWindow = window) {
  vi.useFakeTimers();
  vi.setSystemTime(at(local));
  let stopped = false;
  const session = { id: 1 };
  const deps = {
    now: Date.now,
    random: () => 0.5,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    schedule: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    stopped: () => stopped,
    open: vi.fn(async (check: () => void) => { check(); return session; }),
    login: vi.fn(async () => {}),
    cycle: vi.fn(async (_session: typeof session, check: () => void) => { check(); }),
    close: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    log: vi.fn(),
    isFatal: (error: unknown) => error instanceof HaltError,
  };
  return { deps, options: { quietWindow, pollMinutes: [1, 1] as [number, number], once: true }, stop: () => { stopped = true; } };
}

test('main loop skips browser, login, follow and scans until quiet end plus sampled jitter, even in once mode', async () => {
  const { deps, options } = harness('2026-10-21T07:59:59');
  const running = runMainLoop(options, deps);
  await vi.advanceTimersByTimeAsync(1000); // Exactly 08:00, still in resume jitter.
  expect(deps.open).not.toHaveBeenCalled();
  expect(deps.login).not.toHaveBeenCalled();
  expect(deps.cycle).not.toHaveBeenCalled();
  expect(deps.log).toHaveBeenCalledWith('quiet_window_enter', expect.objectContaining({ end_at: new Date(at('2026-10-21T08:00:00')).toISOString() }));
  await vi.advanceTimersByTimeAsync(15_499);
  expect(deps.login).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(deps.open).toHaveBeenCalledTimes(1);
  expect(deps.login).toHaveBeenCalledTimes(1);
  expect(deps.cycle).toHaveBeenCalledTimes(1);
  expect(deps.close).toHaveBeenCalledTimes(1);
  expect(deps.log.mock.calls.map(call => call[0])).toEqual(['quiet_window_enter', 'quiet_window_exit']);
  expect(vi.getTimerCount()).toBe(0);
});

test('main loop starts immediately outside the window, including the exact end', async () => {
  const { deps, options } = harness('2026-10-21T08:00:00');
  await runMainLoop(options, deps);
  expect(deps.login).toHaveBeenCalledTimes(1);
  expect(deps.cycle).toHaveBeenCalledTimes(1);
  expect(deps.log).not.toHaveBeenCalled();
});

test('a running cycle closes the browser at quiet start and blocks the next action after a delay', async () => {
  const { deps, options } = harness('2026-10-21T06:44:59');
  const igAction = vi.fn();
  let attempts = 0;
  deps.cycle.mockImplementation(async (_session, check) => {
    attempts++;
    if (attempts === 1) await deps.sleep(2000);
    check();
    igAction();
  });
  const running = runMainLoop(options, deps);
  await vi.advanceTimersByTimeAsync(999);
  expect(deps.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(deps.close).toHaveBeenCalledTimes(1);
  expect(deps.log.mock.calls[0][0]).toBe('quiet_window_enter');
  await vi.advanceTimersByTimeAsync(1000);
  expect(igAction).not.toHaveBeenCalled();
  expect(deps.login).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(75 * 60_000 + 14_500);
  await running;
  expect(deps.login).toHaveBeenCalledTimes(2);
  expect(igAction).toHaveBeenCalledTimes(1);
  expect(deps.close).toHaveBeenCalledTimes(2);
});

test('polling idle time also closes at the boundary and shutdown interrupts quiet sleep', async () => {
  const { deps, options, stop } = harness('2026-10-21T06:44:59');
  const running = runMainLoop({ ...options, once: false }, deps);
  await vi.advanceTimersByTimeAsync(1000);
  expect(deps.close).toHaveBeenCalledTimes(1);
  expect(deps.cycle).toHaveBeenCalledTimes(1);
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  await running;
  expect(deps.log.mock.calls.map(call => call[0])).toEqual(['quiet_window_enter']);
  expect(vi.getTimerCount()).toBe(0);
});

test('main loop waits across midnight before opening a session', async () => {
  const { deps, options } = harness('2026-12-31T23:59:59', { ...window, start: '23:00', end: '00:00', jitter_ms: [1000, 1000] });
  const running = runMainLoop(options, deps);
  await vi.advanceTimersByTimeAsync(1999);
  expect(deps.login).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(deps.login).toHaveBeenCalledTimes(1);
});

test('quiet interruption during browser creation never calls login and cleans up the returned browser', async () => {
  const { deps, options, stop } = harness('2026-10-21T06:44:59');
  deps.open.mockImplementation(async () => { await deps.sleep(2000); return { id: 1 }; });
  const running = runMainLoop(options, deps);
  await vi.advanceTimersByTimeAsync(2000);
  expect(deps.login).not.toHaveBeenCalled();
  expect(deps.close).toHaveBeenCalledTimes(1);
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  await running;
});

test('security halts are never retried as quiet interruptions', async () => {
  const { deps, options } = harness('2026-10-21T06:44:59');
  deps.cycle.mockImplementation(async () => { vi.setSystemTime(at('2026-10-21T06:45:00')); throw new HaltError('challenge'); });
  await expect(runMainLoop(options, deps)).rejects.toBeInstanceOf(HaltError);
  expect(deps.login).toHaveBeenCalledTimes(1);
  expect(deps.close).toHaveBeenCalledTimes(1);
});

test.each(['challenge', 'blocked', 'login'] as const)('halt %s is diagnosed before close and survives every cleanup failure', async reason => {
  const { deps, options } = harness('2026-10-21T12:00:00');
  const error = new HaltError(reason);
  deps.login.mockRejectedValue(error);
  deps.close.mockRejectedValue(new Error('close failed'));
  deps.save.mockRejectedValue(new Error('save failed'));
  deps.flush.mockRejectedValue(new Error('flush failed'));
  const onFatal = vi.fn(async () => {
    expect(deps.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    throw new Error('diagnostics failed');
  });
  await expect(runMainLoop(options, { ...deps, onFatal })).rejects.toBe(error);
  expect(onFatal).toHaveBeenCalledWith(error, { id: 1 });
  expect(deps.open).toHaveBeenCalledTimes(1);
  expect(deps.login).toHaveBeenCalledTimes(1);
  expect(deps.cycle).not.toHaveBeenCalled();
  expect(deps.close).toHaveBeenCalledTimes(1);
  expect(deps.save).toHaveBeenCalledTimes(1);
  expect(deps.flush).toHaveBeenCalledTimes(1);
});

test('cycle halts are diagnosed while the session is still open', async () => {
  const { deps, options } = harness('2026-10-21T12:00:00');
  const error = new HaltError('login');
  deps.cycle.mockRejectedValue(error);
  const onFatal = vi.fn(async () => { expect(deps.close).not.toHaveBeenCalled(); });
  await expect(runMainLoop(options, { ...deps, onFatal })).rejects.toBe(error);
  expect(onFatal).toHaveBeenCalledWith(error, { id: 1 });
  expect(deps.cycle).toHaveBeenCalledTimes(1);
  expect(deps.close).toHaveBeenCalledTimes(1);
});

test('cached and chained page locators gate navigation, login, follow, story and scan methods at the boundary', async () => {
  let now = at('2026-10-21T06:44:59.999');
  const check = () => { if (quietWindowAt(window, now).active) throw new QuietWindowError(); };
  const { page, goto } = mockPage(() => [{ name: 'Follow' }]);
  const guarded = guardPage(page, check);
  const cached = guarded.getByRole('button', { name: /Follow/ }).first();
  await guarded.goto('https://www.instagram.com/');
  now++;
  expect(() => guarded.goto('https://www.instagram.com/')).toThrow(QuietWindowError);
  expect(() => cached.click()).toThrow(QuietWindowError);
  expect(() => cached.fill('offline-only')).toThrow(QuietWindowError);
  expect(() => cached.evaluateAll(() => [])).toThrow(QuietWindowError);
  expect(() => guarded.locator('a')).toThrow(QuietWindowError);
  expect(goto).toHaveBeenCalledTimes(1);
});

test('browser launch guard fails before Playwright or filesystem work', async () => {
  await expect(launchBrowser('/unused-offline-only', () => { throw new QuietWindowError(); })).rejects.toBeInstanceOf(QuietWindowError);
});

test('login cannot continue after its navigation delay enters quiet hours', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at('2026-10-21T06:44:59'));
  const { page, goto } = mockPage();
  const check = () => { if (quietWindowAt(window, Date.now()).active) throw new QuietWindowError(); };
  const context = { storageState: vi.fn() };
  const config = parseSettings(settingsJson);
  config.delays_ms.navigation = [2000, 2000];
  const loggingIn = ensureLogin(context as unknown as BrowserContext, guardPage(page, check), config, 'offline-only', '/unused');
  const rejected = expect(loggingIn).rejects.toBeInstanceOf(QuietWindowError);
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(goto).toHaveBeenCalledTimes(1);
  expect(page.getByRole).not.toHaveBeenCalled();
  expect(context.storageState).not.toHaveBeenCalled();
});
