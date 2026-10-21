import Link from 'next/link';
import { dealTiming, priceGap, sortDeals, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { DealImage } from './deals/_image';

export function ActiveDealCount({ count }: { count: number }) {
  return <span className="active-deal-count" aria-label={dealsCopy.activeCount.replace('{count}', String(count))}>{count}</span>;
}

function ActiveDealCard({ deal, nowMs }: { deal: DealWithContext; nowMs: number }) {
  const timing = dealTiming(deal.starts_at, deal.ends_at, nowMs);
  const productName = (deal.model_joined_id && deal.model_name) || deal.title;
  const official = deal.model_joined_id ? deal.model_official_price : null;
  const validOfficial = official !== null && Number.isFinite(official) && official >= 0;
  const validPrice = deal.price !== null && Number.isFinite(deal.price) && deal.price >= 0;
  const gap = priceGap(deal.price, official);
  const percent = Math.abs(gap?.percent ?? 0);
  const gapText = gap && dealsCopy[gap.relation === 'below' ? 'compactBelow' : gap.relation === 'above' ? 'compactAbove' : 'compactEqual']
    .replace('{percent}', percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1));

  return (
    <Link className="active-deal-card" href={`/deals/${encodeURIComponent(deal.id)}`}>
      <div className="active-deal-top">
        <DealImage src={deal.image_url} alt={`${productName} 상품 이미지`}
          fallback={<span className="active-deal-mark" aria-hidden="true">{productName.trim().slice(0, 1)}</span>} />
        <span className="active-deal-ad">{dealsCopy.ad}</span>
        <span className="active-deal-days">{timing.days === 0 ? dealsCopy.endsToday : dealsCopy.remaining.replace('{n}', String(timing.days))}</span>
      </div>
      <h3>{deal.title}</h3>
      <div>
        <p className="active-deal-label">{dealsCopy.groupBuyPrice}</p>
        <p className={validPrice ? 'active-deal-price' : 'active-deal-unknown'}>
          {validPrice ? <>{deal.price!.toLocaleString('ko-KR')}<span>{dealsCopy.won}</span></> : dealsCopy.unknownPrice}
        </p>
      </div>
      <div className="active-deal-comparison">
        <p className="active-deal-label">{validOfficial ? <>{dealsCopy.officialPrice} · {official.toLocaleString('ko-KR')}{dealsCopy.won}</> : dealsCopy.unknownOfficial}</p>
        {gapText && <p className="active-deal-gap">{gapText}</p>}
      </div>
    </Link>
  );
}

export function ActiveDeals({ deals, nowMs }: { deals: readonly DealWithContext[]; nowMs: number }) {
  const active = sortDeals(deals.filter(deal => dealTiming(deal.starts_at, deal.ends_at, nowMs).state === 'active'), nowMs);
  return (
    <section className="active-deals" aria-labelledby="active-deals-title">
      <h2 id="active-deals-title">{dealsCopy.activeHeading} <ActiveDealCount count={active.length} /></h2>
      {active.length ? <ul className="active-deal-row">{active.map(deal => <li key={deal.id}><ActiveDealCard deal={deal} nowMs={nowMs} /></li>)}</ul>
        : <p className="active-deal-empty">{dealsCopy.activeEmpty}</p>}
    </section>
  );
}
