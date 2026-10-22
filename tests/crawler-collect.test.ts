import { POST_MEDIA, STORY_MEDIA } from '../crawler/lib/media';
import { mediaDOM, MediaElement, asElement } from './helpers/media-dom';
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
import { sleep } from '../crawler/lib/util';
vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: vi.fn(async () => ({ stdout: '스토케 트립트랩 공구 39만원' })) }) };
});
let dir: string;
let ctx: CollectContext;
beforeEach(async () => {
  vi.clearAllMocks();
  mediaDOM();
  dir = await mkdtemp(join(tmpdir(), 'crawler-collect-'));
  ctx = { account: 'stokke', crawlerDir: dir, state: await CrawlerState.open(join(dir, '.cache', 'state.json')), settings: parseSettings(settingsJson), api: new URL('https://ingest.invalid/api/v1/ingest'), token: 'test-ingest-token', scanPosts: true, scanStories: false };
  vi.mocked(promisify(execFile)).mockResolvedValue({ stdout: '스토케 트립트랩 공구 39만원', stderr: '' });
  vi.mocked(sleep).mockImplementation(async () => {});
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
    if (selector === STORY_MEDIA) return [{ dom: asElement(new MediaElement('VIDEO')), screenshot: async path => { await writeFile(path, 'mock-frame'); } }];
    if (selector === 'role:button') return [{ name: 'Pause' }, { name: 'Next', click: () => { nextClicks++; } }];
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
  const mock = mockPage(selector => selector === STORY_MEDIA ? [{ dom: asElement(new MediaElement('VIDEO')), screenshot: async path => { await writeFile(path, 'mock-frame'); } }] : selector === 'role:button' ? [{ name: 'Pause' }] : []);
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 0 });
  expect(ctx.state.isSeen('https://www.instagram.com/stories/stokke/123/')).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  await expect(stat(join(dir, '.cache', 'story.png'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([true, false])('autoplay cannot skip stories during pacing or OCR (Next resumes playback: %s)', async resumes => {
  ctx.scanPosts = false; ctx.scanStories = true;
  ctx.settings.per_tick.max_stories_per_account = 3;
  let id = 123;
  let paused = false;
  let ready = false;
  const captured: number[] = [];
  const pauses: number[] = [];
  const mock = mockPage(selector => {
    if (selector === STORY_MEDIA) return [{ dom: asElement(new MediaElement('VIDEO')), screenshot: async path => {
      expect(paused).toBe(true);
      captured.push(id);
      await writeFile(path, 'mock-frame');
    } }];
    if (selector === 'role:button') return [
      { name: paused ? 'Play' : 'Pause', click: () => { expect(ready).toBe(true); paused = true; pauses.push(id); } },
      { name: 'Next', click: () => { id++; paused = !resumes; ready = false; mock.setUrl(`https://www.instagram.com/stories/stokke/${id}/`); } },
    ];
    return [];
  });
  mock.goto.mockImplementation(async () => { mock.setUrl(`https://www.instagram.com/stories/stokke/${id}/`); });
  vi.mocked(mock.page.waitForFunction).mockImplementation(async () => { ready = true; return {} as never; });
  // A default 8–22 second pacing delay outlasts a story's autoplay duration.
  // Model that advancement whenever a pacing delay occurs while still playing.
  vi.mocked(sleep).mockImplementation(async (min) => {
    expect(min).toBe(8000);
    if (!paused) { id++; mock.setUrl(`https://www.instagram.com/stories/stokke/${id}/`); }
  });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 3 });
  expect(captured).toEqual([123, 124, 125]);
  expect(pauses).toEqual(resumes ? captured : [123]);
  expect(vi.mocked(fetch).mock.calls.map(([, request]) => JSON.parse(request!.body as string).source_url)).toEqual(
    captured.map(story => `https://www.instagram.com/stories/stokke/${story}/`),
  );
});

test('stories with no pause control are left retryable without OCR or pacing', async () => {
  ctx.scanPosts = false; ctx.scanStories = true;
  const mock = mockPage();
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 0 });
  expect(promisify(execFile)).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
  expect(ctx.state.isSeen('https://www.instagram.com/stories/stokke/123/')).toBe(false);
});

