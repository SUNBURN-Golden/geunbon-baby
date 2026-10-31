import Link from 'next/link';
import { money } from '../../lib/data';
import { showStrike, type ModelCardData } from '../../lib/model-cards';
import { modelIllustration } from '../../lib/model-illustrations';
import { siteCopy } from '../../lib/site-copy';

export function ModelCard({ card }: { card: ModelCardData }) {
  const displayName = `${card.brand} ${card.name}`;
  const art = modelIllustration(card.id);
  const official = money(card.official_price);
  // Static pre-sized PNGs from public/; no image optimizer. Models without art render no <img> at all.
  /* eslint-disable-next-line @next/next/no-img-element */
  const image = art && <img src={art.src} srcSet={art.srcSet} sizes="(max-width: 767px) 45vw, (max-width: 1023px) 30vw, 280px" width={art.width} height={art.height} alt={displayName} loading="lazy" decoding="async" />;
  return (
    <Link className="model-card" href={`/models/${card.id}`}>
      <div className={`model-art${art ? ' model-art-line' : ''}`}>
        {image ?? <span className="model-art-mark" aria-hidden="true">{[...card.brand][0]}</span>}
      </div>
      <h2 className="model-name">{displayName}</h2>
      <div className="model-prices">
        {card.deal
          ? <>
              <p className="model-deal">
                {card.deal.price === null
                  ? <span className="model-deal-unknown">{money(null)}</span>
                  : <span className="model-deal-price">{card.deal.price.toLocaleString('ko-KR')}<span>원</span></span>}
              </p>
              <p className="model-official"><span>{siteCopy.officialLabel}</span> {showStrike(card.gap) ? <s>{official}</s> : <span>{official}</span>}</p>
            </>
          : <>
              <p className="model-deal"><span className="model-no-deal">{siteCopy.noActiveDeal}</span></p>
              <p className="model-official model-official-solo"><span>{siteCopy.officialLabel}</span> <span>{official}</span></p>
            </>}
      </div>
    </Link>
  );
}
