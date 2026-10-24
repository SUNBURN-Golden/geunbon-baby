import { sellerTrustHref, type Deal } from '../../lib/data';
import { DealImage } from './_image';
import Link from 'next/link';
import { dealTiming, formatDealDate, formatGap, priceGap, type DealWithContext, type Gap, type Timing } from '../../lib/deals';
import { dealsCopy } from '../../lib/deals-copy';

function verificationCopy(level: string | null) {
  switch (level) {
    case 'page_body': return dealsCopy.pageBody;
    case 'official_unpublished': return dealsCopy.officialUnconfirmed;
    case 'page_text': return dealsCopy.pageText;
    case 'search_summary': return dealsCopy.searchSummary;
    case 'manual': return dealsCopy.manual;
    case 'seed_unspecified': return dealsCopy.seedUnspecified;
    default: return dealsCopy.unknownVerification;
  }
}

const knownDealPrice = (price: number | null) => price !== null && Number.isFinite(price) && price >= 0;
const confirmedOfficial = (deal: DealWithContext) =>
  deal.model_official_price !== null && Number.isFinite(deal.model_official_price) &&
  deal.model_official_price > 0 && deal.model_verify_level !== 'official_unpublished';

export function CheckedDate({ value }: { value: string | null }) {
  const formatted = formatDealDate(value);
  return formatted ? <time dateTime={value!}>{formatted}</time> : <>{dealsCopy.unknownChecked}</>;
}

