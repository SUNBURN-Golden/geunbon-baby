import { all, environment } from '../../lib/db';
import { type Deal } from '../../lib/data';
import { DealCard } from '../shared';
export const dynamic = 'force-dynamic';
export default async function Deals() {
  const deals = await all<Deal>(environment().DB, 'SELECT * FROM deals ORDER BY starts_at DESC');
  return <main className="page"><p className="eyebrow">CAREFULLY REVIEWED</p><h1>공구 소식</h1><p className="lead">서두르지 않아도 괜찮아요. 확인한 소식만 모아 드릴게요.</p><div className="notice">모든 공구는 광고입니다. 아가마중은 거래 당사자가 아니며 구매는 외부 판매처에서만 진행됩니다.</div>{deals.length ? deals.map(d => <DealCard deal={d} key={d.id}/>) : <div className="empty"><h2>아직 검수된 공구가 없어요.</h2><p>시드에 공개된 공구 가격이 없습니다. 정보가 확인되면 소개하겠습니다.</p></div>}</main>;
}
