// Discovery persists review candidates separately from ingested content.
import type { Page } from 'playwright';
import type { CrawlerState } from './state';
import type { AccountsFile, Settings } from './config';
import { assertHuman } from './browser';
import { parseHandle, postLinksDetailed } from './selectors';
import { sleep } from './util';
import { health } from './health';
import { extract } from './extract';
import { postAuthor, readCaption } from './collect';

export function discoveryTags(accounts: AccountsFile): string[] {
  return [...new Set(Object.values(accounts.discovery.hashtags).flat()
    .map(tag => tag.trim().replace(/^#+/, '')).filter(tag => /^[\p{L}\p{N}_]+$/u.test(tag)))];
}
export function parseCandidate(author: string, text: string): { handle: string; models: string[] } | null {
  const handle = parseHandle(author.startsWith('/') || author.startsWith('https://') ? author : `/${author}/`);
  if (!handle) return null;
  const models = extract(text).models.filter(m => m.confidence >= 0.75).map(m => `${m.brand} ${m.name}`);
  if (!models.length && !/공구|공동\s*구매|팔이피플/.test(text)) return null;
  return { handle, models };
}
export async function discoverSellers(page: Page, ctx: { accounts: AccountsFile; state: CrawlerState; settings: Settings }): Promise<number> {
  const { accounts, state, settings } = ctx;
  if (!settings.discovery.enabled) return 0;
  if (state.lastDiscovery && Date.now() - Date.parse(state.lastDiscovery) < settings.discovery.min_interval_hours * 3_600_000) return 0;
  const tags = discoveryTags(accounts);
  if (!tags.length || !await state.reserve('hashtag_pages', { hourly: settings.hourly_caps.hashtag_pages })) return 0;
  // One tag per pass keeps the short signal cycle responsive. Rotate across restarts.
  const tag = tags[state.discoveryCursor % tags.length];
  state.discoveryCursor = (state.discoveryCursor + 1) % tags.length;
  state.lastDiscovery = new Date().toISOString();
  await state.save();
  await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, { waitUntil: 'domcontentloaded' });
  await sleep(...settings.delays_ms.navigation);
  await assertHuman(page);
  let found = 0;
  const posts = await postLinksDetailed(page);
  const links = posts.links.slice(0, settings.discovery.posts_per_tag);
  if (!links.length) health('selector_miss', { scope: 'discovery_posts', anchors: posts.anchors });
  for (const canonical of links) {
    if (state.isDiscoverySeen(canonical)) continue;
    if (!await state.reserve('post_views', { hourly: settings.hourly_caps.post_views })) break;
    await page.goto(canonical, { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.action);
    await assertHuman(page);
    const text = await readCaption(page);
    const handle = await postAuthor(page);
    if (!text.trim()) health('selector_miss', { scope: 'discovery_caption' });
    if (!handle) health('selector_miss', { scope: 'discovery_author' });
    if (!handle || !text.trim()) continue;
    const candidate = parseCandidate(handle, text);
    if (candidate) {
      if (state.addCandidate(candidate.handle, `#${tag}`, canonical, candidate.models)) found++;
      health('candidate_found', { handle: candidate.handle, via: `#${tag}`, models: candidate.models.length });
    }
    state.markDiscoverySeen(canonical);
    await state.save();
  }
  health('discovery', { tags: 1, new_candidates: found, total_candidates: state.candidates.length });
  return found;
}
