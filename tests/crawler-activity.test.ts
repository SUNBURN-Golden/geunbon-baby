import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLogin, HaltError } from '../crawler/lib/browser';
import { readSignals } from '../crawler/lib/activity';
import { loginFixture, loginSettings } from './helpers/login';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crawler-activity-'));
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'offline-password');
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});
async function authenticate(mock: ReturnType<typeof loginFixture>) {
  const login = ensureLogin(mock.context, mock.page, loginSettings(), 'offline-user', join(dir, '.session', 'state.json'));
  await vi.runAllTimersAsync();
  await login;
}

test.each([true, false])('fresh login proceeds through readSignals using notification panel=%s', async panel => {
  const mock = loginFixture({ panel });
  await authenticate(mock);
  expect(mock.dismiss).toHaveBeenCalledTimes(2);
  const reading = readSignals(mock.page, loginSettings());
  await vi.runAllTimersAsync();
  expect(await reading).toEqual({ storyAccounts: ['story_seller'], freshAccounts: ['fresh_seller'] });
  expect(mock.goto.mock.calls.some(([url]) => url.includes('/accounts/activity/'))).toBe(!panel);
  expect(mock.submit).toHaveBeenCalledOnce();
});

test.each([true, false])('activity login redirect halts, including login form at home=%s', async rootLogin => {
  const mock = loginFixture({ bounceActivity: true, rootLogin });
  await authenticate(mock);
  const file = join(dir, '.session', 'state.json');
  const saved = await readFile(file, 'utf8');
  const rejected = expect(readSignals(mock.page, loginSettings())).rejects.toMatchObject({ reason: 'login' });
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.storageState).toHaveBeenCalledOnce();
  expect(await readFile(file, 'utf8')).toBe(saved);
});

test('a login form at home halts before clicking a notification control', async () => {
  const mock = loginFixture({ restored: true });
  await authenticate(mock);
  mock.setStage('login');
  const rejected = expect(readSignals(mock.page, loginSettings())).rejects.toBeInstanceOf(HaltError);
  await vi.runAllTimersAsync();
  await rejected;
  expect(mock.goto.mock.calls.some(([url]) => url.includes('/accounts/activity/'))).toBe(false);
  expect(mock.submit).not.toHaveBeenCalled();
});

test.each(['agamajung', 'x@y.test'])('story signals read alt-only trays and exclude self for handle login: %s', async username => {
  const { mockPage } = await import('./helpers/page');
  const { page } = mockPage(selector => selector === 'main [role="button"] img[alt], main li img[alt]' ? [
    { attrs: { alt: 'story_seller님의 프로필 사진' } }, { attrs: { alt: 'agamajung님의 프로필 사진' } },
  ] : []);
  const reading = readSignals(page, loginSettings(), username);
  await vi.runAllTimersAsync();
  expect((await reading).storyAccounts).toEqual(username === 'agamajung' ? ['story_seller'] : ['story_seller', 'agamajung']);
});
