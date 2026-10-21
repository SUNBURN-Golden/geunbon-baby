// config/settings.json · config/accounts.json 로더. 형식이 어긋나면 실행을 중단한다(잘못된 속도로 동작하지 않게).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SeedAccount = { handle: string; brand: string; scope: 'global' | 'kr'; verified: boolean; follow: boolean; note: string };
export type DiscoveryConfig = { hashtags: { base: string[]; brand: string[]; extra: string[] } };
export type AccountsFile = { seed_accounts: SeedAccount[]; discovery: DiscoveryConfig };
export type Settings = {
  poll_interval_minutes: [number, number];
  per_tick: { max_accounts: number; max_posts_per_account: number; max_stories_per_account: number };
  hourly_caps: { profile_visits: number; post_views: number; story_opens: number; follows: number; hashtag_pages: number };
  follow: { daily_cap: number; allow_unverified: boolean; gap_seconds: [number, number] };
  delays_ms: { navigation: [number, number]; action: [number, number]; login: [number, number] };
  discovery: { enabled: boolean; posts_per_tag: number; min_interval_hours: number };
  ocr: { enabled: boolean; langs: string; timeout_ms: number };
  staleness: { account_recheck_minutes: number; story_recheck_minutes: number };
};

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`설정 파일을 읽을 수 없습니다: ${path}. JSON 형식을 확인하세요.`); }
}
const pair = (v: unknown, what: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2 || v.some(x => !Number.isFinite(x) || (x as number) <= 0) || v[1] < v[0]) throw new Error(`${what} 값이 잘못되었습니다.`);
  return [v[0] as number, v[1] as number];
};
const limit = (v: unknown, what: string) => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`${what} 값이 잘못되었습니다.`); return v as number; };
const positive = (v: unknown, what: string) => { if (!Number.isFinite(v) || (v as number) <= 0) throw new Error(`${what} 값이 잘못되었습니다.`); return v as number; };

export function parseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') throw new Error('settings.json 형식 오류');
  const v = raw as Record<string, unknown>;
  for (const key of ['per_tick', 'hourly_caps', 'follow', 'delays_ms', 'discovery', 'ocr', 'staleness']) {
    if (!v[key] || typeof v[key] !== 'object' || Array.isArray(v[key])) throw new Error(`settings.json: ${key} 형식 오류`);
  }
  const perTick = v.per_tick as Record<string, unknown>;
  const caps = v.hourly_caps as Record<string, unknown>;
  const follow = v.follow as Record<string, unknown>;
  const delays = v.delays_ms as Record<string, unknown>;
  const discovery = v.discovery as Record<string, unknown>;
  const ocr = v.ocr as Record<string, unknown>;
  const staleness = v.staleness as Record<string, unknown>;
  return {
    poll_interval_minutes: pair(v.poll_interval_minutes, 'poll_interval_minutes'),
    per_tick: { max_accounts: limit(perTick.max_accounts, 'per_tick.max_accounts'), max_posts_per_account: limit(perTick.max_posts_per_account, 'per_tick.max_posts_per_account'), max_stories_per_account: limit(perTick.max_stories_per_account, 'per_tick.max_stories_per_account') },
    hourly_caps: { profile_visits: limit(caps.profile_visits, 'hourly_caps.profile_visits'), post_views: limit(caps.post_views, 'hourly_caps.post_views'), story_opens: limit(caps.story_opens, 'hourly_caps.story_opens'), follows: limit(caps.follows, 'hourly_caps.follows'), hashtag_pages: limit(caps.hashtag_pages, 'hourly_caps.hashtag_pages') },
    follow: { daily_cap: limit(follow.daily_cap, 'follow.daily_cap'), allow_unverified: follow.allow_unverified === true, gap_seconds: pair(follow.gap_seconds, 'follow.gap_seconds') },
    delays_ms: { navigation: pair(delays.navigation, 'delays_ms.navigation'), action: pair(delays.action, 'delays_ms.action'), login: pair(delays.login, 'delays_ms.login') },
    discovery: { enabled: discovery.enabled === true, posts_per_tag: limit(discovery.posts_per_tag, 'discovery.posts_per_tag'), min_interval_hours: positive(discovery.min_interval_hours, 'discovery.min_interval_hours') },
    ocr: { enabled: ocr.enabled === true, langs: typeof ocr.langs === 'string' && ocr.langs ? ocr.langs : 'kor+eng', timeout_ms: positive(ocr.timeout_ms, 'ocr.timeout_ms') },
    staleness: { account_recheck_minutes: positive(staleness.account_recheck_minutes, 'staleness.account_recheck_minutes'), story_recheck_minutes: positive(staleness.story_recheck_minutes, 'staleness.story_recheck_minutes') },
  };
}

function parseAccounts(raw: unknown): AccountsFile {
  if (!raw || typeof raw !== 'object') throw new Error('accounts.json 형식 오류');
  const v = raw as Record<string, unknown>;
  const accounts = Array.isArray(v.seed_accounts) ? v.seed_accounts : [];
  const parsed: SeedAccount[] = accounts.map(a => {
    const item = a as Record<string, unknown>;
    const handle = String(item.handle ?? '').toLowerCase();
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) throw new Error(`잘못된 핸들: ${handle || '(없음)'}`);
    return { handle, brand: String(item.brand ?? ''), scope: item.scope === 'kr' ? 'kr' : 'global', verified: item.verified === true, follow: item.follow === true, note: String(item.note ?? '') };
  });
  const tags = (v.discovery as Record<string, unknown> | undefined)?.hashtags as Record<string, string[]> | undefined;
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map(String).filter(Boolean) : []);
  return { seed_accounts: parsed, discovery: { hashtags: { base: list(tags?.base), brand: list(tags?.brand), extra: list(tags?.extra) } } };
}

export async function loadConfig(crawlerDir: string): Promise<{ settings: Settings; accounts: AccountsFile }> {
  const settings = parseSettings(await readJson(resolve(crawlerDir, 'config', 'settings.json')));
  const accounts = parseAccounts(await readJson(resolve(crawlerDir, 'config', 'accounts.json')));
  // 환경변수는 OCR 스위치만 덮어쓴다(기본 켜짐, 0이면 끔).
  if (process.env.AGAMAJUNG_OCR === '0') settings.ocr.enabled = false;
  if (process.env.AGAMAJUNG_OCR === '1') settings.ocr.enabled = true;
  if (process.env.AGAMAJUNG_OCR_LANG) settings.ocr.langs = process.env.AGAMAJUNG_OCR_LANG;
  return { settings, accounts };
}
