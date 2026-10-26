import Link from 'next/link';
import { siteCopy } from '../lib/site-copy';
import { all, environment } from '../lib/db';
import { categories } from '../lib/data';
import { DEAL_SELECT, dealTiming, type DealWithContext } from '../lib/deals';
import { ActiveDeals } from './_active-deals';

export const dynamic = 'force-dynamic';

const categoryOrder = ['stroller', 'high_chair', 'car_seat', 'carrier', 'bouncer'];
const categoryTabs = [
  ...categoryOrder.filter(key => Object.hasOwn(categories, key)),
  ...Object.keys(categories).filter(key => !categoryOrder.includes(key)),
];

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
            <Link className="button hero-secondary" href="#categories">{siteCopy.heroSecondaryCta}</Link>
          </div>
        </div>
        <div className="hero-counter">
          <span className="visually-hidden">{`${siteCopy.heroCountLabel} ${activeCount}${siteCopy.heroCountUnit}`}</span>
          <span aria-hidden="true">{siteCopy.heroCountLabel}</span>
          <div className="hero-counter-total" aria-hidden="true"><strong>{activeCount}</strong><span>{siteCopy.heroCountUnit}</span></div>
        </div>
      </section>
      <nav className="category-tabs" id="categories" aria-label={siteCopy.categoryNavLabel}>
        <Link href="/models">{siteCopy.categoryAll}</Link>
        {categoryTabs.map(key => (
          <Link key={key} href={`/models?category=${encodeURIComponent(key)}`}>{categories[key]}</Link>
        ))}
      </nav>
      <ActiveDeals deals={deals} nowMs={nowMs} />
    </main>
  );
}
