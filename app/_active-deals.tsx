import Link from 'next/link';
import { dealTiming, sortDeals, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { DealCard } from './deals/_components';

export function ActiveDealCount({ count }: { count: number }) {
  return <span className="active-deal-count" aria-label={dealsCopy.activeCount.replace('{count}', String(count))}>{count}</span>;
}

export function ActiveDeals({ deals, nowMs }: { deals: readonly DealWithContext[]; nowMs: number }) {
  const active = sortDeals(deals.filter(deal => dealTiming(deal.starts_at, deal.ends_at, nowMs).state === 'active'), nowMs);
  return (
    <section className="active-deals" aria-labelledby="active-deals-title">
      <h2 id="active-deals-title">{dealsCopy.activeHeading} <ActiveDealCount count={active.length} /></h2>
      {active.length ? <ul className="active-deal-row">{active.map(deal => <li key={deal.id}><DealCard deal={deal} nowMs={nowMs} /></li>)}</ul>
        : <div className="active-deal-zero"><p className="active-deal-empty">{dealsCopy.activeEmpty}</p><Link className="button button-outline" href="/models">{dealsCopy.secondary}</Link></div>}
    </section>
  );
}
