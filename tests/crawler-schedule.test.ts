import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import settingsJson from '../crawler/config/settings.json';
import { loadConfig, parseSettings, type SeedAccount } from '../crawler/lib/config';
import { CrawlerState } from '../crawler/lib/state';
import { planScans } from '../crawler/lib/schedule';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crawler-schedule-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const seed: SeedAccount = { handle: 'stokke', brand: 'Stokke', scope: 'global', verified: true, follow: true, note: '' };
test('persistent signals trigger stories independently without repeated full profile scans', async () => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  const config = parseSettings(settingsJson);
  const now = Date.parse('2026-10-21T12:00:00Z');
  state.account('stokke').last_checked = new Date(now - 60000).toISOString();
  const signal = { storyAccounts: ['stokke', 'unknown'], freshAccounts: ['stokke'] };
  expect(planScans(signal, state, [seed], config, now)).toEqual([{ account: 'stokke', posts: false, stories: true }]);
  state.account('stokke').last_story_at = new Date(now).toISOString();
  expect(planScans(signal, state, [seed], config, now + 60000)).toEqual([]);
  expect(planScans(signal, state, [seed], config, now + 91 * 60000)[0]).toMatchObject({ posts: true, stories: true });
});
test('oldest profile gets priority without signals, including previously followed sellers', async () => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  state.setFollowing('seller', true);
  state.account('stokke').last_checked = '2026-10-20T00:00:00Z';
  expect(planScans({ storyAccounts: [], freshAccounts: [] }, state, [seed], parseSettings(settingsJson), Date.parse('2026-10-21T00:00:00Z'))[0].account).toBe('seller');
});
test('OCR is on by default, can be disabled by env, and suppresses story jobs', async () => {
  vi.stubEnv('AGAMAJUNG_OCR', '');
  const root = resolve('crawler');
  expect((await loadConfig(root)).settings.ocr.enabled).toBe(true);
  vi.stubEnv('AGAMAJUNG_OCR', '0');
  const { settings } = await loadConfig(root);
  expect(settings.ocr.enabled).toBe(false);
  const state = await CrawlerState.open(join(dir, 'state.json'));
  state.account('stokke').last_checked = new Date().toISOString();
  expect(planScans({ storyAccounts: ['stokke'], freshAccounts: [] }, state, [seed], settings)).toEqual([]);
});
test('configuration rejects reversed delay bounds, fractional caps and missing sections', () => {
  expect(() => parseSettings({ ...settingsJson, poll_interval_minutes: [2, 1] })).toThrow();
  expect(() => parseSettings({ ...settingsJson, hourly_caps: { ...settingsJson.hourly_caps, follows: 1.5 } })).toThrow();
  expect(() => parseSettings({})).toThrow();
  expect(parseSettings({ ...settingsJson, follow: { ...settingsJson.follow, daily_cap: 0 } }).follow.daily_cap).toBe(0);
});
