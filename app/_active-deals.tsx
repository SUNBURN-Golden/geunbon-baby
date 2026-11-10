import { type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { DealCard } from './deals/_components';

export function ActiveDealCount({ count }: { count: number }) {
  return <span className="active-deal-count" aria-label={dealsCopy.activeCount.replace('{count}', String(count))}>{count}</span>;
}

export function ActiveDeals({ deals, totalCount, nowMs }: { deals: readonly DealWithContext[]; totalCount: number; nowMs: number }) {
  const active = deals;
  return (
    <section className="active-deals" aria-labelledby="active-deals-title">
      <h2 id="active-deals-title">{dealsCopy.activeHeading} <ActiveDealCount count={totalCount} /></h2>
      {active.length ? <ul className="active-deal-row">{active.map(deal => <li key={deal.id}><DealCard deal={deal} nowMs={nowMs} /></li>)}</ul>
        : <p className="active-deal-empty">{dealsCopy.activeEmpty}</p>}
    </section>
  );
}
