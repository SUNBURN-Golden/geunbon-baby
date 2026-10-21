// 공구 셀러·팔이피플 발견: #공구 #육아공구 #트립트랩공구·브랜드 해시태그 태그 페이지를
// 느리게 훑고, 공구 키워드나 시드 모델이 보이는 게시물의 계정을 '후보'로만 기록한다.
// 발견된 계정을 자동으로 팔로우하지 않는다. 운영자가 crawler/.cache/state.json candidates 와
// 원문을 검수한 뒤 crawler/config/accounts.json 에 옮겨야 팔로우 후보가 된다.
import type { Page } from 'playwright';
import type { CrawlerState } from './state';
import type { AccountsFile, Settings } from './config';
import { assertHuman } from './browser';
import { postLinks } from './selectors';
import { sleep } from './util';
import { health } from './health';
import { extract } from './extract';
import { postAuthor, readCaption } from './collect';

export async function discoverSellers(page: Page, ctx: { accounts: AccountsFile; state: CrawlerState; settings: Settings }): Promise<number> {
  const { accounts, state, settings } = ctx;
  if (!settings.discovery.enabled) return 0;
  if (state.lastDiscovery && Date.now() - Date.parse(state.lastDiscovery) < settings.discovery.min_interval_hours * 3_600_000) return 0;
  const tags = [...accounts.discovery.hashtags.base, ...accounts.discovery.hashtags.brand, ...accounts.discovery.hashtags.extra];
  let found = 0;
  for (const tag of tags) {
    if (!state.canSpend('hashtag_pages', { hourly: settings.hourly_caps.hashtag_pages })) break;
    state.spend('hashtag_pages');
    await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.navigation);
    await assertHuman(page);
    const links = (await postLinks(page)).slice(0, settings.discovery.posts_per_tag);
    for (const link of links) {
      if (!state.canSpend('post_views', { hourly: settings.hourly_caps.post_views })) break;
      const pathname = new URL(link, 'https://www.instagram.com/').pathname;
      const canonical = `https://www.instagram.com${pathname.endsWith('/') ? pathname : `${pathname}/`}`;
      if (state.isSeen(canonical)) continue;
      state.spend('post_views');
      await page.goto(canonical, { waitUntil: 'domcontentloaded' });
      await sleep(...settings.delays_ms.action);
      await assertHuman(page);
      const text = await readCaption(page);
      const handle = await postAuthor(page);
      if (!handle) continue;
      const extraction = extract(text);
      const gonggu = /공구|공동구매/.test(text);
      if (extraction.models.length || gonggu) {
        const isNew = state.addCandidate(handle, `#${tag}`, canonical, extraction.models.map(m => `${m.brand} ${m.name}`));
        if (isNew) found += 1;
        health('candidate_found', { handle, via: `#${tag}`, models: extraction.models.length });
      }
      state.markSeen(canonical);
    }
  }
  state.lastDiscovery = new Date().toISOString();
  health('discovery', { tags: tags.length, new_candidates: found, total_candidates: state.candidates.length });
  return found;
}
