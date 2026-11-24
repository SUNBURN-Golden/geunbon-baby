import { PRICE_MODELS } from '../../shared/deal-price-evidence';
import { verifiedDealsCopy } from '../../lib/copy/deals.ko';
import { money } from '../../lib/data';
import type { PriceReview } from '../../lib/deal-price-review';

export function PriceEvidenceReview({ proof, fallback = 'legacy' }: { proof?: PriceReview | null; fallback?: 'legacy' | 'withdrawn' }) {
  const reason = proof?.reason ?? fallback;
  const labels: Record<string, string> = verifiedDealsCopy.reasons;
  return <details>
    <summary>{verifiedDealsCopy.evidence} · {labels[reason] ?? reason}</summary>
    {proof && [proof.evidence.offer, proof.evidence.official].map((section, index) => section && <div key={index}>
      <p><a href={section.source.url} target="_blank" rel="noopener noreferrer">{index ? verifiedDealsCopy.officialSource : verifiedDealsCopy.offerSource}</a></p>
      <p>{verifiedDealsCopy.checked} <time dateTime={section.source.observed_at}>{section.source.observed_at}</time></p>
      <ol>{section.readings.map((reading, i) => <li key={PRICE_MODELS[i]}>
        {PRICE_MODELS[i]} · {money(reading?.amount)} {reading?.price?.quote} {reading?.deadline?.quote}
        {reading?.configuration && <p>{Object.values(reading.configuration).join(' · ')}</p>}
      </li>)}</ol>
    </div>)}
  </details>;
}