export function DealStateChip({ timing }: { timing: Timing }) {
  const { state, days } = timing;
  const schedule = state === 'active'
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

export function DealPrice({ deal, timing }: { deal: DealWithContext; timing: Timing }) {
  const validPrice = knownDealPrice(deal.price);
  return (
    <div className="deal-price-block">
      <p className="deal-context">{dealsCopy.groupBuyPrice}</p>
      <p className={validPrice ? 'deal-price' : 'deal-price-unknown'}>
        {validPrice ? <>{deal.price!.toLocaleString('ko-KR')}<span>{dealsCopy.won}</span></> : dealsCopy.unknownPrice}
      </p>
      {timing.state === 'ended' && <p className="deal-archive"><WithDate label={dealsCopy.archived}><CheckedDate value={deal.checked} /></WithDate></p>}
    </div>
  );
}

export function PriceGap({ deal, gap, showContext = true }: { deal: DealWithContext; gap: Gap | null; showContext?: boolean }) {
  if (!deal.model_joined_id) return null;
  if (!gap) return deal.model_official_price === null ? <p className="deal-context">{dealsCopy.unknownOfficial}</p> : null;
  return (
    <div className="deal-comparison">
      <p className="deal-context">{dealsCopy.officialPrice} · {deal.model_official_price!.toLocaleString('ko-KR')}{dealsCopy.won}</p>
      <p className="deal-gap">{gapChunks(formatGap(gap)).map((chunk, i) => <span className="deal-gap-chunk" key={i}>{i > 0 ? ` · ${chunk}` : chunk}</span>)}</p>
      {showContext && <>
        <p className="deal-context">{dealsCopy.qualification}</p>
        <p className="deal-context">
          <WithDate label={dealsCopy.dealChecked}><CheckedDate value={deal.checked} /></WithDate> · {verificationCopy(deal.verify_level)}
          <br />
          <WithDate label={confirmedOfficial(deal) ? dealsCopy.officialChecked : dealsCopy.officialEvidence}><CheckedDate value={deal.model_checked} /></WithDate> · {verificationCopy(deal.model_verify_level)}
        </p>
      </>}
    </div>
  );
}

export function PriceToneBadge({ gap, timing }: { gap: Gap | null; timing: Timing }) {
  if (!gap || timing.state === 'ended' || timing.state === 'unknown') return null;
  return <p className={`deal-tone${gap.relation === 'below' ? ' deal-tone-good' : ''}`}>{gap.relation === 'below' ? dealsCopy.good : dealsCopy.wait}</p>;
}

export function DealDisclaimer() {
  return <p className="deal-disclaimer">{dealsCopy.disclaimer}</p>;
}

export function DealCard({ deal, nowMs }: { deal: DealWithContext; nowMs: number }) {
  const timing = dealTiming(deal.starts_at, deal.ends_at, nowMs);
  const gap = priceGap(deal.price, deal.model_joined_id ? deal.model_official_price : null);
  return (
    <article className="deal-card">
      <DealImage src={deal.image_url} alt={`${(deal.model_joined_id && deal.model_name) || deal.title} 상품 이미지`} />
      <div className="deal-labels"><span className="deal-ad">{dealsCopy.ad}</span><DealStateChip timing={timing} /></div>
      <h2><Link className="deal-title-link" href={`/deals/${encodeURIComponent(deal.id)}`}>{deal.title}</Link></h2>
      <DealPrice deal={deal} timing={timing} />
      <PriceGap deal={deal} gap={gap} showContext={false} />
      <PriceToneBadge gap={gap} timing={timing} />
    </article>
  );
}

export function DealList({ deals, nowMs }: { deals: readonly DealWithContext[]; nowMs: number }) {
  return deals.length ? <div className="deal-list">{deals.map(deal => <DealCard key={deal.id} deal={deal} nowMs={nowMs} />)}</div>
    : <p className="deal-empty">{dealsCopy.empty}</p>;
}

export function DealHeader({ deal, timing }: { deal: DealWithContext; timing: Timing }) {
  return (
    <header className="deal-header">
      <div className="deal-labels"><span className="deal-ad">{dealsCopy.ad}</span><DealStateChip timing={timing} /></div>
      <h1>{deal.title}</h1>
    </header>
  );
}

export function DealPeriod({ deal, timing }: { deal: Pick<Deal, 'starts_at' | 'ends_at'>; timing: Timing }) {
  return <>{timing.state === 'unknown' ? dealsCopy.unknownSchedule : <>
        <time dateTime={deal.starts_at}>{formatDealDate(deal.starts_at, true)}</time>
        {' – '}<time dateTime={deal.ends_at}>{formatDealDate(deal.ends_at, true)}</time>
      </>}</>;
}

export function DealFacts({ deal, timing }: { deal: DealWithContext; timing: Timing }) {
  return (
    <dl className="deal-facts">
      <div><dt>{dealsCopy.seller}</dt><dd>{deal.seller_name || dealsCopy.unknownSeller}</dd></div>
      {deal.model_joined_id && <div><dt>{dealsCopy.model}</dt><dd>{deal.model_name}</dd></div>}
      <div><dt>{dealsCopy.period}</dt><dd><DealPeriod deal={deal} timing={timing} /></dd></div>
      <div><dt>{knownDealPrice(deal.price) ? dealsCopy.dealChecked : dealsCopy.dealEvidence}</dt><dd><CheckedDate value={deal.checked} /> · {verificationCopy(deal.verify_level)}</dd></div>
      {deal.model_joined_id && <div><dt>{confirmedOfficial(deal) ? dealsCopy.officialChecked : dealsCopy.officialEvidence}</dt><dd><CheckedDate value={deal.model_checked} /> · {verificationCopy(deal.model_verify_level)}</dd></div>}
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
      {deal.model_joined_id && <Link className="deal-secondary" href={`/models/${encodeURIComponent(deal.model_id)}`}>{dealsCopy.secondary}</Link>}
      {/* Native navigation hands fragment focus to the seller so Tab continues at its evidence. */}
      {deal.seller_joined_id && <a className="deal-secondary" href={sellerTrustHref(deal.seller_joined_id)}>{dealsCopy.sellerTrust}</a>}
    </div>
  );
}

export function DealDetail({ deal, nowMs }: { deal: DealWithContext; nowMs: number }) {
  const timing = dealTiming(deal.starts_at, deal.ends_at, nowMs);
  const gap = priceGap(deal.price, deal.model_joined_id ? deal.model_official_price : null);
  return (
    <main className="page deals-page">
      <Link className="deal-back" href="/deals">{dealsCopy.back}</Link>
      <article className="deal-detail">
        <DealHeader deal={deal} timing={timing} />
        <DealImage src={deal.image_url} alt={`${(deal.model_joined_id && deal.model_name) || deal.title} 상품 이미지`} />
        <DealPrice deal={deal} timing={timing} />
        <PriceGap deal={deal} gap={gap} />
        <PriceToneBadge gap={gap} timing={timing} />
        <DealFacts deal={deal} timing={timing} />
        <DealActions deal={deal} />
        <DealDisclaimer />
      </article>
    </main>
  );
}

// Keep the won amount and its verb on one line so 낮아요/높아요 never wraps alone.
function gapChunks(text: string): string[] {
  return text.split(' · ');
}

// Keeps the label's last word, the separator and the date on one line at 320px.
function WithDate({ label, children }: { label: string; children: React.ReactNode }) {
  const cut = label.lastIndexOf(' ');
  const head = cut > 0 ? label.slice(0, cut + 1) : '';
  return <>{head}<span className="keep-line">{label.slice(cut + 1)} · {children}</span></>;
}
