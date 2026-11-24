import { sellerTrustHref, type Deal, type DealBundleItem } from '../../lib/data';
import { DealImage } from './_image';
import Link from 'next/link';
import { dealTimingFor, formatDealDate, type DealWithContext, type Timing } from '../../lib/deals';
import { verifiedDealsCopy } from '../../lib/copy/deals.ko';
import { DealCountdown } from './_countdown';
import { dealsCopy } from '../../lib/deals-copy';
import { SellerTrustBadges } from '../sellers/_trust-badges';

export function DealStateChip({ timing, countdown = false }: { timing: Timing; countdown?: boolean }) {
  const { state, days } = timing;
  const schedule = state === 'active' && !countdown
    ? days === 0 ? dealsCopy.endsToday : dealsCopy.remaining.replace('{n}', String(days))
    : state === 'upcoming'
      ? days === 0 ? dealsCopy.startsToday : dealsCopy.starts.replace('{n}', String(days))
      : null;
  return (
    <span className="deal-state">
      <span className="deal-chip">{state === 'unknown' ? dealsCopy.unknownSchedule : dealsCopy[state]}</span>
      {schedule && <span>{schedule}</span>}
    </span>
  );
}

export function DealComparison({ deal }: { deal: DealWithContext }) {
  const { deal_price_krw, list_price_krw, discount_pct } = deal;
  if (deal_price_krw == null || list_price_krw == null || discount_pct == null || discount_pct <= 0) return null;
  return <div className="deal-price-block">
    <p className="deal-context">{dealsCopy.groupBuyPrice}</p>
    <p className="deal-price">{deal_price_krw.toLocaleString('ko-KR')}<span>{dealsCopy.won}</span></p>
    <p className="deal-context">{verifiedDealsCopy.listPrice} <del>{list_price_krw.toLocaleString('ko-KR')}{dealsCopy.won}</del></p>
    <strong className="deal-tone deal-tone-good">{verifiedDealsCopy.discount.replace('{n}', String(discount_pct))}</strong>
  </div>;
}

export function DealDisclaimer({ external = false }: { external?: boolean }) {
  return <p className="deal-disclaimer">{external ? dealsCopy.externalDisclaimer : dealsCopy.disclaimer}</p>;
}

export function DealExternalSource({ deal }: { deal: DealWithContext }) {
  if (deal.origin !== 'external_web') return null;
  const host = deal.source_host ?? new URL(deal.source_url).hostname;
  return (
    <p className="deal-context">
      {dealsCopy.externalSource} · {host}
      {deal.seller_name ? ` · ${deal.seller_name}` : ''}
    </p>
  );
}

