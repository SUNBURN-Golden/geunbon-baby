import { all, environment } from '../../lib/db';
import { DEAL_SELECT, isDealPubliclyActive, sortDeals, type DealWithContext } from '../../lib/deals';
import { dealsCopy } from '../../lib/deals-copy';
import { DealList } from './_components';
import { ActiveDealCount } from '../_active-deals';

export const dynamic = 'force-dynamic';

export default async function DealsPage() {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const deals = await all<DealWithContext>(environment().DB, DEAL_SELECT);
  const activeCount = deals.filter(deal => isDealPubliclyActive(deal, nowMs)).length;
  return (
    <main className="page deals-page">
      <div className="deals-heading"><h1>{dealsCopy.title}</h1><p>{dealsCopy.activeHeading} <ActiveDealCount count={activeCount} /></p></div>
      <DealList deals={sortDeals(deals, nowMs)} nowMs={nowMs} />
    </main>
  );
}
