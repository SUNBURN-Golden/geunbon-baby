import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import settingsJson from '../crawler/config/settings.json';
import accountsJson from '../crawler/config/accounts.json';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, parseSettings, type AccountsFile } from '../crawler/lib/config';
import { discoverSellers, discoveryTags, parseCandidate } from '../crawler/lib/discover';
import { CrawlerState } from '../crawler/lib/state';
import { mockPage } from './helpers/page';
vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crawler-discover-')); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
test('config covers all eight brands and Korean seller hashtags', () => {
  expect(new Set(accountsJson.seed_accounts.map(a => a.brand.toLowerCase()).filter(Boolean))).toEqual(new Set(['stokke', 'babybjorn', 'bugaboo', 'nuna', 'joie', 'cybex', 'egg', 'd.throne']));
  expect(discoveryTags(accountsJson as AccountsFile)).toEqual(expect.arrayContaining(['공구', '육아템공구', '스토케공구', '팔이피플']));
});
const SELLERS = ['wooamom_goeun', 'teenywishmarket', 'narin__mommy', 'rouny.day', 'somda.park', 'bbu__mom', 'honeybrread', 'rinhaamom', 'thejamiegrayson'];
test('gonggu sellers are registered once, polled, and never collect images', async () => {
  const handles = accountsJson.seed_accounts.map(a => a.handle.toLowerCase());
  expect(new Set(handles).size).toBe(handles.length);
  for (const handle of SELLERS) {
    expect(accountsJson.seed_accounts.filter(a => a.handle.toLowerCase() === handle)).toEqual([expect.objectContaining({ verified: true, follow: true, collect_images: false })]);
  }
  const loaded = await loadConfig(resolve('crawler'));
  expect(loaded.accounts.seed_accounts.filter(a => SELLERS.includes(a.handle)).every(a => !a.collect_images)).toBe(true);
  expect(loaded.accounts.seed_accounts.find(a => a.handle === 'stokke')?.collect_images).toBe(true);
});
test('duplicate handles differing only by case are rejected at load time', async () => {
  await mkdir(join(dir, 'config'));
  await copyFile(resolve('crawler', 'config', 'settings.json'), join(dir, 'config', 'settings.json'));
  const seed = { brand: '', scope: 'kr', verified: true, follow: true, note: '' };
  await writeFile(join(dir, 'config', 'accounts.json'), JSON.stringify({ seed_accounts: [{ ...seed, handle: 'Seller.Mom' }, { ...seed, handle: 'seller.mom' }] }));
  await expect(loadConfig(dir)).rejects.toThrow('중복된 핸들');
});
test('discovery normalizes/dedupes hashtags and parses seller captions', () => {
  const accounts = { seed_accounts: [], discovery: { hashtags: { base: ['#공구', '공구', ''], brand: [' #스토케공구 '], extra: ['../bad'] } } };
  expect(discoveryTags(accounts)).toEqual(['공구', '스토케공구']);
  expect(parseCandidate('/Seller.Mom/', '스토케 트립트랩 공동구매 39만원')).toMatchObject({ handle: 'seller.mom' });
  expect(parseCandidate('seller', '#팔이피플 공구 오픈')).not.toBeNull();
  expect(parseCandidate('seller', '오늘 날씨가 좋아요')).toBeNull();
  expect(parseCandidate('/p/not-author/', '공구')).toBeNull();
  expect(parseCandidate('https://evil.test/seller/', '공구')).toBeNull();
});
test('discovery rotates tags across restart, obeys interval/caps, and leaves posts available to ingest', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  const file = join(dir, 'state.json');
  let state = await CrawlerState.open(file);
  const config = parseSettings(settingsJson);
  const accounts: AccountsFile = { seed_accounts: [], discovery: { hashtags: { base: ['공구', '육아템공구'], brand: [], extra: [] } } };
  const { page, goto } = mockPage(selector => {
    if (selector.startsWith('a[href*="/p/"')) return [{ href: '/p/sale/?tracking=1' }];
    if (selector === 'article') return [{ text: '트립트랩 공구 39만원' }];
    if (selector === 'article header a[href]') return [{ href: '/seller/' }];
    return [];
  });
  expect(await discoverSellers(page, { accounts, state, settings: config })).toBe(1);
  expect(state.isSeen('https://www.instagram.com/p/sale/')).toBe(false);
  expect(state.followingHandles).toEqual([]);
  state = await CrawlerState.open(file);
  expect(await discoverSellers(page, { accounts, state, settings: config })).toBe(0);
  expect(goto).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date('2026-10-21T06:01:00Z'));
  await discoverSellers(page, { accounts, state, settings: config });
  expect(goto).toHaveBeenLastCalledWith(`https://www.instagram.com/explore/tags/${encodeURIComponent('육아템공구')}/`, expect.anything());
  expect(state.candidates).toHaveLength(1);
  config.hourly_caps.hashtag_pages = 0;
  vi.setSystemTime(new Date('2026-10-21T12:02:00Z'));
  const count = goto.mock.calls.length;
  await discoverSellers(page, { accounts, state, settings: config });
  expect(goto).toHaveBeenCalledTimes(count);
});

