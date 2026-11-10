/** Read-only queue projection. Never instantiate runner, cache, runtime store or writer. */
import { canonicalUrl } from '../../../shared/privacy-rules';
import { interpretSchedule } from '../../lib/deal-fact-check';
import { kstDate, kstDay, kstWeek } from '../../lib/kst';
import { readQueue } from './review-queue';
import { isCheckedExtraction } from './extract';
import type { ReviewQueueItem } from './types';
export type Exclusion = 'future_week' | 'ended';
export type WeeklyDeal = { id: string; url: string; title: string; facts: { gonggu_price: number | null; regular_price: number | null; start_date: ReviewQueueItem['extraction']['start_date']; end_date: ReviewQueueItem['extraction']['end_date'] }; warnings: string[]; missing_fields: string[] };
export type WeeklyPacket = {
  version: 'weekly-review@1'; generated_at: string; week_kst: { start: string; end_exclusive: string };
  deals: WeeklyDeal[]; excluded: (WeeklyDeal & { reasons: Exclusion[] })[];
  counts: { latest: number; reviewable: number; excluded: number; reasons: Record<Exclusion, number>; omitted: { decisions: number; out_of_scope: number } };
};
export async function weeklyReview(dir: string, now = Date.now()): Promise<WeeklyPacket> {
  try {
    if (!Number.isFinite(now)) throw new Error();
    const week = kstWeek(now);
    const packet: WeeklyPacket = { version: 'weekly-review@1', generated_at: new Date(now).toISOString(), week_kst: { start: `${kstDate(week.start)}T00:00:00+09:00`, end_exclusive: `${kstDate(week.end)}T00:00:00+09:00` }, deals: [], excluded: [], counts: { latest: 0, reviewable: 0, excluded: 0, reasons: { future_week: 0, ended: 0 }, omitted: { decisions: 0, out_of_scope: 0 } } };
    const latest = new Map<string, ReviewQueueItem>();
    for (const row of await readQueue(dir)) latest.set(canonicalUrl(row.extraction.url), row);
    packet.counts.latest = latest.size;
    for (const row of latest.values()) {
      if (row.status !== 'pending') { packet.counts.omitted.decisions++; continue; }
      const e = row.extraction;
      if (!e.in_scope) { packet.counts.omitted.out_of_scope++; continue; }
      const checked = isCheckedExtraction(e), c = checked ? e.fact_check! : null;
      const facts = { gonggu_price: c?.fields.gonggu_price.value ?? null, regular_price: c?.fields.regular_price.value ?? null, start_date: c?.fields.start_date.value ?? null, end_date: c?.fields.end_date.value ?? null };
      const deal: WeeklyDeal = { id: row.id, url: e.url, title: `${e.brand} ${e.model}`, facts, warnings: [], missing_fields: Object.entries(facts).filter(([, v]) => v === null).map(([k]) => k) };
      const reasons: Exclusion[] = [];
      if (!c) deal.warnings.push('needs_fact_check');
      else {
        const timing = interpretSchedule(c);
        if (c.truncated) deal.warnings.push('source_truncated');
        if (timing.start.year_ambiguous || timing.end.year_ambiguous) deal.warnings.push('year_ambiguous');
        if (timing.start.at !== null && timing.start.at >= week.end) reasons.push('future_week');
        if (timing.end.at !== null && timing.end.at < now) reasons.push('ended');
        if (timing.start.at !== null && facts.end_date === null && kstDay(now) - kstDay(timing.start.at) > 7) deal.warnings.push('possibly_ended');
      }
      if (reasons.length) { packet.excluded.push({ ...deal, reasons }); reasons.forEach(reason => packet.counts.reasons[reason]++); }
      else packet.deals.push(deal);
    }
    packet.counts.reviewable = packet.deals.length; packet.counts.excluded = packet.excluded.length;
    return packet;
  } catch { throw new Error('weekly_review_unavailable'); }
}
export function formatWeeklyReview(p: WeeklyPacket): string {
  const lines = [`주간 검토 ${p.week_kst.start} ~ ${p.week_kst.end_exclusive} (종료 경계 제외)`, `생성 ${p.generated_at}`, `전체 최신 ${p.counts.latest} · 검토 ${p.counts.reviewable} · 제외 ${p.counts.excluded} (future_week ${p.counts.reasons.future_week}, ended ${p.counts.reasons.ended}) · 결정 완료 ${p.counts.omitted.decisions} · 범위 밖 ${p.counts.omitted.out_of_scope}`];
  const date = (d: NonNullable<WeeklyDeal['facts']['start_date']>) => `${d.year === null ? '연도 미기재' : d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}${d.hour === null ? '' : ` ${String(d.hour).padStart(2, '0')}${d.minute === null ? '시' : ':' + String(d.minute).padStart(2, '0') + (d.second === null ? '' : ':' + String(d.second).padStart(2, '0'))}`}`;
  for (const d of [...p.deals, ...p.excluded]) {
    lines.push(`${'reasons' in d ? `[제외 ${(d.reasons as Exclusion[]).join(', ')}]` : '[검토]'} ${d.title}`, `  ${d.url}`, `  공구가 ${d.facts.gonggu_price === null ? '가격 미확인' : d.facts.gonggu_price.toLocaleString('ko-KR') + '원'} · 정가 ${d.facts.regular_price === null ? '가격 미확인' : d.facts.regular_price.toLocaleString('ko-KR') + '원'} · 시작 ${d.facts.start_date ? date(d.facts.start_date) : '미확인'} · 마감 ${d.facts.end_date ? date(d.facts.end_date) : '마감일 미확인'}`, `  누락 ${d.missing_fields.join(', ') || '없음'} · 경고 ${d.warnings.join(', ') || '없음'}`);
  }
  return lines.join('\n');
}
export function validateWeeklyArguments(args: string[]) {
  if (args.length > 1 || args.length === 1 && args[0] !== '--json') throw new Error('weekly_review_invalid_arguments');
}
