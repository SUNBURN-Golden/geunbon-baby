import { all, environment } from '../../lib/db';
import { type Deal } from '../../lib/data';
import { DealCard } from '../shared';
export const dynamic = 'force-dynamic';
export default async function Calendar() {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const deals = await all<Deal>(environment().DB, 'SELECT * FROM deals ORDER BY starts_at, id');
  return <main className="page"><p className="eyebrow">A LITTLE PLANNING</p><h1>공구 달력</h1><p className="lead">필요한 것만, 알맞은 때에. 검수한 일정순으로 안내합니다.</p>{deals.length ? deals.map(d => <DealCard key={d.id} deal={d} nowMs={nowMs}/>) : <div className="empty"><h2>등록된 일정이 없습니다.</h2><p>예상 일정을 만들어 표시하지 않습니다.</p></div>}</main>;
}
