import { all, environment } from '../../lib/db';
import { DEAL_SELECT, dealTiming, sortDeals, type DealWithContext } from '../../lib/deals';
import { dealsCopy } from '../../lib/deals-copy';
import { DealList } from './_components';
import { CategoryTabs, selectedCategory } from '../_category-tabs';
import { ActiveDealCount } from '../_active-deals';

export const dynamic = 'force-dynamic';

export default async function DealsPage({ searchParams = Promise.resolve({}) }: {
  searchParams?: Promise<{ category?: string }>;
} = {}) {
  const category = selectedCategory((await searchParams).category);
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const deals = await all<DealWithContext>(environment().DB, DEAL_SELECT);
  const activeCount = deals.filter(deal => dealTiming(deal.starts_at, deal.ends_at, nowMs).state === 'active').length;
  return (
    <main className="page deals-page">
      <div className="deals-heading"><h1>{dealsCopy.title}</h1><p>{dealsCopy.activeHeading} <ActiveDealCount count={activeCount} /></p></div>
      <CategoryTabs category={category} base="/deals" />
      <DealList deals={sortDeals(category ? deals.filter(deal => deal.model_category === category) : deals, nowMs)} nowMs={nowMs} />
    </main>
  );
}
