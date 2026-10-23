// config/settings.json · config/accounts.json 로더. 형식이 어긋나면 실행을 중단한다(잘못된 속도로 동작하지 않게).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseQuietWindows, type QuietWindow } from './quiet-window';

// Keep explicitly injected values; a local secret file is an optional fallback.
export function loadEnvironment(crawlerDir: string) {
  try { process.loadEnvFile(resolve(crawlerDir, '..', '.env.crawler')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export type SeedAccount = { handle: string; brand: string; scope: 'global' | 'kr'; verified: boolean; follow: boolean; collect_images: boolean; note: string };
export type DiscoveryConfig = { hashtags: { base: string[]; brand: string[]; extra: string[] } };
export type AccountsFile = { seed_accounts: SeedAccount[]; discovery: DiscoveryConfig };
export type Settings = {
  quiet_windows: QuietWindow[];
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
const record = (v: unknown, what: string) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}는 객체여야 합니다.`); return v as Record<string, unknown>; };
const flag = (o: Record<string, unknown>, key: string, what: string, fallback?: boolean) => {
  if (fallback !== undefined && !Object.hasOwn(o, key)) return fallback;
  if (typeof o[key] !== 'boolean') throw new Error(`${what}는 true 또는 false여야 합니다.`);
  return o[key] as boolean;
};
const text = (o: Record<string, unknown>, key: string, what: string, fallback?: string) => {
  if (fallback !== undefined && !Object.hasOwn(o, key)) return fallback;
  if (typeof o[key] !== 'string') throw new Error(`${what}는 문자열이어야 합니다.`);
  return o[key] as string;
};

export function parseSettings(raw: unknown, env: Record<string, string | undefined> = {}): Settings {
  const v = record(raw, 'settings.json');
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
  const langs = text(ocr, 'langs', 'settings.json: ocr.langs', 'kor+eng');
  if (!langs) throw new Error('settings.json: ocr.langs는 비어 있지 않은 문자열이어야 합니다.');
  return {
    quiet_windows: parseQuietWindows(
      v.quiet_windows !== undefined ? v.quiet_windows : v.quiet_window !== undefined ? [v.quiet_window] : undefined,
      env.AGAMAJUNG_QUIET_WINDOWS ?? env.AGAMAJUNG_QUIET_WINDOW,
      env.AGAMAJUNG_QUIET_WINDOWS !== undefined ? 'AGAMAJUNG_QUIET_WINDOWS' : 'AGAMAJUNG_QUIET_WINDOW',
    ),
    poll_interval_minutes: pair(v.poll_interval_minutes, 'poll_interval_minutes'),
    per_tick: { max_accounts: limit(perTick.max_accounts, 'per_tick.max_accounts'), max_posts_per_account: limit(perTick.max_posts_per_account, 'per_tick.max_posts_per_account'), max_stories_per_account: limit(perTick.max_stories_per_account, 'per_tick.max_stories_per_account') },
    hourly_caps: { profile_visits: limit(caps.profile_visits, 'hourly_caps.profile_visits'), post_views: limit(caps.post_views, 'hourly_caps.post_views'), story_opens: limit(caps.story_opens, 'hourly_caps.story_opens'), follows: limit(caps.follows, 'hourly_caps.follows'), hashtag_pages: limit(caps.hashtag_pages, 'hourly_caps.hashtag_pages') },
    follow: { daily_cap: limit(follow.daily_cap, 'follow.daily_cap'), allow_unverified: flag(follow, 'allow_unverified', 'settings.json: follow.allow_unverified', false), gap_seconds: pair(follow.gap_seconds, 'follow.gap_seconds') },
    delays_ms: { navigation: pair(delays.navigation, 'delays_ms.navigation'), action: pair(delays.action, 'delays_ms.action'), login: pair(delays.login, 'delays_ms.login') },
    discovery: { enabled: flag(discovery, 'enabled', 'settings.json: discovery.enabled'), posts_per_tag: limit(discovery.posts_per_tag, 'discovery.posts_per_tag'), min_interval_hours: positive(discovery.min_interval_hours, 'discovery.min_interval_hours') },
    ocr: { enabled: flag(ocr, 'enabled', 'settings.json: ocr.enabled'), langs, timeout_ms: positive(ocr.timeout_ms, 'ocr.timeout_ms') },
    staleness: { account_recheck_minutes: positive(staleness.account_recheck_minutes, 'staleness.account_recheck_minutes'), story_recheck_minutes: positive(staleness.story_recheck_minutes, 'staleness.story_recheck_minutes') },
  };
}

export function parseAccounts(raw: unknown): AccountsFile {
  const v = record(raw, 'accounts.json');
  if (!Array.isArray(v.seed_accounts)) throw new Error('accounts.json: seed_accounts는 배열이어야 합니다.');
  const allowed = new Set(['handle', 'brand', 'scope', 'verified', 'follow', 'collect_images', 'note', '$comment']);
  const parsed: SeedAccount[] = v.seed_accounts.map((a, i) => {
    const path = `accounts.json: seed_accounts[${i}]`;
    const item = record(a, path);
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error(`${path}에 허용되지 않은 키가 있습니다.`);
    if (typeof item.handle !== 'string' || !/^[A-Za-z0-9._]{1,30}$/.test(item.handle)) throw new Error(`accounts.json: 잘못된 핸들: seed_accounts[${i}].handle`);
    const handle = item.handle.toLowerCase();
    if (item.scope !== 'global' && item.scope !== 'kr') throw new Error(`${path}.scope는 global 또는 kr이어야 합니다.`);
    return { handle, brand: text(item, 'brand', `${path}.brand`, ''), scope: item.scope, verified: flag(item, 'verified', `${path}.verified`), follow: flag(item, 'follow', `${path}.follow`), collect_images: flag(item, 'collect_images', `${path}.collect_images`, true), note: text(item, 'note', `${path}.note`, '') };
  });
  const seen = new Set<string>();
  for (const { handle } of parsed) {
    if (seen.has(handle)) throw new Error(`중복된 핸들: ${handle}`);
    seen.add(handle);
  }
  const tags = Object.hasOwn(v, 'discovery')
    ? record(record(v.discovery, 'accounts.json: discovery').hashtags, 'accounts.json: discovery.hashtags') : {};
  const list = (key: string): string[] => {
    if (!Object.hasOwn(tags, key)) return [];
    const xs = tags[key];
    if (!Array.isArray(xs) || xs.some(x => typeof x !== 'string')) throw new Error(`accounts.json: discovery.hashtags.${key}는 문자열 배열이어야 합니다.`);
    return xs as string[];
  };
  return { seed_accounts: parsed, discovery: { hashtags: { base: list('base'), brand: list('brand'), extra: list('extra') } } };
}

export async function loadConfig(crawlerDir: string): Promise<{ settings: Settings; accounts: AccountsFile }> {
  const settings = parseSettings(await readJson(resolve(crawlerDir, 'config', 'settings.json')), process.env);
  const accounts = parseAccounts(await readJson(resolve(crawlerDir, 'config', 'accounts.json')));
  const ocr = process.env.AGAMAJUNG_OCR;
  if (ocr !== undefined && ocr !== '') {
    if (ocr !== '0' && ocr !== '1') throw new Error('AGAMAJUNG_OCR은 0 또는 1이어야 합니다.');
    settings.ocr.enabled = ocr === '1';
  }
  if (process.env.AGAMAJUNG_OCR_LANG) settings.ocr.langs = process.env.AGAMAJUNG_OCR_LANG;
  return { settings, accounts };
}
