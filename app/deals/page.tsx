import { all, environment } from '../../lib/db';
import { DEAL_SELECT, sortDeals, type DealWithContext } from '../../lib/deals';
import { dealsCopy } from '../../lib/deals-copy';
import { DealDisclaimer, DealList } from './_components';

export const dynamic = 'force-dynamic';

export default async function DealsPage() {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const deals = await all<DealWithContext>(environment().DB, DEAL_SELECT);
  return (
    <main className="page deals-page">
      <h1>{dealsCopy.title}</h1>
      <DealList deals={sortDeals(deals, nowMs)} nowMs={nowMs} />
      <DealDisclaimer />
    </main>
  );
}
