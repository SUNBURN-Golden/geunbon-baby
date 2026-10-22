import type { Locator, Page } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CrawlerState } from './state';
import type { Settings } from './config';
import { assertHuman } from './browser';
import { firstVisible, followingButton, nextStoryButton, parseHandle, postLinks } from './selectors';
import { sleep } from './util';
import { health } from './health';
import { sendItem } from './ingest';
import { extract, toSuggestions } from './extract';
import { postImageUrl, selectMedia, readMediaUrl, propagateMediaInterruption } from './media';
import { isImageUrl } from '../../lib/image-url';
import { maskPersonal } from './external/filter';

const exec = promisify(execFile);
async function pauseReadyStory(page: Page, account: string, previousPath: string | null): Promise<boolean> {
  // Wait for a decoded frame, without the human pacing delay: playback is live.
  await page.waitForFunction(({ account, previousPath }) => {
    const story = /^\/stories\/([^/]+)\/(\d+)\/?$/.exec(location.pathname);
    if (!story || story[1].toLowerCase() !== account.toLowerCase() || location.pathname === previousPath) return false;
    return [...document.querySelectorAll('video, [role="dialog"] img, main img')].some(media => {
      if (!media.getBoundingClientRect().width || !media.getBoundingClientRect().height) return false;
      return media instanceof HTMLVideoElement ? media.readyState >= 2 : media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0;
    });
  }, { account, previousPath }, { timeout: 5000 });
  const pause = await firstVisible([page.getByRole('button', { name: /^(Pause|일시 정지|일시정지)$/i })]);
  if (pause) { await pause.click(); return true; }
  // Next may retain the paused state. Never toggle Play back on.
  return Boolean(await firstVisible([page.getByRole('button', { name: /^(Play|재생)$/i })]));
}
export async function readCaption(page: Page): Promise<string> {
  for (const selector of ['article h1', 'article', 'main, [role="main"]']) {
    const text = await page.locator(selector).first().innerText({ timeout: 4000 }).catch(() => '');
    if (text.trim()) return text.slice(0, 6000);
  }
  return (await page.locator('meta[property="og:description"]').first().getAttribute('content', { timeout: 4000 }).catch(() => '') ?? '').slice(0, 6000);
}
export async function postAuthor(page: Page): Promise<string | null> {
  for (const selector of ['article header a[href]', 'main header a[href]', 'article a[role="link"][href]']) {
    const hrefs = await page.locator(selector).evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''));
    const author = hrefs.map(parseHandle).find(Boolean);
    if (author) return author;
  }
  return null;
}
async function ocrStory(page: Page, image: Locator, crawlerDir: string, settings: Settings, collectImages: boolean): Promise<{ text: string; image_url?: string }> {
  const file = resolve(crawlerDir, '.cache', 'story.png');
  let handle: Awaited<ReturnType<Locator['elementHandle']>> | null = null;
  try {
    // Pin the DOM node: a live locator could resolve a different carousel/story
    // element between URL extraction and screenshotting. Detached nodes fail OCR
    // and remain retryable. Explicit page reads retain the quiet/stop guard before
    // every handle operation, since ElementHandles are not wrapped by guardPage.
    handle = await image.elementHandle({ timeout: 1000 });
    if (!handle) return { text: '' };
    let image_url: string | undefined;
    // collect_images=false 계정은 미디어 URL을 읽지 않는다(스크린샷은 OCR 후 바로 삭제).
    if (collectImages) {
      try {
        page.url();
        const candidate = await handle.evaluate(readMediaUrl);
        if (isImageUrl(candidate)) image_url = candidate;
      } catch (error) { propagateMediaInterruption(error); }
    }
    page.url();
    await handle.screenshot({ path: file });
    await chmod(file, 0o600);
    const { stdout } = await exec('tesseract', [file, 'stdout', '-l', settings.ocr.langs], { timeout: settings.ocr.timeout_ms, maxBuffer: 32768 });
    return { text: stdout.trim().slice(0, 6000), ...(image_url ? { image_url } : {}) };
  } catch (error) {
    propagateMediaInterruption(error);
    health('warn', { scope: 'ocr', detail: 'tesseract·화면 캡처 실패(설치·언어팩 확인)' });
    return { text: '' };
  } finally {
    await handle?.dispose().catch(() => {});
    await unlink(file).catch(() => {});
  }
}
export type CollectContext = { account: string; crawlerDir: string; state: CrawlerState; settings: Settings; api: URL; token: string; scanPosts: boolean; scanStories: boolean; collectImages?: boolean };
// collect_images=false 이면 마스킹한 텍스트에서 suggestions까지 추출해 개인정보가 전송되지 않게 한다.
function prepareText(raw: string, collectImages: boolean) {
  const text = collectImages ? raw : maskPersonal(raw);
  return { text, suggestions: toSuggestions(extract(text)) };
}
export async function collectAccount(page: Page, ctx: CollectContext): Promise<{ posts: number; stories: number }> {
  const { account, state, settings, api, token } = ctx;
  const collectImages = ctx.collectImages !== false;
  const result = { posts: 0, stories: 0 };
  const accountState = state.account(account);
  if (ctx.scanPosts && await state.reserve('profile_visits', { hourly: settings.hourly_caps.profile_visits })) {
    await page.goto(`https://www.instagram.com/${account}/`, { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.navigation);
    await assertHuman(page);
    if (await firstVisible(followingButton(page))) state.setFollowing(account, true);
    health('account_visit', { account });
    const links = await postLinks(page);
    if (!links.length) health('selector_miss', { scope: 'profile_posts', account });
    const fresh = links.filter(link => !state.isSeen(link)).slice(0, settings.per_tick.max_posts_per_account);
    for (const canonical of fresh) {
      if (!await state.reserve('post_views', { hourly: settings.hourly_caps.post_views })) break;
      await page.goto(canonical, { waitUntil: 'domcontentloaded' });
      await sleep(...settings.delays_ms.action);
      await assertHuman(page);
      const caption = await readCaption(page);
      if (!caption.trim()) { health('selector_miss', { scope: 'caption', account }); continue; }
      const image_url = collectImages ? await postImageUrl(page) : undefined;
      const { text, suggestions } = prepareText(caption, collectImages);
      await sendItem(api, token, { source_url: canonical, account, kind: 'post', ...(image_url ? { image_url } : {}), text, captured_at: new Date().toISOString(), suggestions });
      state.markSeen(canonical);
      await state.save();
      result.posts++;
    }
    accountState.last_post_urls = links.slice(0, 15);
    accountState.last_checked = new Date().toISOString();
    await state.save();
  }
  // Visit stories directly: posts changed the page, and a story signal does not require a profile scan.
  if (ctx.scanStories && settings.ocr.enabled && settings.per_tick.max_stories_per_account > 0 &&
    await state.reserve('story_opens', { hourly: settings.hourly_caps.story_opens })) {
    await page.goto(`https://www.instagram.com/stories/${account}/`, { waitUntil: 'domcontentloaded' });
    let previousPath: string | null = null;
    for (let n = 0; n < settings.per_tick.max_stories_per_account; n++) {
      await assertHuman(page);
      if (!await pauseReadyStory(page, account, previousPath)) { health('selector_miss', { scope: 'story_pause', account }); break; }
      const url = new URL(page.url());
      const id = /^\/stories\/([^/]+)\/(\d+)\/?$/.exec(url.pathname);
      if (!id || id[1].toLowerCase() !== account.toLowerCase()) break;
      const canonical = `https://www.instagram.com/stories/${account}/${id[2]}/`;
      await sleep(...settings.delays_ms.action);
      await assertHuman(page);
      if (new URL(page.url()).pathname !== url.pathname) break;
      if (!state.isSeen(canonical)) {
        const media = await selectMedia(page, 'story');
        if (!media) { health('selector_miss', { scope: 'story_media' }); break; }
        if (new URL(page.url()).pathname !== url.pathname) break;
        const { text: ocrText, image_url } = await ocrStory(page, media.element, ctx.crawlerDir, settings, collectImages);
        if (ocrText.trim() && new URL(page.url()).pathname.replace(/\/$/, '') === url.pathname.replace(/\/$/, '')) {
          const { text, suggestions } = prepareText(ocrText, collectImages);
          await sendItem(api, token, { source_url: canonical, account, kind: 'story', ...(image_url ? { image_url } : {}), text, captured_at: new Date().toISOString(), suggestions });
          state.markSeen(canonical);
          await state.save();
          result.stories++;
        }
      }
      if (n + 1 >= settings.per_tick.max_stories_per_account) break;
      const next = await firstVisible(nextStoryButton(page));
      if (!next || !await state.reserve('story_opens', { hourly: settings.hourly_caps.story_opens })) break;
      previousPath = url.pathname;
      await next.click();
    }
    accountState.last_story_at = new Date().toISOString();
    await state.save();
  }
  return result;
}
