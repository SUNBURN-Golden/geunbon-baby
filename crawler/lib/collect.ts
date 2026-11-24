import { instagramPriceEvidence } from '../src/deal-prices/instagram';
import { priceVerificationEnabled } from '../src/deal-prices/providers';
import type { Locator, Page } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CrawlerState } from './state';
import type { Settings } from './config';
import { assertHuman } from './browser';
import { firstVisible, followingButton, HANDLE_HREF, nextStoryButton, parseHandle, postLinksDetailed } from './selectors';
import { canonicalPost, sleep } from './util';
import { health } from './health';
import { sendItem } from './ingest';
import { extract, toSuggestions } from './extract';
import { postImageUrl, selectMedia, readMediaUrl, propagateMediaInterruption } from './media';
import { isImageUrl } from '../../lib/image-url';
import { filterText } from '../../shared/privacy-rules';
import { digest } from '../../shared/deal-price-evidence';

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
// JSON-LD can be an object, array, or @graph. Ignore malformed blocks without
// hiding page/quiet interruptions from the DOM read itself.
async function postMetadata(page: Page): Promise<Record<string, unknown>[]> {
  const blocks = await page.locator('script[type="application/ld+json"]').evaluateAll(scripts => scripts.map(script => script.textContent ?? ''));
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    records.push(record);
    visit(record['@graph']);
  };
  for (const block of blocks) {
    try { visit(JSON.parse(block)); } catch { /* Invalid JSON-LD is optional. */ }
  }
  return records;
}

export async function readCaption(page: Page): Promise<string> {
  const heading = await page.locator('article h1').first().innerText({ timeout: 4000 }).catch(error => { propagateMediaInterruption(error); return ''; });
  if (heading.trim()) return heading.slice(0, 6000);
  for (const record of await postMetadata(page)) {
    for (const value of [record.articleBody, record.caption]) {
      if (typeof value === 'string' && value.trim()) return value.slice(0, 6000);
    }
  }
  for (const selector of ['article', 'main, [role="main"]']) {
    const text = await page.locator(selector).first().innerText({ timeout: 4000 }).catch(error => { propagateMediaInterruption(error); return ''; });
    if (text.trim()) return text.slice(0, 6000);
  }
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    const text = await page.locator(selector).first().getAttribute('content', { timeout: 4000 }).catch(error => { propagateMediaInterruption(error); return ''; });
    if (text?.trim()) return text.slice(0, 6000);
  }
  return '';
}
const POST_ARTICLES = 'main article, [role="main"] article, [role="dialog"] article';
type AuthorResult = { status: 'resolved'; handle: string } | { status: 'missing' | 'conflict' | 'unreadable' };

