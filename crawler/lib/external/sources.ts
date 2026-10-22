// crawler/config/external-sources.json 로더와 검증. 잘못된 값은 실행 전 오류다(잘못된 속도·대상으로 동작하지 않게).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EXTERNAL_SOURCES, externalSourceIds, type ExternalSourceId } from '../../../lib/data';
import { isDeniedHost, isHardBlockedPath } from './robots';

export type ExternalSource = { id: ExternalSourceId; enabled: boolean; origin: string; entries: string[]; render: boolean | 'auto'; item_selector: string };
export type ExternalSettings = {
  min_interval_ms: number; jitter_ms: [number, number]; timeout_ms: number;
  max_pages_per_source: number; max_items_per_source: number; follow_detail_links: boolean;
  sources: ExternalSource[];
};

const fail = (what: string): never => { throw new Error(`external-sources.json: ${what} 값이 잘못되었습니다.`); };
const integer = (v: unknown, what: string, min: number, max: number) => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fail(what));

export function parseExternalSettings(raw: unknown): ExternalSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('external-sources.json 형식 오류');
  const v = raw as Record<string, unknown>;
  const jitter = v.jitter_ms;
  if (!Array.isArray(jitter) || jitter.length !== 2 || jitter.some(n => !Number.isSafeInteger(n) || n < 0) || jitter[1] < jitter[0]) fail('jitter_ms');
  if (typeof v.follow_detail_links !== 'boolean') fail('follow_detail_links');
  if (!Array.isArray(v.sources) || !v.sources.length) fail('sources');
  const seen = new Set<string>();
  const sources = (v.sources as unknown[]).map((entry): ExternalSource => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('sources[]');
    const s = entry as Record<string, unknown>;
    const id = s.id as ExternalSourceId;
    if (typeof id !== 'string' || !Object.hasOwn(EXTERNAL_SOURCES, id) || seen.has(id)) return fail('sources[].id');
    seen.add(id);
    if (typeof s.enabled !== 'boolean') fail(`${id}.enabled`);
    let origin: URL;
    try { origin = new URL(s.origin as string); } catch { return fail(`${id}.origin`); }
    const host = origin.hostname.toLowerCase();
    if (isDeniedHost(host)) fail(`${id}.origin(수집 금지 사이트)`);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash ||
      s.origin !== origin.origin || ![EXTERNAL_SOURCES[id].host, `www.${EXTERNAL_SOURCES[id].host}`].includes(host)) fail(`${id}.origin`);
    if (!Array.isArray(s.entries) || !s.entries.length || s.entries.length > 10) fail(`${id}.entries`);
    const entries = (s.entries as unknown[]).map(entryPath => {
      if (typeof entryPath !== 'string' || !entryPath.startsWith('/') || entryPath.startsWith('//') || entryPath.includes('#')) return fail(`${id}.entries`);
      let pathname: string;
      try { pathname = new URL(entryPath, origin).pathname; } catch { return fail(`${id}.entries`); }
      if (isHardBlockedPath(pathname)) fail(`${id}.entries(금지 경로)`);
      return entryPath;
    });
    if (s.render !== true && s.render !== false && s.render !== 'auto') fail(`${id}.render`);
    if (s.item_selector !== undefined && (typeof s.item_selector !== 'string' || s.item_selector.length > 200)) fail(`${id}.item_selector`);
    return { id, enabled: s.enabled as boolean, origin: origin.origin, entries, render: s.render as boolean | 'auto', item_selector: (s.item_selector as string | undefined) ?? '' };
  });
  return {
    min_interval_ms: integer(v.min_interval_ms, 'min_interval_ms(1000 이상)', 1000, 600_000),
    jitter_ms: [(jitter as number[])[0], (jitter as number[])[1]],
    timeout_ms: integer(v.timeout_ms, 'timeout_ms', 1000, 120_000),
    max_pages_per_source: integer(v.max_pages_per_source, 'max_pages_per_source', 1, 10),
    max_items_per_source: integer(v.max_items_per_source, 'max_items_per_source', 1, 200),
    follow_detail_links: v.follow_detail_links as boolean,
    // 수집 순서는 EXTERNAL_SOURCES 순서(공구팡팡, 맘캘린더, BUYG, 스냅업)로 고정한다.
    sources: sources.sort((a, b) => externalSourceIds.indexOf(a.id) - externalSourceIds.indexOf(b.id)),
  };
}

export async function loadExternalSettings(crawlerDir: string): Promise<ExternalSettings> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(resolve(crawlerDir, 'config', 'external-sources.json'), 'utf8')); }
  catch { throw new Error('설정 파일을 읽을 수 없습니다: external-sources.json. JSON 형식을 확인하세요.'); }
  return parseExternalSettings(raw);
}
