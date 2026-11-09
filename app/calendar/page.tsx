import { DEAL_SELECT, type DealWithContext } from '../../lib/deals';
import { all, environment } from '../../lib/db';
import { DealList } from '../deals/_components';
export const dynamic = 'force-dynamic';
export default async function Calendar() {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const deals = await all<DealWithContext>(environment().DB, `${DEAL_SELECT} ORDER BY d.starts_at, d.id`);
  return <main className="page public-page"><p className="eyebrow">A LITTLE PLANNING</p><h1>공구 달력</h1><p className="lead">필요한 것만, 알맞은 때에. 일정 순으로 모아 두었어요.</p>{deals.length ? <DealList deals={deals} nowMs={nowMs} /> : <div className="empty"><h2>등록된 일정이 없습니다.</h2><p>예상 일정을 만들어 표시하지 않습니다.</p></div>}</main>;
}
