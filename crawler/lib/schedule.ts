import type { Signals } from './activity';
import type { CrawlerState } from './state';
import type { SeedAccount, Settings } from './config';

export type ScanJob = { account: string; posts: boolean; stories: boolean };
// A persistent story/notification signal never forces another full profile scan.
export function planScans(signals: Signals, state: CrawlerState, seeds: SeedAccount[], settings: Settings, now = Date.now()): ScanJob[] {
  const eligible = seeds.filter(s => s.verified || state.isFollowing(s.handle)).map(s => s.handle);
  const watch = new Set([...eligible, ...state.followingHandles]);
  const stories = new Set(signals.storyAccounts);
  const fresh = new Set(signals.freshAccounts);
  const due = (at: string | undefined, minutes: number) => !at || now - Date.parse(at) >= minutes * 60000;
  return [...watch].map(account => {
    const saved = state.account(account);
    const posts = due(saved.last_checked, settings.staleness.account_recheck_minutes);
    const story = settings.ocr.enabled && stories.has(account) && due(saved.last_story_at, settings.staleness.story_recheck_minutes);
    return { account, posts, stories: story, score: (story ? 4 : 0) + (fresh.has(account) ? 2 : 0), last: saved.last_checked ?? '' };
  }).filter(job => job.posts || job.stories)
    .sort((a, b) => b.score - a.score || a.last.localeCompare(b.last) || a.account.localeCompare(b.account))
    .slice(0, settings.per_tick.max_accounts)
    .map(({ account, posts, stories }) => ({ account, posts, stories }));
}
