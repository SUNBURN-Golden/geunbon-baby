import Link from 'next/link';
import { dealState, money, verification, type Deal } from '../lib/data';
export function DealCard({ deal: d }: { deal: Deal }) {
  const state = dealState(d);
  return <article className="deal-card"><span className="badge">광고</span> <span className="muted">{state}</span><h3>{d.title}</h3><p>{money(d.price)}</p><p>{d.starts_at.slice(0, 10)} ~ {d.ends_at.slice(0, 10)}</p><p className="muted">{d.checked.slice(0, 10)} · {verification[d.verify_level] ?? d.verify_level}</p><Link href={`/models/${d.model_id}`}>모델 비교</Link> · <Link href="/sellers">판매자 신뢰 정보</Link><p><a href={d.source_url} target="_blank" rel="noopener noreferrer sponsored">판매처 원문에서 확인 ↗</a></p><small>아가마중은 거래 당사자가 아닙니다. 거래 조건은 판매처에서 확인하세요.</small></article>;
}
