import Link from 'next/link';
import { sellersCopy as copy } from '../../lib/copy/sellers.ko';
import { roundHref, type OfficialSellerBadge } from '../../lib/deals';

export function OfficialSellerBadges({ badges, handle }: { badges?: readonly OfficialSellerBadge[]; handle?: string }) {
  if (!badges?.length) return null;
  return <ul className="seller-official" aria-label={copy.official}>{badges.map(badge =>
    <li key={badge.digest}>
      <a href={badge.evidence_url} target="_blank" rel="noopener noreferrer" aria-label={`${badge.brand_id} · ${copy.official} · ${copy.evidence}`}>
        {badge.brand_id} · {copy.official}
      </a>
      {handle && (badge.campaign_id ? <> · <Link href={roundHref(handle,badge.campaign_id)}>{badge.title || copy.scopeCampaign}</Link></> : <> · {copy.brandScope}</>)}
    </li>
  )}</ul>;
}
