import Link from 'next/link';
import { dealsCopy } from '../lib/deals-copy';
import { money, verification, type Deal } from '../lib/data';
import { dealTiming } from '../lib/deals';
import { CheckedDate, DealPeriod, DealStateChip } from './deals/_components';
export function DealCard({ deal: d, nowMs, showModelLink = true }: { deal: Deal; nowMs: number; showModelLink?: boolean }) {
  const timing = dealTiming(d.starts_at, d.ends_at, nowMs);
  return <article className="deal-card"><span className="badge">광고</span> <DealStateChip timing={timing} /><h3>{d.title}</h3><p>{dealsCopy.groupBuyPrice} {money(d.price)}</p><p><DealPeriod deal={d} timing={timing} /></p><p className="muted"><CheckedDate value={d.checked} /> · {verification[d.verify_level] ?? d.verify_level}</p>{showModelLink && <><Link href={`/models/${d.model_id}`}>{dealsCopy.secondary}</Link> · </>}<Link href="/sellers">판매자 신뢰 정보</Link><p><a href={d.source_url} target="_blank" rel="noopener noreferrer sponsored">판매처 원문에서 확인 ↗</a></p><small>{dealsCopy.disclaimer}</small></article>;
}
