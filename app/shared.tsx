import Link from 'next/link';
import { dealsCopy } from '../lib/deals-copy';
import { dealState, money, verification, type Deal } from '../lib/data';
export function DealCard({ deal: d, showModelLink = true }: { deal: Deal; showModelLink?: boolean }) {
  const state = dealState(d);
  return <article className="deal-card"><span className="badge">광고</span> <span className="muted">{state}</span><h3>{d.title}</h3><p>{dealsCopy.groupBuyPrice} {money(d.price)}</p><p>{d.starts_at.slice(0, 10)} ~ {d.ends_at.slice(0, 10)}</p><p className="muted">{d.checked.slice(0, 10)} · {verification[d.verify_level] ?? d.verify_level}</p>{showModelLink && <><Link href={`/models/${d.model_id}`}>{dealsCopy.secondary}</Link> · </>}<Link href="/sellers">판매자 신뢰 정보</Link><p><a href={d.source_url} target="_blank" rel="noopener noreferrer sponsored">판매처 원문에서 확인 ↗</a></p><small>{dealsCopy.disclaimer}</small></article>;
}