// Explicit post identifiers bind metadata to this permalink. A different post's
// record (e.g. a recommendation) cannot supply author evidence.
function metadataMatches(record: Record<string, unknown>, current: string | null): boolean {
  return ['url', '@id', 'mainEntityOfPage'].every(key => {
    const value = record[key];
    if (value === undefined) return true;
    const id = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>)['@id'] : undefined;
    return typeof id === 'string' && current !== null && canonicalPost(id) === current;
  });
}
export async function postAuthorDetailed(page: Page): Promise<AuthorResult> {
  try {
    const current = canonicalPost(page.url());
    const handles = new Set<string>();
    const add = (value: unknown, href = false) => {
      if (typeof value !== 'string') return;
      const candidate = href ? value : `/${value.replace(/^@/, '')}/`;
      const handle = (href || HANDLE_HREF.test(candidate)) && parseHandle(candidate);
      if (handle) handles.add(handle);
    };
    const dialogs = await page.locator('[role="dialog"]').evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.closest('[hidden], [aria-hidden="true"]');
    }).length);
    const articles = page.locator(POST_ARTICLES);
    const scopes = await articles.evaluateAll(elements => {
      const visible = elements.flatMap((element, index) => {
        if (element.closest('nav, aside, [hidden], [aria-hidden="true"]') || element.parentElement?.closest('article')) return [];
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          ? [{ index, dialog: Boolean(element.closest('[role="dialog"]')) }] : [];
      });
      return visible.some(item => item.dialog) ? visible.filter(item => item.dialog) : visible;
    });
    if (scopes.length > 1 || dialogs > 1 || (dialogs && !scopes[0]?.dialog)) return { status: 'unreadable' };
    if (scopes.length === 1) {
      const hrefs = await articles.nth(scopes[0].index).locator('header a[href]').evaluateAll(links => links.filter(link =>
        !link.closest('nav, aside, section, ul, ol, [role="navigation"]') && !link.closest('article')?.parentElement?.closest('article'))
        .map(link => link.getAttribute('href') ?? ''));
      hrefs.forEach(href => add(href, true));
    }
    for (const record of await postMetadata(page)) {
      if (!metadataMatches(record, current)) continue;
      for (const author of [record.author].flat()) {
        if (!author || typeof author !== 'object') continue;
        const { alternateName, identifier, url } = author as Record<string, unknown>;
        add(url, true);
        add(alternateName);
        for (const identity of [identifier].flat()) {
          if (!identity || typeof identity !== 'object') continue;
          const entry = identity as Record<string, unknown>;
          if (typeof entry.propertyID === 'string' && /^(username|handle)$/i.test(entry.propertyID)) add(entry.value);
        }
      }
    }
    const descriptions = await page.locator('meta[name="description"]').evaluateAll(elements => elements.map(element => element.getAttribute('content') ?? ''));
    for (const description of descriptions) {
      // Match only the known author envelope at the start, never a caption's
      // incidental "- someone on ..." phrase. Internal IDs are not handles.
      const author = /^(?:[\d,.]+ likes?(?:, [\d,.]+ comments?)?) - ([A-Za-z0-9._]{1,30}) on (?:Instagram|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}):(?:\s|$)/.exec(description)?.[1];
      add(author);
    }
    if (handles.size > 1) return { status: 'conflict' };
    const handle = [...handles][0];
    return handle ? { status: 'resolved', handle } : { status: 'missing' };
  } catch (error) {
    propagateMediaInterruption(error);
    return { status: 'unreadable' };
  }
}
export async function postAuthor(page: Page): Promise<string | null> {
  const author = await postAuthorDetailed(page);
  return author.status === 'resolved' ? author.handle : null;
}
type IdentityCode = 'profile_identity_mismatch' | 'profile_scope_missing' | 'post_url_invalid' | 'post_url_mismatch' |
  'post_author_missing' | 'post_author_conflict' | 'post_author_mismatch' | 'post_identity_unreadable';
