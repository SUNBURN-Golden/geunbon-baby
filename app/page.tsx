import Link from 'next/link';
import { siteCopy } from '../lib/site-copy';
import { all, environment } from '../lib/db';
import { DEAL_SELECT, dealTiming, type DealWithContext } from '../lib/deals';
import { ActiveDeals } from './_active-deals';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // eslint-disable-next-line react-hooks/purity -- Capture request time once for consistent deal states.
  const nowMs = Date.now();
  const deals = await all<DealWithContext>(environment().DB, DEAL_SELECT);
  const activeCount = deals.filter(deal => dealTiming(deal.starts_at, deal.ends_at, nowMs).state === 'active').length;
  return (
    <main>
      <section className="hero">
        <div>
          <h1>{siteCopy.heroHeading}</h1>
          <p className="lead">{siteCopy.heroLead}</p>
          <div className="hero-actions">
            <Link className="button hero-primary" href="#ledger">{siteCopy.heroPrimaryCta}</Link>
            <Link className="button hero-secondary" href="/models">{siteCopy.heroSecondaryCta}</Link>
          </div>
        </div>
        <div className="hero-counter" role="img" aria-label={`${siteCopy.heroCountLabel} ${activeCount}${siteCopy.heroCountUnit}`}>
          <span>{siteCopy.heroCountLabel}</span>
          <div className="hero-counter-total"><strong>{activeCount}</strong><span>{siteCopy.heroCountUnit}</span></div>
        </div>
      </section>
      <ActiveDeals deals={deals} nowMs={nowMs} />
      <section className="entry-grid"><Link href="/models?category=stroller"><span>01 / OUT & ABOUT</span><h3>함께 걷는 첫 길</h3><p>유모차 살펴보기 →</p></Link><Link href="/models?category=high_chair"><span>02 / AT THE TABLE</span><h3>식탁의 작은 자리</h3><p>하이체어 살펴보기 →</p></Link><Link href="/models?category=car_seat"><span>03 / SAFE JOURNEY</span><h3>안심을 싣는 시간</h3><p>카시트 살펴보기 →</p></Link></section>
    </main>
  );
}
