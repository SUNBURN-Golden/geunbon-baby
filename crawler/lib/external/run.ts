// 외부 공구 모음 사이트 수집 오케스트레이터. 결과는 항상 "후보"로만 /api/v1/ingest에 보낸다.
// 수집 오류(fetch·파싱·렌더링)는 소스 경계에서 격리하고, 수집 API 오류는 400 한 건만 건너뛴 뒤 나머지는 모두 중단한다.
import type { CrawlerState } from '../state';
import type { health as Health } from '../health';
import { IngestError, sendItem } from '../ingest';
import type { PoliteFetcher } from './fetch';
import { buildPayload } from './filter';
import { parseDetail, parseItems, type ParsedItem } from './parse';
import type { Renderer } from './render';
import { decide } from './robots';
import type { ExternalSettings, ExternalSource } from './sources';

// 서버(lib/api.ts canonicalExternalUrl)가 저장하는 정규화 URL과 같은 규칙으로 후보 표본 URL을 맞춘다.
const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|igshid|ref|from|share)$/i;
export function storedUrl(value: string): string {
  const u = new URL(value);
  const kept = [...u.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(kept).toString();
  const path = u.pathname.replace(/\/{2,}/g, '/');
  return `https://${u.hostname.toLowerCase().replace(/^www\./, '')}${path.length > 1 ? path.replace(/\/$/, '') : path}${query ? `?${query}` : ''}`;
}

export type ExternalRunDeps = {
  settings: ExternalSettings; state: CrawlerState; api: URL; token: string;
  stopped: () => boolean; fetcher: PoliteFetcher; render?: Renderer; dryRun: boolean; log: typeof Health; now?: () => Date;
};
export type ExternalRunSummary = { sources: number; items_sent: number; items_skipped: number; candidates: number };

type SourceTotals = { sent: number; skipped: number; candidates: number };

export async function runExternalSources(deps: ExternalRunDeps): Promise<ExternalRunSummary> {
  const { settings, state, dryRun, log } = deps;
  const total: ExternalRunSummary = { sources: 0, items_sent: 0, items_skipped: 0, candidates: 0 };
  for (const source of settings.sources) {
    if (deps.stopped()) break;
    if (!source.enabled) { log('external_skip', { source: source.id, reason: 'disabled' }); continue; }
    total.sources++;
    const totals: SourceTotals = { sent: 0, skipped: 0, candidates: 0 };
    try {
      await collectSource(deps, source, totals);
    } catch (error) {
      if (error instanceof IngestError) {
        total.items_sent += totals.sent; total.items_skipped += totals.skipped; total.candidates += totals.candidates;
        if (!dryRun) await state.save().catch(() => {});
        throw error;
      }
      log('error', { scope: 'external', source: source.id });
    }
    total.items_sent += totals.sent; total.items_skipped += totals.skipped; total.candidates += totals.candidates;
    if (!dryRun) await state.save();
  }
  log('external_run', { ...total, dry_run: dryRun });
  if (!dryRun) {
    state.setLastExternalRun((deps.now?.() ?? new Date()).toISOString());
    await state.save();
  }
  return total;
}

async function collectSource(deps: ExternalRunDeps, source: ExternalSource, totals: SourceTotals) {
  const { settings, fetcher, dryRun, log, state } = deps;
  const now = deps.now?.() ?? new Date();
  let blocked = 0;
  const seen = new Set<string>();
  const items: ParsedItem[] = [];
  const robotsBlock = (reason: string, resourceType: string, path: string) => { blocked++; log('robots_block', { source: source.id, reason, resource_type: resourceType, path }); };
  const addItems = (found: ParsedItem[]) => {
    for (const item of found) {
      if (items.length >= settings.max_items_per_source) break;
      if (seen.has(item.source_url)) continue;
      seen.add(item.source_url);
      items.push(item);
    }
  };

  for (const entry of source.entries.slice(0, settings.max_pages_per_source)) {
    if (deps.stopped() || items.length >= settings.max_items_per_source) break;
    const target = new URL(entry, source.origin).href;
    let found: ParsedItem[] = [];
    if (source.render !== true) {
      const page = await fetcher.get(target, { origin: source.origin, source: source.id });
      // 차단은 fetcher가 robots_block으로 이미 기록했다. 여기서는 건수만 센다.
      if (!page) { blocked++; continue; }
      found = parseItems(page.text, page.url, source.origin, source.item_selector, now);
    }
    if (source.render === true || (source.render === 'auto' && !found.length)) {
      if (!deps.render) continue;
      const robots = await fetcher.robotsFor(source.origin);
      const decision = decide(target, source.origin, robots);
      if (!decision.allowed) { robotsBlock(decision.reason, 'document', new URL(target).pathname); continue; }
      if (deps.stopped()) break;
      const rendered = await deps.render(target, {
        origin: source.origin, source: source.id, robots, item_selector: source.item_selector, timeout_ms: settings.timeout_ms,
        pace: host => fetcher.pace(host),
        onBlock: info => log('robots_block', info),
      });
      blocked += rendered.blocked;
      found = parseItems(rendered.html, target, source.origin, source.item_selector, now);
    }
    addItems(found);
  }

  // 목록에 가격·일정이 없는 항목만 같은 origin 상세 페이지에서 보충한다(상한: 소스당 max_pages_per_source회).
  if (settings.follow_detail_links) {
    let details = 0;
    for (const item of items) {
      if (deps.stopped() || details >= settings.max_pages_per_source) break;
      if (item.price && item.dates) continue;
      details++;
      const detail = await fetcher.get(item.source_url, { origin: source.origin, source: source.id });
      if (!detail) { blocked++; continue; }
      const extra = parseDetail(detail.text, now);
      item.price ??= extra.price;
      item.dates ??= extra.dates;
    }
  }

  const payloads = items.flatMap(item => { const payload = buildPayload(source.id, item, now); return payload ? [payload] : []; });
  totals.skipped += items.length - payloads.length;
  for (const payload of payloads) {
    if (deps.stopped()) break;
    if (!dryRun) {
      try { await sendItem(deps.api, deps.token, payload); }
      catch (error) {
        // 400은 항목 자체의 문제이므로 건너뛴다. 인증·경로·크기·제한·서버·네트워크 오류는 설정 문제일 수 있어 중단한다.
        if (error instanceof IngestError && error.status === 400) { log('warn', { scope: 'external', source: source.id, status: 400 }); totals.skipped++; continue; }
        throw error;
      }
      if (payload.seller_handle && !state.followingHandles.includes(payload.seller_handle)) {
        const models = (payload.suggestions.models ?? []).map(model => model.model_id);
        if (state.addCandidate(payload.seller_handle, source.id, storedUrl(payload.source_url), models, now.toISOString())) totals.candidates++;
        log('candidate_found', { handle: payload.seller_handle, via: source.id, models: models.length });
      }
    }
    if (!dryRun) totals.sent++;
  }
  const review = { items: items.length, blocked_requests: blocked, needs_review: blocked > 0 && items.length === 0 };
  log('external_source', dryRun ? { source: source.id, ...review, dry_run: true } : { source: source.id, ...review, sent: totals.sent, dry_run: false });
}
