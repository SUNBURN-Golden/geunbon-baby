import Link from 'next/link';
import { verifiedDealsCopy } from '../../lib/copy/deals.ko';
import { RefreshAtDeadline } from './_countdown';
import { environment } from '../../lib/db';
import { activeDealCount, nextDealDeadline, dealTimingFor, lifecycleDeals, publicDealOptions, publicPageParams, PublicDealPaginationError, formatDealDate } from '../../lib/deals';
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
  // The listing cursor keeps its own reference time, but the header count and
  // expiry timer must reflect the current request so a continuation never
  // reports an already-ended deadline or a stale "진행 중" count.
  const [activeCount, deadline] = await Promise.all([activeDealCount(db, requestTime, requestTime), nextDealDeadline(db, requestTime)]);
  const phases = ['active', 'upcoming', 'ended', 'unknown'] as const;
  return (
    <main className="page deals-page">
      <div className="deals-heading"><h1>{dealsCopy.title}</h1><p>{dealsCopy.activeHeading} <ActiveDealCount count={activeCount} /></p></div>
      <RefreshAtDeadline nowMs={requestTime} deadline={deadline} />
      <nav className="deal-sort" aria-label={verifiedDealsCopy.sort}>
        {(['discount', 'ending'] as const).map(sort => <Link key={sort} aria-current={options.sort === sort ? 'page' : undefined}
          href={`/deals?${new URLSearchParams({ sort, limit: String(options.limit) })}`}>{verifiedDealsCopy.sorts[sort]}</Link>)}
      </nav>
      <p>{dealsCopy.referenceTime}: <time dateTime={new Date(page.nowMs).toISOString()}>{formatDealDate(new Date(page.nowMs).toISOString(), true)}</time></p>
      {page.data.length ? phases.map(phase => {
        const deals = page.data.filter(deal => dealTimingFor(deal, page.nowMs).state === phase);
        return deals.length > 0 && <section key={phase} aria-labelledby={`deals-${phase}`}>
          <h2 id={`deals-${phase}`}>{verifiedDealsCopy.sections[phase]}</h2><DealList deals={deals} nowMs={page.nowMs} clockMs={requestTime} />
        </section>;
      }) : <p>{options.cursor ? dealsCopy.emptyPosition : dealsCopy.empty}</p>}
      <DealPagination path="/deals" sort={options.sort} limit={options.limit} nextCursor={page.next_cursor} continued={!!options.cursor} />
    </main>
  );
}
