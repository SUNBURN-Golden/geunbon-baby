import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import settingsJson from '../crawler/config/settings.json';
import { parseSettings } from '../crawler/lib/config';
import { CrawlerState } from '../crawler/lib/state';
import { syncFollowing } from '../crawler/lib/following';
import { planScans } from '../crawler/lib/schedule';
import { HaltError } from '../crawler/lib/browser';
import { QuietWindowError } from '../crawler/lib/quiet-window';
import { sleep } from '../crawler/lib/util';
import { mockPage } from './helpers/page';

vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));
let dir: string;
const at = (local: string) => Date.parse(`${local}+09:00`);
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at('2026-10-21T12:00:00'));
  vi.mocked(sleep).mockImplementation(async () => {});
  dir = await mkdtemp(join(tmpdir(), 'crawler-following-'));
});
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const ctx = { state: await CrawlerState.open(join(dir, 'state.json')), settings: parseSettings(settingsJson) };
  ctx.settings.per_tick.max_accounts = 1;
  let batch = 0;
  const batches = [['/Seller.Mom/', '/seller.mom/', '/explore/', 'https://evil.test/fake/'], ['/another_seller/']];
  const scroll = vi.fn(() => { batch = Math.min(batch + 1, batches.length - 1); });
  const mock = mockPage(selector => {
    if (selector === 'role:link') return [{ name: '프로필', href: '/my_account/' }];
    if (selector === 'a[href="/my_account/following/"]') return [{}];
    if (selector === 'role:dialog') return batches[batch].map(href => ({ href, evaluate: scroll }));
    return [];
  });
  return { ctx, mock, scroll };
}

test('imports existing follows from all loaded batches, persists them, and schedules unseeded sellers with or without signals', async () => {
  const { ctx, mock, scroll } = await fixture();
  ctx.state.setFollowing('local_follow', true);
  await syncFollowing(mock.page, ctx);
  ctx.state = await CrawlerState.open(join(dir, 'state.json'));
  expect(ctx.state.followingHandles.sort()).toEqual(['another_seller', 'local_follow', 'seller.mom']);
  expect(ctx.state.lastFollowingSyncAttempt).toBe(new Date().toISOString());
  expect(scroll).toHaveBeenCalledTimes(3);
  expect(mock.goto.mock.calls.map(([url]) => url)).toEqual(['https://www.instagram.com/', 'https://www.instagram.com/my_account/']);
  expect(planScans({ storyAccounts: ['seller.mom'], freshAccounts: ['seller.mom'] }, ctx.state, [], ctx.settings)).toEqual([
    { account: 'seller.mom', posts: true, stories: true },
  ]);
  ctx.state.account('seller.mom').last_checked = new Date().toISOString();
  expect(planScans({ storyAccounts: ['seller.mom'], freshAccounts: [] }, ctx.state, [], ctx.settings)[0]).toEqual(
    { account: 'seller.mom', posts: false, stories: true },
  );
  ctx.settings.per_tick.max_accounts = 10;
  expect(planScans({ storyAccounts: [], freshAccounts: [] }, ctx.state, [], ctx.settings).map(job => job.account)).toEqual(['another_seller', 'local_follow']);
});

test('attempt limit survives failure, restart, and KST midnight and expires only after 24 hours', async () => {
  const { ctx } = await fixture();
  vi.setSystemTime(at('2026-10-21T23:59:00'));
  const missing = mockPage();
  await syncFollowing(missing.page, ctx); // Missing profile selector still consumes this attempt.
  ctx.state = await CrawlerState.open(join(dir, 'state.json'));
  const { mock } = await fixture();
  vi.setSystemTime(at('2026-10-22T00:01:00'));
  await syncFollowing(mock.page, ctx);
  expect(mock.goto).not.toHaveBeenCalled();
  vi.setSystemTime(at('2026-10-22T23:58:59.999'));
  await syncFollowing(mock.page, ctx);
  expect(mock.goto).not.toHaveBeenCalled();
  vi.setSystemTime(at('2026-10-22T23:59:00'));
  await syncFollowing(mock.page, ctx);
  expect(mock.goto).toHaveBeenCalledTimes(2);
});

