import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrawlerState } from '../crawler/lib/state';
import { jitter, sleep } from '../crawler/lib/util';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crawler-state-')); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
test('reserves caps before actions and keeps counters, candidates, dedupe and pacing after restart', async () => {
  const file = join(dir, 'state.json');
  const state = await CrawlerState.open(file);
  expect(await state.reserve('follow', { hourly: 1, daily: 2 })).toBe(true);
  expect(await state.reserve('follow', { hourly: 1, daily: 2 })).toBe(false);
  state.nextFollowAt = '2026-10-22T00:00:00Z';
  state.markSeen('post'); state.markDiscoverySeen('discovery');
  state.addCandidate('seller', '#공구', 'discovery', ['Stokke']);
  state.discoveryCursor = 3;
  await state.save();
  const reopened = await CrawlerState.open(file);
  expect(reopened.countHour('follow')).toBe(1);
  expect(reopened.countDay('follow')).toBe(1);
  expect(reopened.nextFollowAt).toBe(state.nextFollowAt);
  expect(reopened.isSeen('post')).toBe(true);
  expect(reopened.isSeen('discovery')).toBe(false);
  expect(reopened.isDiscoverySeen('discovery')).toBe(true);
  expect(reopened.candidates[0].handle).toBe('seller');
  expect(reopened.followingHandles).toEqual([]);
  expect(reopened.discoveryCursor).toBe(3);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
test('KST hour/day caps roll over independently across restart', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T13:59:00Z')); // 22:59 KST
  let state = await CrawlerState.open(join(dir, 'state.json'));
  expect(await state.reserve('follow', { hourly: 1, daily: 2 })).toBe(true);
  vi.setSystemTime(new Date('2026-10-21T14:01:00Z'));
  state = await CrawlerState.open(join(dir, 'state.json'));
  expect(await state.reserve('follow', { hourly: 1, daily: 2 })).toBe(true);
  vi.setSystemTime(new Date('2026-10-21T14:59:00Z'));
  expect(state.canSpend('follow', { daily: 2 })).toBe(false);
  vi.setSystemTime(new Date('2026-10-21T15:01:00Z')); // midnight KST
  expect(await state.reserve('follow', { hourly: 1, daily: 2 })).toBe(true);
});
test('zero cap disables an action and corrupted state fails closed', async () => {
  const file = join(dir, 'state.json');
  const state = await CrawlerState.open(file);
  expect(await state.reserve('follow', { daily: 0 })).toBe(false);
  await writeFile(file, '{');
  await expect(CrawlerState.open(file)).rejects.toThrow('상태');
  await writeFile(file, JSON.stringify({ hourly: { invalid: -1 } }));
  await expect(CrawlerState.open(file)).rejects.toThrow('상태');
});
test('jitter spans configured bounds and sleep waits for the sampled duration', async () => {
  vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValue(0.5);
  expect(jitter(120, 420)).toBe(120);
  expect(jitter(120, 420)).toBeCloseTo(419.7);
  vi.useFakeTimers();
  let done = false;
  const waiting = sleep(100, 300).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(199); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await waiting; expect(done).toBe(true);
});
test('candidate hits merge samples without following the candidate', async () => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  expect(state.addCandidate('seller', '#공구', 'a', ['A'])).toBe(true);
  expect(state.addCandidate('seller', '#육아템공구', 'b', ['B'])).toBe(false);
  await state.save();
  expect(state.candidates[0]).toMatchObject({ hits: 2, sample_urls: ['a', 'b'], matched_models: ['A', 'B'] });
  expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).seen).toEqual([]);
});