export function DealBundleList({ items }: { items: readonly DealBundleItem[] }) {
  if (!items.length) return null;
  return (
    <section className="deal-bundle" aria-label={dealsCopy.bundleHeading}>
      <h2>{dealsCopy.bundleHeading}</h2>
      <ul>
        {items.map(item => (
          <li key={item.id}>
            <p>{item.brand ? `${item.brand} · ` : ''}{item.product_name}</p>
            <p className="deal-context">
              {item.price !== null && Number.isFinite(item.price) ? `${item.price.toLocaleString('ko-KR')}${dealsCopy.won}` : dealsCopy.unknownGongguPrice}
              {item.model_id && <> · <Link href={`/models/${encodeURIComponent(item.model_id)}`}>{dealsCopy.secondary}</Link></>}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DealCard({ deal, nowMs, clockMs = nowMs }: { deal: DealWithContext; nowMs: number; clockMs?: number }) {
  const timing = dealTimingFor(deal, nowMs);
  return (
    <article className="deal-card">
      <DealImage src={deal.image_url} verifiedOffer={deal.verify_level === 'verified_offer_v2'} alt={`${(deal.model_joined_id && deal.model_name) || deal.title} 상품 이미지`} />
      <div className="deal-labels"><span className="deal-ad">{dealsCopy.ad}</span><DealStateChip timing={timing} countdown /></div>
      <h2><Link className="deal-title-link" href={`/deals/${encodeURIComponent(deal.id)}`}>{deal.title}</Link></h2>
      <p className="deal-period"><DealPeriod deal={deal} timing={timing} external={deal.origin === 'external_web'} /></p>
      <DealComparison deal={deal} />
      {timing.state === 'active' && deal.ends_at && <DealCountdown endsAt={deal.ends_at} nowMs={clockMs} />}
      <DealExternalSource deal={deal} />
      <SellerTrustBadges registration_source={deal.seller_registration_source} withdrawal_source={deal.seller_withdrawal_source} official_import_source={deal.seller_official_import_source} />
      <DealCardLinks deal={deal} />
      <DealDisclaimer external={deal.origin === 'external_web'} />
    </article>
  );
}

export function DealCardLinks({ deal }: { deal: DealWithContext }) {
  return (
    <div className="deal-card-links">
      <a className="deal-secondary" href={deal.source_url} target="_blank" rel="sponsored noopener noreferrer">
        {dealsCopy.primary}<span className="deal-new-tab"> · {dealsCopy.newTab}</span>
      </a>
      {/* Native navigation hands fragment focus to the seller so Tab continues at its evidence. */}
      {deal.seller_joined_id && <a className="deal-secondary" href={sellerTrustHref(deal.seller_joined_id)}>{dealsCopy.sellerTrust}</a>}
    </div>
  );
}

export function DealList({ deals, nowMs, clockMs = nowMs }: { deals: readonly DealWithContext[]; nowMs: number; clockMs?: number }) {
  return deals.length ? <div className="deal-list">{deals.map(deal => <DealCard key={deal.id} deal={deal} nowMs={nowMs} clockMs={clockMs} />)}</div>
    : <p className="deal-empty">{dealsCopy.empty}</p>;
}

export function DealHeader({ deal, timing }: { deal: DealWithContext; timing: Timing }) {
  return (
    <header className="deal-header">
      <div className="deal-labels"><span className="deal-ad">{dealsCopy.ad}</span><DealStateChip timing={timing} countdown /></div>
      <h1>{deal.title}</h1>
    </header>
  );
}

export function DealPeriod({ deal, timing, external = false }: { deal: Pick<Deal, 'starts_at' | 'ends_at'>; timing: Timing; external?: boolean }) {
  if (timing.state === 'ended') return <>{dealsCopy.ended}</>;
  if (!deal.ends_at && external) return <>{dealsCopy.unknownEnds}</>;
  if (timing.state === 'unknown' || timing.state === 'active' && !deal.starts_at) return deal.ends_at
    ? <>{verifiedDealsCopy.deadline} <time dateTime={deal.ends_at}>{formatDealDate(deal.ends_at, true)}</time></>
    : <>{dealsCopy.unknownSchedule}</>;
  return <>
    {deal.starts_at ? <time dateTime={deal.starts_at}>{formatDealDate(deal.starts_at, true)}</time> : dealsCopy.unknownSchedule}
    {' – '}
    {deal.ends_at ? <time dateTime={deal.ends_at}>{formatDealDate(deal.ends_at, true)}</time> : (external ? dealsCopy.unknownEnds : dealsCopy.unknownSchedule)}
  </>;
}

export function DealFacts({ deal, timing }: { deal: DealWithContext; timing: Timing }) {
  return (
    <dl className="deal-facts">
      <div><dt>{dealsCopy.seller}</dt><dd>{deal.seller_name || dealsCopy.unknownSeller}</dd></div>
      {deal.model_joined_id && <div><dt>{dealsCopy.model}</dt><dd>{deal.model_name}</dd></div>}
      {!deal.model_joined_id && deal.brand_label && <div><dt>{dealsCopy.model}</dt><dd>{deal.brand_label}{deal.category_label ? ` · ${deal.category_label}` : ''}</dd></div>}
      <div><dt>{dealsCopy.period}</dt><dd><DealPeriod deal={deal} timing={timing} external={deal.origin === 'external_web'} /></dd></div>
      {deal.price_checked_at && <div><dt>{verifiedDealsCopy.checked}</dt><dd><time dateTime={deal.price_checked_at}>{formatDealDate(deal.price_checked_at, true)}</time></dd></div>}
      {deal.price_source_url && <div><dt>{verifiedDealsCopy.offerSource}</dt><dd><a href={deal.price_source_url} target="_blank" rel="sponsored noopener noreferrer">{verifiedDealsCopy.offerSource}</a></dd></div>}
      {deal.list_price_source_url && <div><dt>{verifiedDealsCopy.officialSource}</dt><dd><a href={deal.list_price_source_url} target="_blank" rel="noopener noreferrer">{verifiedDealsCopy.officialSource}</a></dd></div>}
    </dl>
  );
}

export function DealActions({ deal }: { deal: DealWithContext }) {
  return (
    <div className="deal-actions">
      <div className="deal-source-action">
        <a className="deal-primary" href={deal.source_url} target="_blank" rel="sponsored noopener noreferrer" aria-describedby="deal-new-tab">{dealsCopy.primary}</a>
        <small id="deal-new-tab">{dealsCopy.newTab}</small>
      </div>
      {deal.model_joined_id && deal.model_id && <Link className="deal-secondary" href={`/models/${encodeURIComponent(deal.model_id)}`}>{dealsCopy.secondary}</Link>}
      {/* Native navigation hands fragment focus to the seller so Tab continues at its evidence. */}
      {deal.seller_joined_id && <a className="deal-secondary" href={sellerTrustHref(deal.seller_joined_id)}>{dealsCopy.sellerTrust}</a>}
    </div>
  );
}

export function DealDetail({ deal, nowMs, bundleItems = [] }: { deal: DealWithContext; nowMs: number; bundleItems?: readonly DealBundleItem[] }) {
  const timing = dealTimingFor(deal, nowMs);
  const external = deal.origin === 'external_web';
  return (
    <main className="page deals-page">
      <Link className="deal-back" href="/deals">{dealsCopy.back}</Link>
      <article className="deal-detail">
        <DealHeader deal={deal} timing={timing} />
        <DealImage src={deal.image_url} verifiedOffer={deal.verify_level === 'verified_offer_v2'} alt={`${(deal.model_joined_id && deal.model_name) || deal.title} 상품 이미지`} />
        <DealComparison deal={deal} />
        {timing.state === 'active' && deal.ends_at && <DealCountdown endsAt={deal.ends_at} nowMs={nowMs} />}
        <DealExternalSource deal={deal} />
        <DealFacts deal={deal} timing={timing} />
        <DealBundleList items={bundleItems} />
        <SellerTrustBadges registration_source={deal.seller_registration_source} withdrawal_source={deal.seller_withdrawal_source} official_import_source={deal.seller_official_import_source} />
        <DealActions deal={deal} />
        <DealDisclaimer external={external} />
      </article>
    </main>
  );
}
