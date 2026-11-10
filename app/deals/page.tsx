import { environment } from '../../lib/db';
import { activeDealCount, lifecycleDeals, publicDealOptions, publicPageParams, PublicDealPaginationError, formatDealDate } from '../../lib/deals';
import { dealsCopy } from '../../lib/deals-copy';
import { DealList } from './_components';
import { ActiveDealCount } from '../_active-deals';
import { DealPagination, InvalidDealPage, type DealPageSearch } from './_pagination';

export const dynamic = 'force-dynamic';

export default async function DealsPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<DealPageSearch> } = {}) {
  // eslint-disable-next-line react-hooks/purity -- Capture request time once; continuation reuses the cursor time.
  const requestTime = Date.now();
  let options;
  try { options = publicDealOptions(publicPageParams(await searchParams), 'page-deals'); }
  catch (error) { if (error instanceof PublicDealPaginationError) return <main className="page deals-page"><h1>{dealsCopy.title}</h1><InvalidDealPage path="/deals" /></main>; throw error; }
  const db = environment().DB;
  const page = await lifecycleDeals(db, options, requestTime);
  const activeCount = await activeDealCount(db, page.nowMs);
  return (
    <main className="page deals-page">
      <div className="deals-heading"><h1>{dealsCopy.title}</h1><p>{dealsCopy.activeHeading} <ActiveDealCount count={activeCount} /></p></div>
      <p>{dealsCopy.referenceTime}: <time dateTime={new Date(page.nowMs).toISOString()}>{formatDealDate(new Date(page.nowMs).toISOString(), true)}</time></p>
      {page.data.length ? <DealList deals={page.data} nowMs={page.nowMs} /> : <p>{options.cursor ? dealsCopy.emptyPosition : dealsCopy.empty}</p>}
      <DealPagination path="/deals" limit={options.limit} nextCursor={page.next_cursor} continued={!!options.cursor} />
    </main>
  );
}
