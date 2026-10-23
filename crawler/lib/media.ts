import type { Locator, Page } from 'playwright';
import { isImageUrl } from '../../lib/image-url';
import { HaltError } from './browser';
import { canonicalPost } from './util';
import { QuietWindowError } from './quiet-window';

export const POST_MEDIA = 'article img, article video';
export const STORY_MEDIA = '[role="dialog"] img, [role="dialog"] video, main img, main video';
export type MediaInfo = { index: number; area: number; url: string };

export function readMediaUrl(element: Element): string {
  return element.tagName === 'VIDEO' ? (element as HTMLVideoElement).poster
    : (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src;
}

// Serialized into the existing page. Keep this function self-contained and
// avoid nested named functions (tsx helpers do not exist in the browser).
export function inspectMedia(elements: Element[], kind: 'post' | 'story'): MediaInfo[] {
  const result: MediaInfo[] = [];
  let article: Element | undefined;
  if (kind === 'post') {
    const articles = [...document.querySelectorAll('[role="dialog"] article, main article, article')];
    // A permalink may have a feed behind a dialog. Prefer the open dialog.
    articles.sort((a, b) => Number(Boolean(b.closest('[role="dialog"]'))) - Number(Boolean(a.closest('[role="dialog"]'))));
    article = articles.find(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(item).visibility !== 'hidden';
    });
    if (!article) return result;
  }
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index] as HTMLImageElement | HTMLVideoElement;
    if (article && element.closest('article') !== article) continue;
    if (element.closest('header, [role="banner"]') || /profile|프로필|avatar/i.test(element.getAttribute('alt') ?? '')) continue;
    const link = element.closest('a[href]')?.getAttribute('href');
    if (link && /^\/[A-Za-z0-9._]+\/?$/.test(link)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) continue;
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    let hidden = false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) { hidden = true; break; }
      if (node !== element) {
        const bounds = node.getBoundingClientRect();
        if (/hidden|clip|scroll|auto/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/hidden|clip|scroll|auto/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
    }
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    // Offscreen carousel slides can be Playwright-visible but clipped by a track.
    if (hidden || area < rect.width * rect.height * 0.8) continue;
    if (element.tagName === 'IMG') {
      const image = element as HTMLImageElement;
      if (!image.complete || !image.naturalWidth) continue;
      result.push({ index, area, url: image.currentSrc || image.src });
    } else if (element.tagName === 'VIDEO') {
      const video = element as HTMLVideoElement;
      if (kind === 'story' && video.readyState < 2) continue;
      result.push({ index, area, url: video.poster });
    }
  }
  return result.sort((a, b) => b.area - a.area);
}

export function propagateMediaInterruption(error: unknown): void {
  if (error instanceof QuietWindowError || error instanceof HaltError) throw error;
}

export async function selectMedia(page: Page, kind: 'post' | 'story'): Promise<{ element: Locator; image_url?: string } | null> {
  try {
    const candidates = page.locator(kind === 'post' ? POST_MEDIA : STORY_MEDIA);
    const selected = (await candidates.evaluateAll(inspectMedia, kind))[0];
    if (!selected) return null;
    return { element: candidates.nth(selected.index), ...(isImageUrl(selected.url) ? { image_url: selected.url } : {}) };
  } catch (error) {
    propagateMediaInterruption(error);
    return null; // Never log signed URLs or raw Playwright/media errors.
  }
}

export async function postImageUrl(page: Page): Promise<string | undefined> {
  const media = await selectMedia(page, 'post');
  // A video without a poster stays text-only; its og:image may be unrelated.
  if (media) return media.image_url;
  try {
    const current = canonicalPost(page.url());
    const source = await page.locator('meta[property="og:url"]').first().getAttribute('content', { timeout: 1000 });
    if (!source) return;
    if (!current || canonicalPost(source) !== current) return;
    const image = await page.locator('meta[property="og:image"]').first().getAttribute('content', { timeout: 1000 });
    return isImageUrl(image) ? image : undefined;
  } catch (error) { propagateMediaInterruption(error); return; }
}