test('post image payload preserves the signed query; failed deliveries remain retryable and logs exclude media', async () => {
  const article = new MediaElement('ARTICLE'); mediaDOM([article]);
  const image = new MediaElement('IMG', article);
  image.currentSrc = 'https://scontent.cdninstagram.com/product.jpg?sig=synthetic%2B%2F&x=1&x=2';
  const logs = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const { page } = mockPage(selector => selector.startsWith('a[href*="/p/"') ? [{ href: '/p/image/' }] : selector === 'article' ? [{ text: '트립트랩 공구' }] : selector === POST_MEDIA ? [{ dom: asElement(image) }] : []);
  vi.mocked(fetch).mockRejectedValueOnce(new Error(`raw media failure ${image.currentSrc}`));
  await expect(collectAccount(page, ctx)).rejects.toBeInstanceOf(IngestError);
  expect(ctx.state.isSeen('https://www.instagram.com/p/image/')).toBe(false);
  expect(await collectAccount(page, ctx)).toEqual({ posts: 1, stories: 0 });
  for (const [, request] of vi.mocked(fetch).mock.calls) {
    expect(JSON.parse(request!.body as string).image_url).toBe(image.currentSrc);
  }
  const output = logs.mock.calls.map(([s]) => String(s)).join('');
  expect(output).not.toContain(image.currentSrc);
  expect(output).not.toContain(ctx.token);
  expect(output).not.toContain('raw media failure');
});

test.each(['image', 'poster', 'no-poster', 'unavailable'])('story %s uses the selected OCR element and sends optional media', async kind => {
  ctx.scanPosts = false; ctx.scanStories = true; ctx.settings.per_tick.max_stories_per_account = 1;
  const element = new MediaElement(kind === 'image' || kind === 'unavailable' ? 'IMG' : 'VIDEO');
  if (kind === 'poster') element.poster = 'https://video.fbcdn.net/poster.jpg?sig=synthetic%2B';
  if (kind === 'unavailable') element.currentSrc = 'blob:unavailable';
  const avatar = new MediaElement('IMG'); avatar.attrs.alt = 'profile';
  const screenshot = vi.fn(async (path: string) => { await writeFile(path, 'fixture'); });
  const mock = mockPage(selector => selector === STORY_MEDIA ? [
    { dom: asElement(avatar), screenshot: async () => { throw new Error('Avatar must not be captured'); } },
    { dom: asElement(element), screenshot },
  ] : selector === 'role:button' ? [{ name: 'Pause' }] : []);
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 1 });
  expect(screenshot).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).image_url).toBe(
    kind === 'image' ? element.src : kind === 'poster' ? element.poster : undefined,
  );
});

test.each(['selection', 'ocr'])('story identity change during %s never delivers mixed text/image', async stage => {
  ctx.scanPosts = false; ctx.scanStories = true; ctx.settings.per_tick.max_stories_per_account = 1;
  const element = new MediaElement('IMG');
  const mock = mockPage(selector => {
    if (selector === STORY_MEDIA) {
      if (stage === 'selection') mock.setUrl('https://www.instagram.com/stories/stokke/124/');
      return [{ dom: asElement(element), screenshot: async path => { await writeFile(path, 'fixture'); } }];
    }
    return selector === 'role:button' ? [{ name: 'Pause' }] : [];
  });
  if (stage === 'ocr') vi.mocked(promisify(execFile)).mockResolvedValueOnce({
    get stdout() { mock.setUrl('https://www.instagram.com/stories/stokke/124/'); return '트립트랩 공구'; }, stderr: '',
  });
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 0 });
  expect(fetch).not.toHaveBeenCalled();
  expect(ctx.state.isSeen('https://www.instagram.com/stories/stokke/123/')).toBe(false);
});

