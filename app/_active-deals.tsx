import { homeCopy } from '../lib/copy/home.ko';
import { type HomeFacet, type HomeFilters, type HomeInventory } from '../lib/home-deals';
import { dealsCopy } from '../lib/deals-copy';
import { DealList } from './deals/_components';

export function ActiveDealCount({ count }: { count: number }) {
  return <span className="active-deal-count" aria-label={dealsCopy.activeCount.replace('{count}', String(count))}>{count}</span>;
}

function filterHref(filters: HomeFilters) {
  const query = new URLSearchParams();
  if (filters.category) query.set('category', filters.category);
  if (filters.brand) query.set('brand', filters.brand);
  return query.size ? `/?${query}` : '/';
}

function FacetRow({ group, facets, filters }: { group: keyof HomeFilters; facets: HomeFacet[]; filters: HomeFilters }) {
  const label = group === 'category' ? homeCopy.categoryFilters : homeCopy.brandFilters;
  return (
    <ul className="home-facet-row" aria-label={label}>
      {facets.map(facet => {
        const selected = group === 'brand' ? filters.brand?.toLowerCase() === facet.value.toLowerCase() : filters.category === facet.value;
        return (
          <li key={facet.value}>
            <a href={filterHref({ ...filters, [group]: facet.value })} aria-current={selected ? 'true' : undefined}>
              {facet.label} <span>{facet.count.toLocaleString('ko-KR')}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function HomeQuickFilters({ inventory, filters }: { inventory: HomeInventory; filters: HomeFilters }) {
  return (
    <nav className="home-filters" aria-label={homeCopy.filters}>
      <div className="home-facet-rows">
        <FacetRow group="category" facets={inventory.categories} filters={filters} />
        <FacetRow group="brand" facets={inventory.brands} filters={filters} />
      </div>
      {(filters.category || filters.brand) && <a className="home-clear" href={filterHref({ category: null, brand: null })}>{homeCopy.clear}</a>}
    </nav>
  );
}

export function HomeOfferSections({ inventory, asOf }: { inventory: HomeInventory; asOf: number }) {
  const populated = inventory.sections.filter(section => section.deals.length);
  const empty = inventory.sections.filter(section => !section.deals.length);
  return (
    <div className="home-sections">
      {[...populated, ...empty].map(({ key, deals }) => (
        <section className="home-section" key={key} data-home-section={key} aria-labelledby={`home-${key}`}>
          <h2 id={`home-${key}`}>{homeCopy.sections[key].title}</h2>
          {key === 'low' && deals.length > 0 && <p className="home-section-note">{homeCopy.lowBasis}</p>}
          {deals.length ? <DealList deals={deals} nowMs={asOf} /> : <p className="home-section-note">{homeCopy.sections[key].empty}</p>}
        </section>
      ))}
    </div>
  );
}
