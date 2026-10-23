import type { Page } from 'playwright';
import { assertHuman, guardPage } from './browser';
import type { Settings } from './config';
import type { CrawlerState } from './state';
import { firstVisible, HANDLE_HREF, parseHandle, profileLink, visibleHandles } from './selectors';
import { QuietWindowError, quietWindowsAt } from './quiet-window';
import { sleep } from './util';
import { health } from './health';

// Reserve before navigation: failed/interrupted attempts and restarts share the
// same 24-hour limit. Resolve the authenticated profile from navigation because
// the login identifier may be an email rather than a profile handle.
export async function syncFollowing(page: Page, ctx: { state: CrawlerState; settings: Settings; username?: string }, check: () => void = () => {}) {
  const { state, settings } = ctx;
  const active = () => {
    check();
    if (quietWindowsAt(settings.quiet_windows, Date.now()).active) throw new QuietWindowError();
  };
  active();
  if (state.lastFollowingSyncAttempt && Date.now() - Date.parse(state.lastFollowingSyncAttempt) < 86_400_000) return;
  if (!await state.reserve('profile_visits', { hourly: settings.hourly_caps.profile_visits })) return;
  state.lastFollowingSyncAttempt = new Date().toISOString();
  await state.save();
  const guarded = guardPage(page, active);
  try {
    await guarded.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.navigation);
    await assertHuman(guarded);
    let handle = await profileLink(guarded, ctx.username);
    if (!handle && ctx.username && HANDLE_HREF.test(`/${ctx.username}/`)) {
      handle = parseHandle(`/${ctx.username}/`);
      if (handle) health('following_profile_fallback', { via: 'username' });
    }
    if (!handle) { health('selector_miss', { scope: 'following_profile' }); return; }
    await guarded.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded' });
    await sleep(...settings.delays_ms.navigation);
    await assertHuman(guarded);
    const following = await firstVisible([guarded.locator(`a[href="/${handle}/following/"]`)]);
    if (!following) { health('selector_miss', { scope: 'following_link' }); return; }
    await following.click();
    await sleep(...settings.delays_ms.action);
    await assertHuman(guarded);
    const dialog = await firstVisible([guarded.getByRole('dialog')]);
    if (!dialog) { health('selector_miss', { scope: 'following_dialog' }); return; }
    const found = new Set<string>();
    let idle = 0;
    // Bound long lists; merge each batch so virtualization, UI failures, or quiet
    // interruption cannot erase known follows or discard an already read batch.
    for (let n = 0; n < 50 && idle < 2; n++) {
      await assertHuman(guarded);
      const before = found.size;
      for (const account of await visibleHandles(guarded, dialog)) {
        if (account === handle) continue;
        found.add(account);
        state.setFollowing(account, true);
      }
      await state.save();
      idle = found.size === before ? idle + 1 : 0;
      if (idle >= 2 || n === 49) break;
      await dialog.evaluate(root => {
        const scroller = [root, ...root.querySelectorAll('*')].find(el =>
          el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY));
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await sleep(...settings.delays_ms.action);
    }
    health('following_sync', { accounts: found.size, bounded: idle < 2 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('halt:')) throw error;
    health('error', { scope: 'following_sync' });
  }
}