test.each(['json', 'meta'])('discovery registers a seller from %s metadata without DOM author links', async source => {
  const state = await CrawlerState.open(join(dir, 'state.json'));
  const accounts: AccountsFile = { seed_accounts: [], discovery: { hashtags: { base: ['공구'], brand: [], extra: [] } } };
  const { page } = mockPage(selector => {
    if (selector.startsWith('a[href*="/p/"')) return [{ href: '/seller/p/sale/' }];
    if (source === 'json' && selector === 'script[type="application/ld+json"]') return [{ text: JSON.stringify({ articleBody: '트립트랩 공구 39만원', author: { alternateName: '@seller' } }) }];
    if (source === 'meta' && selector === 'meta[name="description"]') return [{ attrs: { content: '10 likes - seller on Instagram: 트립트랩 공구 39만원' } }];
    return [];
  });
  expect(await discoverSellers(page, { accounts, state, settings: parseSettings(settingsJson) })).toBe(1);
  expect(state.candidates).toEqual([expect.objectContaining({ handle: 'seller' })]);
});

test.each([false, true])('discovery logs caption and author misses independently (caption missing: %s)', async missingCaption => {
  const healthModule = await import('../crawler/lib/health');
  const events = vi.spyOn(healthModule, 'health');
  const state = await CrawlerState.open(join(dir, 'state.json'));
  const accounts: AccountsFile = { seed_accounts: [], discovery: { hashtags: { base: ['공구'], brand: [], extra: [] } } };
  const { page } = mockPage(selector => {
    if (selector.startsWith('a[href*="/p/"')) return [{ href: '/p/missing/' }];
    if (!missingCaption && selector === 'article') return [{ text: '공구 39만원' }];
    return [];
  });
  expect(await discoverSellers(page, { accounts, state, settings: parseSettings(settingsJson) })).toBe(0);
  const misses = events.mock.calls.filter(([event]) => event === 'selector_miss').map(([, fields]) => fields?.scope);
  expect(misses).toEqual(missingCaption ? ['discovery_caption', 'discovery_author'] : ['discovery_author']);
  events.mockRestore();
});

test('discovery post misses include anchor count', async () => {
  const events = vi.spyOn(await import('../crawler/lib/health'), 'health');
  const state = await CrawlerState.open(join(dir, 'state.json'));
  const accounts: AccountsFile = { seed_accounts: [], discovery: { hashtags: { base: ['공구'], brand: [], extra: [] } } };
  const { page } = mockPage(selector => selector.startsWith('a[href*="/p/"') ? [{ href: '/explore/p/invalid/' }] : []);
  await discoverSellers(page, { accounts, state, settings: parseSettings(settingsJson) });
  expect(events).toHaveBeenCalledWith('selector_miss', { scope: 'discovery_posts', anchors: 1 });
  events.mockRestore();
});

test.each([
  [{ alternateName: '@seller' }, 'seller'], [{ identifier: { propertyID: 'username', value: 'Seller.Mom' } }, 'seller.mom'],
  [{ identifier: { propertyID: 'User ID', value: '123456789' }, url: 'https://www.instagram.com/seller/' }, 'seller'],
  [{ identifier: { propertyID: 'username', value: 'other_seller' }, url: 'https://www.instagram.com/seller/' }, 'seller'],
  [{ identifier: { propertyID: 'User ID', value: '123456789' } }, null],
  [{ identifier: { value: '123456789' } }, null],
  [{ identifier: { propertyID: 'User ID', value: 'seller.mom' } }, null],
  [{ identifier: { propertyID: 'handle', value: '@Seller.Mom' } }, 'seller.mom'],
  [{ identifier: { propertyID: 'username', value: '123456789' } }, '123456789'],
  [{ url: 'https://www.instagram.com/seller/' }, 'seller'], [{ alternateName: '@explore' }, null],
  [{ url: 'https://evil.test/seller/' }, null],
])('JSON-LD author fields must resolve to valid profile handles: %j', async (author, expected) => {
  const { postAuthor } = await import('../crawler/lib/collect');
  const { page, goto } = mockPage(selector => selector === 'script[type="application/ld+json"]' ? [{ text: JSON.stringify({ author }) }] : []);
  expect(await postAuthor(page)).toBe(expected);
  expect(goto).not.toHaveBeenCalled();
});
