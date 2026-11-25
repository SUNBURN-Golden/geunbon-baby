import Link from 'next/link';
import { homeCopy } from '../lib/copy/home.ko';
import { environment } from '../lib/db';
import { homeDeals } from '../lib/home-deals';
import { HomeOfferSections, HomeQuickFilters } from './_active-deals';
import { RefreshAtInstant } from './deals/_countdown';

export const dynamic = 'force-dynamic';
type Search = { category?: string | string[]; brand?: string | string[] };
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || null;

export default async function Home({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<Search> } = {}) {
  // eslint-disable-next-line react-hooks/purity -- The whole response uses this request instant.
  const asOf = Date.now();
  const { category, brand } = await searchParams;
  const filters = { category: first(category), brand: first(brand) };
  const inventory = await homeDeals(environment().DB, asOf, filters);
  return (
    <main className="home">
      <section className="home-hero">
        <h1>{homeCopy.active(inventory.count)}</h1>
        {inventory.maximum !== null && <p className="home-saving">{homeCopy.maxSaving(inventory.maximum)}</p>}
        <p className="home-tagline">{homeCopy.tagline}</p>
        {inventory.count === 0 && <Link className="home-catalog" href="/models">{homeCopy.catalog}</Link>}
      </section>
      <HomeQuickFilters inventory={inventory} filters={filters} />
      <RefreshAtInstant nowMs={asOf} instant={inventory.nextRefreshAt} />
      <HomeOfferSections inventory={inventory} asOf={asOf} />
    </main>
  );
}