test('story URL reading and OCR use a pinned node even when the live locator changes', async () => {
  ctx.scanPosts = false; ctx.scanStories = true; ctx.settings.per_tick.max_stories_per_account = 1;
  const original = new MediaElement('IMG');
  const replacement = new MediaElement('IMG'); replacement.src = 'https://fbcdn.net/unrelated.jpg';
  let reads = 0, swapped = false;
  Object.defineProperty(original, 'currentSrc', { get: () => { if (++reads === 2) swapped = true; return original.src; } });
  const captured: string[] = [];
  const mock = mockPage(selector => selector === STORY_MEDIA ? [{
    dom: asElement(swapped ? replacement : original),
    screenshot: async path => { captured.push(swapped ? 'pinned-original' : 'original'); await writeFile(path, 'fixture'); },
  }] : selector === 'role:button' ? [{ name: 'Pause' }] : []);
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 1 });
  expect(swapped).toBe(true);
  expect(captured).toEqual(['pinned-original']);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).image_url).toBe(original.src);
});

const CHILD_TEXT = '7개월 아기 트립트랩 공구 010-1234-5678 39만원';
test('collect_images=false posts omit image_url and mask text and suggestions', async () => {
  ctx.collectImages = false;
  const article = new MediaElement('ARTICLE'); mediaDOM([article]);
  const image = new MediaElement('IMG', article);
  image.currentSrc = 'https://scontent.cdninstagram.com/child.jpg?sig=1';
  const { page } = mockPage(selector => selector.startsWith('a[href*="/p/"') ? [{ href: '/p/seller/' }] : selector === 'article' ? [{ text: CHILD_TEXT }] : selector === POST_MEDIA ? [{ dom: asElement(image) }] : []);
  expect(await collectAccount(page, ctx)).toEqual({ posts: 1, stories: 0 });
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(body).not.toHaveProperty('image_url');
  expect(body.text).toContain('[아이 나이]');
  expect(body.text).toContain('[전화번호]');
  expect(body.text).not.toContain('010-1234-5678');
  expect(JSON.stringify(body.suggestions)).not.toContain('010-1234-5678');
  expect(JSON.stringify(body.suggestions)).not.toContain('7개월');
  expect(body.suggestions.price).toMatchObject({ value: 390000 });
});
test('collect_images=false stories skip media URL reads and mask OCR text and suggestions', async () => {
  ctx.collectImages = false; ctx.scanPosts = false; ctx.scanStories = true; ctx.settings.per_tick.max_stories_per_account = 1;
  vi.mocked(promisify(execFile)).mockResolvedValueOnce({ stdout: CHILD_TEXT, stderr: '' });
  const element = new MediaElement('IMG');
  let urlReads = 0;
  Object.defineProperty(element, 'currentSrc', { get: () => { urlReads++; return 'https://scontent.cdninstagram.com/child.jpg?sig=1'; } });
  const mock = mockPage(selector => selector === STORY_MEDIA ? [{ dom: asElement(element), screenshot: async path => { await writeFile(path, 'fixture'); } }] : selector === 'role:button' ? [{ name: 'Pause' }] : []);
  mock.goto.mockImplementation(async () => { mock.setUrl('https://www.instagram.com/stories/stokke/123/'); });
  expect(await collectAccount(mock.page, ctx)).toEqual({ posts: 0, stories: 1 });
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(body).not.toHaveProperty('image_url');
  expect(body.text).toContain('[아이 나이]');
  expect(body.text).not.toContain('010-1234-5678');
  expect(JSON.stringify(body.suggestions)).not.toContain('010-1234-5678');
  expect(body.suggestions.price).toMatchObject({ value: 390000 });
  expect(urlReads).toBe(1); // 미디어 선택 단계의 한 번뿐. readMediaUrl(두 번째 읽기)은 호출되지 않는다.
});
