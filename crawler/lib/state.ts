// 재시작해도 유지되는 크롤러 상태: 중복 URL 이력, 계정별 확인 시점, 시간대별 행동 카운터,
// 해시태그 탐색으로 발견한 공구 셀러·팔이피플 후보. crawler/.cache/state.json(0600)에 저장한다.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { kstDayKey, kstHourKey } from './util';

export type Candidate = { handle: string; found_via: string; first_seen: string; last_seen: string; hits: number; sample_urls: string[]; matched_models: string[] };
export type AccountState = { following?: boolean; followed_at?: string; last_follow_attempt?: string; last_checked?: string; last_story_at?: string; last_post_urls?: string[] };
type StateData = {
  seen: string[];
  accounts: Record<string, AccountState>;
  daily: Record<string, number>;
  hourly: Record<string, number>;
  candidates: Record<string, Candidate>;
  last_discovery?: string;
  last_follow_at?: string;
  last_following_sync_attempt?: string;
  next_follow_at?: string;
  discovery_cursor?: number;
  discovery_seen: string[];
};
const empty = (): StateData => ({ seen: [], accounts: {}, daily: {}, hourly: {}, candidates: {}, discovery_seen: [] });

export class CrawlerState {
  private constructor(private data: StateData, private file: string) {}
  static async open(file: string): Promise<CrawlerState> {
    let parsed: StateData;
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('크롤러 상태 형식 오류');
      parsed = { ...empty(), ...raw as StateData };
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('크롤러 상태를 읽을 수 없습니다. 파일을 수동 점검하세요.');
      parsed = empty();
    }
    for (const field of ['accounts', 'daily', 'hourly', 'candidates'] as const) {
      if (!parsed[field] || typeof parsed[field] !== 'object' || Array.isArray(parsed[field])) throw new Error('크롤러 상태 형식 오류');
    }
    if (!Array.isArray(parsed.seen) || !Array.isArray(parsed.discovery_seen) ||
      [...Object.values(parsed.daily), ...Object.values(parsed.hourly)].some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('크롤러 상태 형식 오류');
    return new CrawlerState(parsed, file);
  }
  async save() {
    // 이틀 이전 카운터는 정리해 파일이 자라지 않게 한다.
    const cutoff = kstDayKey(new Date(Date.now() - 2 * 86_400_000));
    for (const key of Object.keys(this.data.daily)) if (key.slice(0, 10) < cutoff) delete this.data.daily[key];
    for (const key of Object.keys(this.data.hourly)) if (key.slice(0, 10) < cutoff) delete this.data.hourly[key];
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.file), 0o700);
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
  }
  isSeen(url: string) { return this.data.seen.includes(url); }
  markSeen(url: string) { this.data.seen = [...new Set([...this.data.seen, url])].slice(-10000); }
  account(handle: string): AccountState { return (this.data.accounts[handle] ??= {}); }
  isFollowing(handle: string) { return this.account(handle).following === true; }
  get followingHandles(): string[] { return Object.entries(this.data.accounts).filter(([, a]) => a.following).map(([handle]) => handle); }
  setFollowing(handle: string, following: boolean, at = new Date().toISOString()) {
    const a = this.account(handle);
    a.following = following;
    if (following && a.followed_at === undefined) a.followed_at = at;
  }
  countDay(bucket: string) { return this.data.daily[`${kstDayKey()}:${bucket}`] ?? 0; }
  countHour(bucket: string) { return this.data.hourly[`${kstHourKey()}:${bucket}`] ?? 0; }
  canSpend(bucket: string, caps: { hourly?: number; daily?: number } = {}) {
    if (caps.hourly !== undefined && this.countHour(bucket) >= caps.hourly) return false;
    if (caps.daily !== undefined && this.countDay(bucket) >= caps.daily) return false;
    return true;
  }
  spend(bucket: string) {
    const day = `${kstDayKey()}:${bucket}`;
    const hour = `${kstHourKey()}:${bucket}`;
    this.data.daily[day] = (this.data.daily[day] ?? 0) + 1;
    this.data.hourly[hour] = (this.data.hourly[hour] ?? 0) + 1;
  }
  // Reserve and persist before the external action, including ambiguous failures.
  async reserve(bucket: string, caps: { hourly?: number; daily?: number }) {
    if (!this.canSpend(bucket, caps)) return false;
    this.spend(bucket);
    await this.save();
    return true;
  }
  get lastFollowAt(): string | undefined { return this.data.last_follow_at; }
  set lastFollowAt(value: string) { this.data.last_follow_at = value; }
  get lastFollowingSyncAttempt(): string | undefined { return this.data.last_following_sync_attempt; }
  set lastFollowingSyncAttempt(value: string) { this.data.last_following_sync_attempt = value; }
  get nextFollowAt(): string | undefined { return this.data.next_follow_at; }
  set nextFollowAt(value: string) { this.data.next_follow_at = value; }
  get discoveryCursor(): number { return this.data.discovery_cursor ?? 0; }
  set discoveryCursor(value: number) { this.data.discovery_cursor = value; }
  isDiscoverySeen(url: string) { return this.data.discovery_seen.includes(url); }
  markDiscoverySeen(url: string) { this.data.discovery_seen = [...new Set([...this.data.discovery_seen, url])].slice(-10000); }
  get lastDiscovery(): string | undefined { return this.data.last_discovery; }
  set lastDiscovery(value: string) { this.data.last_discovery = value; }
  // 발견된 후보는 검수 대상으로만 기록한다. 자동 팔로우하지 않는다.
  addCandidate(handle: string, foundVia: string, sampleUrl: string, matchedModels: string[], now = new Date().toISOString()): boolean {
    const existing = this.data.candidates[handle];
    if (existing) {
      existing.last_seen = now;
      existing.hits += 1;
      existing.sample_urls = existing.sample_urls.includes(sampleUrl) ? existing.sample_urls : [...existing.sample_urls, sampleUrl].slice(-3);
      existing.matched_models = [...new Set([...existing.matched_models, ...matchedModels])].slice(0, 8);
      return false;
    }
    this.data.candidates[handle] = { handle, found_via: foundVia, first_seen: now, last_seen: now, hits: 1, sample_urls: [sampleUrl], matched_models: matchedModels.slice(0, 8) };
    return true;
  }
  get candidates(): Candidate[] { return Object.values(this.data.candidates); }
}

export const statePath = (crawlerDir: string) => resolve(crawlerDir, '.cache', 'state.json');
