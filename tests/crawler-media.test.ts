import { expect, test, vi } from 'vitest';
import { inspectMedia, postImageUrl, selectMedia, POST_MEDIA } from '../crawler/lib/media';
import { HaltError } from '../crawler/lib/browser';
import { QuietWindowError } from '../crawler/lib/quiet-window';
import { MediaElement, asElement, mediaDOM } from './helpers/media-dom';
import { mockPage } from './helpers/page';

const inspect = (elements: MediaElement[], kind: 'post' | 'story' = 'post') => inspectMedia(elements.map(asElement), kind);

test('scopes posts, excludes header/avatar/unrelated images, and preserves currentSrc signatures', async () => {
  const article = new MediaElement('ARTICLE');
  const other = new MediaElement('ARTICLE');
  mediaDOM([article, other]);
  const header = new MediaElement('HEADER', article);
  const avatar = new MediaElement('IMG', article); avatar.attrs.alt = 'Profile picture';
  const profileLink = new MediaElement('A', article); profileLink.attrs.href = '/seller/';
  const image = new MediaElement('IMG', article); image.currentSrc = 'https://scontent.cdninstagram.com/product.jpg?sig=a%2Fb%2Bc&key=1&key=2';
  const elements = [new MediaElement('IMG', header), avatar, new MediaElement('IMG', profileLink), image, new MediaElement('IMG', other)];
  expect(inspect(elements)).toEqual([{ index: 3, area: 160000, url: image.currentSrc }]);
  const { page } = mockPage(selector => selector === POST_MEDIA ? elements.map(dom => ({ dom: asElement(dom) })) : []);
  expect((await selectMedia(page, 'post'))?.image_url).toBe(image.currentSrc);
});

test('prefers the dialog post over a background feed', () => {
  const feed = new MediaElement('ARTICLE');
  const dialog = new MediaElement('DIV'); dialog.attrs.role = 'dialog';
  const article = new MediaElement('ARTICLE', dialog);
  mediaDOM([feed, article]);
  expect(inspect([new MediaElement('IMG', feed), new MediaElement('IMG', article)]).map(m => m.index)).toEqual([1]);
});

test('excludes hidden, transparent, offscreen and clipped carousel slides', () => {
  const article = new MediaElement('ARTICLE'); mediaDOM([article]);
  const track = new MediaElement('DIV', article); track.style.overflowX = 'hidden';
  const current = new MediaElement('IMG', track);
  const next = new MediaElement('IMG', track); next.rect = { ...next.rect, left: 400, right: 800 };
  const partial = new MediaElement('IMG', track); partial.rect = { ...partial.rect, left: 200, right: 600 };
  const hidden = new MediaElement('DIV', article); hidden.attrs['aria-hidden'] = 'true';
  const transparent = new MediaElement('IMG', article); transparent.style.opacity = '0';
  const small = new MediaElement('IMG', article); small.rect = { ...small.rect, width: 32, height: 32 };
  expect(inspect([next, partial, new MediaElement('IMG', hidden), transparent, small, current]).map(m => m.index)).toEqual([5]);
});

test('uses src when currentSrc is absent and videos use only their poster', async () => {
  const article = new MediaElement('ARTICLE'); mediaDOM([article]);
  const image = new MediaElement('IMG', article);
  expect(inspect([image])[0].url).toBe(image.src);
  const video = new MediaElement('VIDEO', article); video.src = 'https://cdninstagram.com/video.mp4';
  const { page } = mockPage(selector => selector === POST_MEDIA ? [{ dom: asElement(video) }] : [{ href: 'https://cdninstagram.com/unrelated.jpg' }]);
  expect(await postImageUrl(page)).toBeUndefined();
  video.poster = 'https://video.fbcdn.net/poster.jpg?sig=synthetic';
  expect(await postImageUrl(page)).toBe(video.poster);
  video.poster = 'blob:local';
  expect(await postImageUrl(page)).toBeUndefined();
});

test('og:image fallback requires a matching post-specific og:url', async () => {
  mediaDOM();
  let source = 'https://www.instagram.com/p/wrong/';
  const image = 'https://cdninstagram.com/fallback.jpg?sig=synthetic%2B';
  const mock = mockPage(selector => selector === 'meta[property="og:url"]' ? [{ attrs: { content: source } }] : selector === 'meta[property="og:image"]' ? [{ attrs: { content: image } }] : []);
  mock.setUrl('https://www.instagram.com/p/current/');
  expect(await postImageUrl(mock.page)).toBeUndefined();
  source = 'https://instagram.com/p/current';
  expect(await postImageUrl(mock.page)).toBe(image);
});

test('stories select a decoded image or ready video, excluding avatars', () => {
  mediaDOM();
  const header = new MediaElement('HEADER');
  const image = new MediaElement('IMG');
  const loading = new MediaElement('IMG'); loading.complete = false;
  const video = new MediaElement('VIDEO'); video.readyState = 1;
  expect(inspect([new MediaElement('IMG', header), loading, video, image], 'story').map(m => m.index)).toEqual([3]);
});

test('selection failures omit images without logging raw errors; interruptions propagate', async () => {
  const mock = mockPage();
  const logs = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const error of [new Error('https://cdninstagram.com/private.jpg?sig=synthetic'), new QuietWindowError(), new HaltError('login')]) {
    vi.mocked(mock.page.locator).mockImplementation(() => { throw error; });
    if (error instanceof HaltError || error instanceof QuietWindowError) {
      await expect(selectMedia(mock.page, 'story')).rejects.toBe(error);
      await expect(postImageUrl(mock.page)).rejects.toBe(error);
    } else {
      expect(await selectMedia(mock.page, 'story')).toBeNull();
      expect(await postImageUrl(mock.page)).toBeUndefined();
    }
  }
  expect(logs).not.toHaveBeenCalled();
});

test('og:url compares normalized profile-prefixed permalinks and rejects unrelated posts', async () => {
  mediaDOM();
  let source = 'https://instagram.com/p/current/';
  const image = 'https://cdninstagram.com/fallback.jpg';
  const mock = mockPage(selector => selector === 'meta[property="og:url"]' ? [{ attrs: { content: source } }] : selector === 'meta[property="og:image"]' ? [{ attrs: { content: image } }] : []);
  mock.setUrl('https://www.instagram.com/seller/p/current/?tracking=1');
  expect(await postImageUrl(mock.page)).toBe(image);
  source = 'https://www.instagram.com/another/p/current/';
  expect(await postImageUrl(mock.page)).toBe(image);
  source = 'https://www.instagram.com/seller/reel/current/';
  expect(await postImageUrl(mock.page)).toBeUndefined();
  source = 'https://evil.test/p/current/';
  expect(await postImageUrl(mock.page)).toBeUndefined();
});
