import Link from 'next/link';
import { dealTiming, sortDeals, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { LedgerCard } from './_ledger-card';

export function ActiveDealCount({ count }: { count: number }) {
  return <span className="active-deal-count" aria-label={dealsCopy.activeCount.replace('{count}', String(count))}>{count}</span>;
}

export function ActiveDeals({ deals, nowMs }: { deals: readonly DealWithContext[]; nowMs: number }) {
  const active = sortDeals(deals.filter(deal => dealTiming(deal.starts_at, deal.ends_at, nowMs).state === 'active'), nowMs);
  return (
    <section className="active-deals" id="ledger" aria-labelledby="active-deals-title">
      <h2 id="active-deals-title">{dealsCopy.activeHeading} <ActiveDealCount count={active.length} /></h2>
      {active.length ? <>
        <div className="ledger-legend">
          <span>{dealsCopy.legendOfficial}</span>
          <span className="ledger-legend-group">{dealsCopy.legendGroup}</span>
        </div>
        <ul className="active-deal-row">{active.map(deal => <li key={deal.id}><LedgerCard deal={deal} /></li>)}</ul>
      </> : <div className="ledger-zero">
        <h3>{dealsCopy.zeroTitle}</h3>
        <p>{dealsCopy.zeroBody}</p>
        <Link className="ledger-zero-link" href="/models">{dealsCopy.zeroCta}</Link>
      </div>}
    </section>
  );
}