function identitySkip(code: IdentityCode) { health('warn', { scope: 'post_identity', code }); }
async function verifiedPost(page: Page, canonical: string, account: string): Promise<boolean> {
  try {
    const destination = canonicalPost(page.url());
    if (!destination) { identitySkip('post_url_invalid'); return false; }
    if (destination !== canonical) { identitySkip('post_url_mismatch'); return false; }
    const author = await postAuthorDetailed(page);
    if (author.status !== 'resolved') {
      identitySkip(author.status === 'missing' ? 'post_author_missing' : author.status === 'conflict' ? 'post_author_conflict' : 'post_identity_unreadable');
      return false;
    }
    if (author.handle !== account) { identitySkip('post_author_mismatch'); return false; }
    // Author reads are asynchronous too; do not accept a navigation during them.
    const final = canonicalPost(page.url());
    if (!final) { identitySkip('post_url_invalid'); return false; }
    if (final !== canonical) { identitySkip('post_url_mismatch'); return false; }
    return true;
  } catch (error) {
    propagateMediaInterruption(error);
    identitySkip('post_identity_unreadable');
    return false;
  }
}
async function profilePosts(page: Page, account: string) {
  try {
    if (parseHandle(page.url()) !== account) { identitySkip('profile_identity_mismatch'); return { links: [], anchors: 0 }; }
    const posts = await postLinksDetailed(page, { profile: account });
    if (posts.scopeMissing) identitySkip('profile_scope_missing');
    return posts;
  } catch (error) {
    propagateMediaInterruption(error);
    identitySkip('post_identity_unreadable');
    return { links: [], anchors: 0 };
  }
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
function prepareText(raw: string) {
  // Keep surviving lines separate for standalone OCR prices and price context.
  // Text privacy is independent of whether image URLs are collected.
  const text = raw.split(/[\r\n]+/).map(line => filterText(line, 6000)).filter(Boolean).join('\n').slice(0, 6000);
  return text ? { text, suggestions: toSuggestions(extract(text)) } : null;
}
export async function collectAccount(page: Page, ctx: CollectContext): Promise<{ posts: number; stories: number }> {
  const { account, state, settings, api, token } = ctx;
  const collectImages = ctx.collectImages !== false;
  const result = { posts: 0, stories: 0 };
  const accountState = state.account(account);
  const verifyPrices = priceVerificationEnabled();
  // Price verification is an external action: reserve the check before the
  // providers run, then charge each provider completion and official-page
  // request to its hourly cap. Exhaustion fails closed (the item is delivered
  // without verified evidence and stays out of the public list).
  const priceBudget = async () => {
    if (!verifyPrices || !await state.reserve('price_checks', { hourly: settings.hourly_caps.price_checks })) return null;
    const claim = (bucket: 'price_provider_calls' | 'price_official_fetches') => {
      if (!state.canSpend(bucket, { hourly: settings.hourly_caps[bucket] })) return false;
      state.spend(bucket);
      return true;
    };
    return { provider: () => claim('price_provider_calls'), fetch: () => claim('price_official_fetches') };
  };
  if (ctx.scanPosts && await state.reserve('profile_visits', { hourly: settings.hourly_caps.profile_visits })) {
    await page.goto(`https://www.instagram.com/${account}/`, { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.navigation);
    await assertHuman(page);
    if (await firstVisible(followingButton(page))) state.setFollowing(account, true);
    health('account_visit', { account });
    const requested = parseHandle(`/${account}/`);
    const { links, anchors } = await profilePosts(page, requested ?? '');
    if (!links.length) health('selector_miss', { scope: 'profile_posts', account, anchors });
    const checks = verifyPrices ? accountState.post_checks ?? {} : null;
    if (checks) accountState.post_checks = checks;
    const candidates = checks
      ? [...new Set([...links, ...Object.keys(checks)])].filter(url =>
        !checks[url]?.stopped && (!checks[url]?.price_due_at || Date.parse(checks[url].price_due_at!) <= Date.now())).sort((a, b) => (checks[a]?.checked_at ?? '').localeCompare(checks[b]?.checked_at ?? ''))
      : links.filter(link => !state.isSeen(link));
    for (const canonical of candidates.slice(0, settings.per_tick.max_posts_per_account)) {
      if (!await state.reserve('post_views', { hourly: settings.hourly_caps.post_views })) break;
      if (checks) checks[canonical] = { ...checks[canonical], checked_at: new Date().toISOString() };
      await page.goto(canonical, { waitUntil: 'domcontentloaded' });
      await sleep(...settings.delays_ms.action);
      await assertHuman(page);
      if (!requested || !await verifiedPost(page, canonical, requested)) continue;
      const caption = await readCaption(page);
      if (!caption.trim()) { health('selector_miss', { scope: 'caption', account }); continue; }
      const prepared = prepareText(caption);
      if (!prepared) continue;
      const hash = checks ? await digest(prepared.text) : undefined;
      const image_url = collectImages ? await postImageUrl(page) : undefined;
      const { text, suggestions } = prepared;
      await assertHuman(page);
      if (!await verifiedPost(page, canonical, requested)) continue;
      const captured_at = new Date().toISOString();
      const budget = await priceBudget();
      const price_evidence = budget ? await instagramPriceEvidence(canonical, text, captured_at, budget) : undefined;
      const receipt = await sendItem(api, token, { source_url: canonical, account: requested, kind: 'post', ...(image_url ? { image_url } : {}), text, captured_at, suggestions, price_evidence });
      const acknowledged = !price_evidence || !!receipt.price_evidence_id || receipt.status === 'rejected';
      if (acknowledged && price_evidence?.failed !== 'provider_retryable') {
        state.markSeen(canonical);
        if (checks && hash) checks[canonical].delivered_hash = hash;
      }
      if (checks) {
        const delay = acknowledged && price_evidence?.failed !== 'provider_retryable' ? 21_600_000 : 900_000;
        checks[canonical].price_due_at = new Date(Date.now() + delay).toISOString();
        checks[canonical].observation_id = receipt.price_evidence_id;
        checks[canonical].revision = receipt.revision;
        checks[canonical].stopped = receipt.status === 'rejected' || receipt.price_target_closed === true;
      }
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
          const prepared = prepareText(ocrText);
          if (prepared) {
            const { text, suggestions } = prepared;
            const captured_at = new Date().toISOString();
            const budget = await priceBudget();
            const price_evidence = budget ? await instagramPriceEvidence(canonical, text, captured_at, budget) : undefined;
            await sendItem(api, token, { source_url: canonical, account, kind: 'story', ...(image_url ? { image_url } : {}), text, captured_at, suggestions, price_evidence });
            if (price_evidence?.failed !== 'provider_retryable') state.markSeen(canonical);
            await state.save();
            result.stories++;
          }
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
