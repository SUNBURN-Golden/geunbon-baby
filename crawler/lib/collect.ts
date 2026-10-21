// 계정 프로필 방문 → 새 게시물·스토리 수집 → 추출 제안과 함께 검수 대기열로 전송.
// 게시물 diff는 프로필 그리드 URL 목록으로 판단하고, 스토리는 링(story ring)이 있을 때만 연다.
import type { Page } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CrawlerState } from './state';
import type { Settings } from './config';
import { assertHuman } from './browser';
import { firstVisible, followingButton, nextStoryButton, postLinks } from './selectors';
import { sleep } from './util';
import { health } from './health';
import { sendItem } from './ingest';
import { extract, toSuggestions } from './extract';

const exec = promisify(execFile);

export async function readCaption(page: Page): Promise<string> {
  const candidates = [
    await page.locator('article').first().innerText({ timeout: 8000 }).catch(() => ''),
    await page.locator('meta[property="og:description"]').first().getAttribute('content', { timeout: 4000 }).catch(() => ''),
    await page.locator('main, [role="main"]').first().innerText({ timeout: 6000 }).catch(() => ''),
  ];
  const text = candidates.find(t => t && t.trim().length > 0) ?? '';
  return text.slice(0, 18000);
}

async function postAuthor(page: Page): Promise<string | null> {
  const href = await page.locator('header a[href^="/"]').first().getAttribute('href', { timeout: 4000 }).catch(() => null);
  return href ? href.replaceAll('/', '') : null;
}

async function ocrStory(page: Page, crawlerDir: string, settings: Settings): Promise<string> {
  const image = page.locator('img').filter({ visible: true }).last();
  if (!(await image.count())) return '';
  const file = resolve(crawlerDir, '.cache', 'story.png');
  await image.screenshot({ path: file });
  await chmod(file, 0o600);
  try {
    const { stdout } = await exec('tesseract', [file, 'stdout', '-l', settings.ocr.langs], { timeout: settings.ocr.timeout_ms, maxBuffer: 32768 });
    return stdout.trim();
  } catch {
    health('warn', { scope: 'ocr', detail: 'tesseract 실행 실패(설치·언어팩 확인)' });
    return '';
  } finally { await unlink(file).catch(() => {}); }
}

export type CollectContext = { account: string; crawlerDir: string; state: CrawlerState; settings: Settings; api: URL; token: string };

export async function collectAccount(page: Page, ctx: CollectContext): Promise<{ posts: number; stories: number }> {
  const { account, state, settings, api, token } = ctx;
  const result = { posts: 0, stories: 0 };
  await page.goto(`https://www.instagram.com/${account}/`, { waitUntil: 'domcontentloaded' });
  await sleep(...settings.delays_ms.navigation);
  await assertHuman(page);
  // 팔로잉 상태를 프로필 버튼으로 재확인한다(팔로우 ledger 근거).
  const following = await firstVisible(followingButton(page));
  state.setFollowing(account, Boolean(following));
  if (!following) health('account_visit', { account, following: false });

  // ── 새 게시물 diff ──
  const links = await postLinks(page);
  const known = new Set(state.account(account).last_post_urls ?? []);
  const fresh = links.filter(link => !known.has(link)).slice(0, settings.per_tick.max_posts_per_account);
  for (const link of fresh) {
    if (!state.canSpend('post_views', { hourly: settings.hourly_caps.post_views })) break;
    const pathname = new URL(link, 'https://www.instagram.com/').pathname;
    const canonical = `https://www.instagram.com${pathname.endsWith('/') ? pathname : `${pathname}/`}`;
    if (state.isSeen(canonical)) continue;
    state.spend('post_views');
    await page.goto(canonical, { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.action);
    await assertHuman(page);
    const text = await readCaption(page);
    if (text.trim()) {
      await sendItem(api, token, { source_url: canonical, account, kind: 'post', text, captured_at: new Date().toISOString(), suggestions: toSuggestions(extract(text)) });
      result.posts += 1;
    }
    state.markSeen(canonical);
  }
  const accountState = state.account(account);
  accountState.last_post_urls = [...new Set([...(accountState.last_post_urls ?? []), ...links])].slice(-15);

  // ── 스토리(링 있는 경우만, OCR 텍스트가 있어야 전송) ──
  const storyLink = await firstVisible([page.locator(`a[href^="/stories/${account}/"]`), page.locator(`a[href*="/stories/${account}"]`)]);
  const lastStory = accountState.last_story_at ? Date.now() - Date.parse(accountState.last_story_at) : Infinity;
  if (storyLink && settings.ocr.enabled && lastStory >= settings.staleness.story_recheck_minutes * 60_000) {
    await storyLink.click();
    await sleep(...settings.delays_ms.action);
    for (let n = 0; n < settings.per_tick.max_stories_per_account; n++) {
      await assertHuman(page);
      if (!state.canSpend('story_opens', { hourly: settings.hourly_caps.story_opens })) { health('story_skip', { account, reason: 'hourly_cap' }); break; }
      const url = new URL(page.url());
      const id = url.pathname.split('/')[3] ?? '';
      if (!url.pathname.startsWith(`/stories/${account}/`) || !/^\d+$/.test(id)) break;
      state.spend('story_opens');
      const canonical = `https://www.instagram.com/stories/${account}/${id}/`;
      if (!state.isSeen(canonical)) {
        const text = await ocrStory(page, ctx.crawlerDir, settings);
        if (text.trim()) {
          await sendItem(api, token, { source_url: canonical, account, kind: 'story', text, captured_at: new Date().toISOString(), suggestions: toSuggestions(extract(text)) });
          result.stories += 1;
        }
        state.markSeen(canonical);
      }
      const next = await firstVisible(nextStoryButton(page));
      if (!next) break;
      await next.click();
      await sleep(...settings.delays_ms.action);
    }
    accountState.last_story_at = new Date().toISOString();
  }
  accountState.last_checked = new Date().toISOString();
  return result;
}

export { postAuthor };
