import { chronologicalDeals, publicDealOptions, publicPageParams, PublicDealPaginationError, type DealWithContext } from '../../lib/deals';
import { environment } from '../../lib/db';
import { dealsCopy } from '../../lib/deals-copy';
import { DealList } from '../deals/_components';
import { DealPagination, InvalidDealPage, type DealPageSearch } from '../deals/_pagination';
export const dynamic = 'force-dynamic';
export default async function Calendar({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<DealPageSearch> } = {}) {
  // eslint-disable-next-line react-hooks/purity -- Capture request time once for card labels.
  const nowMs = Date.now();
  let options;
  try { options = publicDealOptions(publicPageParams(await searchParams), 'page-calendar'); }
  catch (error) { if (error instanceof PublicDealPaginationError) return <main className="page public-page"><h1>공구 달력</h1><InvalidDealPage path="/calendar" /></main>; throw error; }
  const page = await chronologicalDeals<DealWithContext>(environment().DB, options, true);
  return <main className="page public-page"><p className="eyebrow">A LITTLE PLANNING</p><h1>공구 달력</h1><p className="lead">필요한 것만, 알맞은 때에. 일정 순으로 모아 두었어요.</p>{page.data.length ? <DealList deals={page.data} nowMs={nowMs} /> : options.cursor ? <p>{dealsCopy.emptyPosition}</p> : <div className="empty"><h2>등록된 일정이 없습니다.</h2><p>예상 일정을 만들어 표시하지 않습니다.</p></div>}<DealPagination path="/calendar" limit={options.limit} nextCursor={page.next_cursor} continued={!!options.cursor} /></main>;
}