test.each(['06:45:00', '13:00:00'])('quiet hours at %s block sync before navigation or spending any budget', async local => {
  const { ctx, mock } = await fixture();
  vi.setSystemTime(at(`2026-10-21T${local}`));
  await expect(syncFollowing(mock.page, ctx)).rejects.toBeInstanceOf(QuietWindowError);
  expect(mock.goto).not.toHaveBeenCalled();
  expect(ctx.state.lastFollowingSyncAttempt).toBeUndefined();
  expect(ctx.state.countHour('profile_visits')).toBe(0);
});

test('a navigation delay entering quiet hours prevents all further page operations and persists the attempt', async () => {
  const { ctx, mock } = await fixture();
  vi.setSystemTime(at('2026-10-21T06:44:59'));
  vi.mocked(sleep).mockImplementationOnce(async () => { vi.setSystemTime(at('2026-10-21T06:45:00')); });
  await expect(syncFollowing(mock.page, ctx)).rejects.toBeInstanceOf(QuietWindowError);
  expect(mock.goto).toHaveBeenCalledTimes(1);
  expect(mock.page.getByRole).not.toHaveBeenCalled();
  expect((await CrawlerState.open(join(dir, 'state.json'))).lastFollowingSyncAttempt).toBeDefined();
});

test('quiet interruption while scrolling preserves imported batches and blocks the next read', async () => {
  const { ctx, mock, scroll } = await fixture();
  vi.mocked(sleep).mockImplementation(async () => {
    if (scroll.mock.calls.length) vi.setSystemTime(at('2026-10-21T06:45:00'));
  });
  await expect(syncFollowing(mock.page, ctx)).rejects.toBeInstanceOf(QuietWindowError);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect((await CrawlerState.open(join(dir, 'state.json'))).followingHandles).toEqual(['seller.mom']);
});

test('profile visit cap blocks sync without consuming its daily attempt', async () => {
  const { ctx, mock } = await fixture();
  ctx.settings.hourly_caps.profile_visits = 0;
  await syncFollowing(mock.page, ctx);
  expect(mock.goto).not.toHaveBeenCalled();
  expect(ctx.state.lastFollowingSyncAttempt).toBeUndefined();
});

test('security halts propagate instead of being softened into a missing following list', async () => {
  const { ctx, mock } = await fixture();
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/challenge/'); });
  await expect(syncFollowing(mock.page, ctx)).rejects.toBeInstanceOf(HaltError);
});

test('the main loop resume guard also blocks sync during quiet-window jitter', async () => {
  const { ctx, mock } = await fixture();
  await expect(syncFollowing(mock.page, ctx, () => { throw new QuietWindowError(); })).rejects.toBeInstanceOf(QuietWindowError);
  expect(mock.goto).not.toHaveBeenCalled();
  expect(ctx.state.lastFollowingSyncAttempt).toBeUndefined();
});

test.each(['agamajung', 'x@y.test', 'agamajung?query', 'explore'])('missing profile candidates fall back only for a handle username: %s', async username => {
  const { ctx } = await fixture();
  const events = vi.spyOn(await import('../crawler/lib/health'), 'health');
  const mock = mockPage();
  await syncFollowing(mock.page, { ...ctx, username });
  if (username === 'agamajung') {
    expect(mock.goto.mock.calls.map(([url]) => url)).toEqual(['https://www.instagram.com/', 'https://www.instagram.com/agamajung/']);
    expect(events).toHaveBeenCalledWith('following_profile_fallback', { via: 'username' });
  } else {
    expect(mock.goto).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith('selector_miss', { scope: 'following_profile' });
    expect(events.mock.calls.some(([event]) => event === 'following_profile_fallback')).toBe(false);
  }
  events.mockRestore();
});
