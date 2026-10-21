import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import settingsJson from '../crawler/config/settings.json';
import { parseSettings } from '../crawler/lib/config';
import { collectAccount, type CollectContext } from '../crawler/lib/collect';
import { CrawlerState } from '../crawler/lib/state';
import { IngestError } from '../crawler/lib/ingest';
import { mockPage } from './helpers/page';
vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: vi.fn(async () => ({ stdout: '스토케 트립트랩 공구 39만원' })) }) };
});
let dir: string;
let ctx: CollectContext;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crawler-collect-'));
  ctx = { account: 'stokke', crawlerDir: dir, state: await CrawlerState.open(join(dir, '.cache', 'state.json')), settings: parseSettings(settingsJson), api: new URL('https://ingest.invalid/api/v1/ingest'), token: 'test-ingest-token', scanPosts: true, scanStories: false };
  vi.mocked(promisify(execFile)).mockResolvedValue({ stdout: '스토케 트립트랩 공구 39만원', stderr: '' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
test('unprocessed profile posts remain eligible after per-tick limit and restart', async () => {
  const { page } = mockPage(selector => {
    if (selector.startsWith('a[href*="/p/"')) return ['a', 'b', 'c'].map(id => ({ href: `/p/${id}/` }));
    if (selector === 'article') return [{ text: '스토케 트립트랩 공구가 390,000원 10/26~10/28' }];
    return [];
  });
  expect(await collectAccount(page, ctx)).toEqual({ posts: 2, stories: 0 });
  expect(ctx.state.isSeen('https://www.instagram.com/p/c/')).toBe(false);
  ctx.state = await CrawlerState.open(join(dir, '.cache', 'state.json'));
  expect(await collectAccount(page, ctx)).toEqual({ posts: 1, stories: 0 });
  expect(await collectAccount(page, ctx)).toEqual({ posts: 0, stories: 0 });
  expect(fetch).toHaveBeenCalledTimes(3);
  const request = vi.mocked(fetch).mock.calls[0][1]!;
  expect(request.headers).toMatchObject({ authorization: 'Bearer test-ingest-token' });
  expect(JSON.parse(request.body as string)).toMatchObject({ kind: 'post', suggestions: { price: { value: 390000 } } });
});
test('blank caption and failed ingestion do not mark a post as delivered', async () => {
  let text = '';
  const { page } = mockPage(selector => selector.startsWith('a[href*="/p/"') ? [{ href: '/p/a/' }] : selector === 'article' ? [{ text }] : []);
  expect(await collectAccount(page, ctx)).toEqual({ posts: 0, stories: 0 });
  expect(ctx.state.isSeen('https://www.instagram.com/p/a/')).toBe(false);
  text = '트립트랩 39만원';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  await expect(collectAccount(page, ctx)).rejects.toBeInstanceOf(IngestError);
  expect(ctx.state.isSeen('https://www.instagram.com/p/a/')).toBe(false);
});
test('story-only jobs run OCR, ingest once, remove screenshots, and never open an extra capped story', async () => {
  ctx.scanPosts = false; ctx.scanStories = true;
  ctx.settings.hourly_caps.story_opens = 1;
  let nextClicks = 0;
  const mock = mockPage(selector => {
    if (selector === 'video:visible') return [{ screenshot: async path => { await writeFile(path, 'mock-frame'); } }];
    if (selector === 'role:button') return [{ name: 'Next', click: () => { nextClicks++; } }];
    return [];
  });
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 1 });
  expect(ctx.state.isSeen('https://www.instagram.com/stories/stokke/123/')).toBe(true);
  expect(nextClicks).toBe(0);
  expect(promisify(execFile)).toHaveBeenCalledWith('tesseract', expect.arrayContaining(['kor+eng']), expect.objectContaining({ timeout: 30000 }));
  await expect(stat(join(dir, '.cache', 'story.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(mock.goto).toHaveBeenCalledTimes(1);
});
test('OCR failures leave stories retryable and clean the screenshot', async () => {
  ctx.scanPosts = false; ctx.scanStories = true;
  ctx.settings.per_tick.max_stories_per_account = 1;
  vi.mocked(promisify(execFile)).mockRejectedValueOnce(new Error('tesseract missing'));
  const mock = mockPage(selector => selector === 'video:visible' ? [{ screenshot: async path => { await writeFile(path, 'mock-frame'); } }] : []);
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 0 });
  expect(ctx.state.isSeen('https://www.instagram.com/stories/stokke/123/')).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  await expect(stat(join(dir, '.cache', 'story.png'))).rejects.toMatchObject({ code: 'ENOENT' });
});
