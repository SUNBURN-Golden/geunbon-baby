import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import settingsJson from '../crawler/config/settings.json';
import { parseSettings, type SeedAccount } from '../crawler/lib/config';
import { maybeFollow } from '../crawler/lib/follow';
import { CrawlerState } from '../crawler/lib/state';
import { HaltError } from '../crawler/lib/browser';
import { mockPage } from './helpers/page';
vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));
let dir: string;
const settings = () => parseSettings(settingsJson);
const seed = (handle = 'stokke'): SeedAccount => ({ handle, brand: 'Stokke', scope: 'global', verified: true, follow: true, note: '' });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crawler-follow-')); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T00:00:00Z')); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
test('follows at most once and persists sampled delay across restart', async () => {
  const file = join(dir, 'state.json');
  const state = await CrawlerState.open(file);
  let followed = false;
  const { page, goto } = mockPage(selector => selector === 'role:button' ? [{ name: followed ? '팔로잉' : '팔로우', click: () => { followed = true; } }] : []);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  expect(await maybeFollow(page, { accounts: [seed()], settings: settings(), state })).toBe('followed');
  expect(state.countDay('follow')).toBe(1);
  expect(state.nextFollowAt).toBe('2026-10-21T00:04:30.000Z');
  const reopened = await CrawlerState.open(file);
  expect(reopened.isFollowing('stokke')).toBe(true);
  vi.setSystemTime(new Date('2026-10-21T00:04:29Z'));
  expect(await maybeFollow(page, { accounts: [seed('other')], settings: settings(), state: reopened })).toBe('resting');
  expect(goto).toHaveBeenCalledTimes(1);
});
test.each(['hourly', 'daily'] as const)('%s follow cap prevents navigation', async kind => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  const config = settings();
  config.follow.daily_cap = 2; config.hourly_caps.follows = 2;
  state.spend('follow'); state.spend('follow');
  if (kind === 'daily') { vi.setSystemTime(new Date('2026-10-21T01:00:00Z')); }
  const { page, goto } = mockPage();
  expect(await maybeFollow(page, { accounts: [seed()], settings: config, state })).toBe('capped');
  expect(goto).not.toHaveBeenCalled();
});
test('unverified and discovered candidates are not auto-followed', async () => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  state.addCandidate('seller', '#공구', 'url', []);
  const { page, goto } = mockPage();
  expect(await maybeFollow(page, { accounts: [{ ...seed(), verified: false }], settings: settings(), state })).toBe('none');
  expect(goto).not.toHaveBeenCalled();
});
test('an ambiguous click failure still consumes and persists the follow attempt', async () => {
  const file = join(dir, 'state.json');
  const state = await CrawlerState.open(file);
  const { page } = mockPage(selector => selector === 'role:button' ? [{ name: 'Follow', click: () => { throw new Error('lost response'); } }] : []);
  await expect(maybeFollow(page, { accounts: [seed()], settings: settings(), state })).rejects.toThrow('lost response');
  const reopened = await CrawlerState.open(file);
  expect(reopened.countHour('follow')).toBe(1);
  expect(reopened.nextFollowAt).toBeTruthy();
});
test('a challenge immediately halts before any follow click', async () => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  const { page } = mockPage(selector => selector === 'text' ? [{ text: '보안 코드' }] : []);
  await expect(maybeFollow(page, { accounts: [seed()], settings: settings(), state })).rejects.toBeInstanceOf(HaltError);
  expect(state.countDay('follow')).toBe(0);
});
