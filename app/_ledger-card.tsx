import { dealOfficialPrice, priceGap, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { modelIllustration } from '../lib/model-illustrations';

function ledgerPrice(price: number | null) {
  return price !== null && Number.isFinite(price) && price >= 0
    ? `${price.toLocaleString('ko-KR')}${dealsCopy.won}`
    : dealsCopy.unknownPrice;
}

export function LedgerCard({ deal }: { deal: DealWithContext }) {
  const illustration = modelIllustration(deal.model_id);
  const name = deal.model_joined_id && deal.model_name
    ? [deal.model_brand, deal.model_name].filter(Boolean).join(' ')
    : deal.title;
  const official = dealOfficialPrice(deal);
  const gap = priceGap(deal.price, official);

  return (
    <a className="ledger-card" href={`/deals/${encodeURIComponent(deal.id)}`}>
      <span className="ledger-stamp">
        {illustration && (
          // Static local line art needs neither image optimization nor a remote image request.
          // eslint-disable-next-line @next/next/no-img-element
          <img {...illustration} sizes="(max-width: 720px) 62px, 46px" alt="" />
        )}
      </span>
      <span className="ledger-name">{name}</span>
      <span className="ledger-prices">
        <span className="ledger-price-cell">
          <span className="visually-hidden">{dealsCopy.ledgerOfficial} </span>
          <span className="ledger-value">{ledgerPrice(official)}</span>
        </span>
        <span className="ledger-price-cell ledger-group-price">
          <span className="visually-hidden">{dealsCopy.ledgerGroup} </span>
          <span className="ledger-value">{ledgerPrice(deal.price)}</span>
          {gap?.relation === 'below' && (
            // Intentional difference from formatGap: the badge uses a minus sign and omits trailing decimal zeros.
            <span className="ledger-discount">
              <span className="visually-hidden">{dealsCopy.discountPrefix}</span>
              -{gap.percent < 0.1 ? '<0.1' : Number(gap.percent.toFixed(1))}%
            </span>
          )}
        </span>
      </span>
    </a>
  );
}
