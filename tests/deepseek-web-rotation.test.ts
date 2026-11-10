import { describe, expect, test } from 'vitest';
import { planRotation, normalizeRotationForDigest, type LegacyItem, type OfficialCandidate, type PendingItem, type PlanInput, type SearchRow } from '../crawler/src/deepseek-web/rotation';
import { emptyRotation } from '../crawler/src/deepseek-web/memory-schema';
import type { ScopedCategory } from '../crawler/src/deepseek-web/types';

const CATS: ScopedCategory[] = ['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer'];

const search = (category: ScopedCategory): SearchRow => ({
  url: `https://09pangpang.com/search/r/${category}`,
  product_id: `catalog-${category}`,
  category,
  term: category,
});

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  const pending = overrides.pending ?? [];
  return {
    categories: CATS,
    categoryQuota: 1,
    maxPages: 3,
    legacyBudget: 0,
    pending,
    legacy: [],
    official: [],
    searchRows: Object.fromEntries(CATS.map(category => [category, [search(category)]])) as Record<ScopedCategory, SearchRow[]>,
    pendingUrls: new Set(pending.map(item => item.url)),
    rotation: emptyRotation(),
    categoryDigest: 'digest-a',
    ...overrides,
  };
}

function details(category: ScopedCategory, count: number, prefix = category): PendingItem[] {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://09pangpang.com/post/${prefix}-${index}`,
    category,
    operation: 'discovery' as const,
  }));
}

function noSearches(): Record<ScopedCategory, SearchRow[]> {
  return Object.fromEntries(CATS.map(category => [category, [] as SearchRow[]])) as Record<ScopedCategory, SearchRow[]>;
}

describe('deepseek-web rotation planner', () => {
  test('10 strollers + 2 carriers + 2 bouncers with a 3-page budget serve one per category', () => {
    const pending = [...details('stroller', 10), ...details('carrier', 2), ...details('bouncer', 2)];
    const plan = planRotation(input({ pending, maxPages: 3, searchRows: noSearches() }));
    expect(plan.items).toHaveLength(3);
    expect(plan.items.map(item => item.kind === 'official' ? 'official' : (item as { category?: string }).category)).toEqual(['stroller', 'carrier', 'bouncer']);
    expect(plan.items.every(item => item.kind !== 'search')).toBe(true);
  });

  test('a single-category backlog does not starve search-only categories', () => {
    const pending = details('stroller', 11);
    const plan = planRotation(input({ pending, maxPages: 12 }));
    expect(plan.items).toHaveLength(6);
    expect(plan.items.filter(item => item.kind === 'search')).toHaveLength(5);
    expect(plan.items.filter(item => item.kind === 'discovery')).toHaveLength(1);
    expect(new Set(plan.served).size).toBe(CATS.length);
  });

  test('a tight budget rotates pending and search categories across cycles', () => {
    const pending = [...details('stroller', 10), ...details('carrier', 2), ...details('bouncer', 2)];
    let rotation = emptyRotation();
    const served = new Set<ScopedCategory>();
    const perCycle: ScopedCategory[][] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const plan = planRotation(input({ pending, maxPages: 3, rotation }));
      const categories = plan.items.flatMap(item => 'category' in item ? [item.category] : []);
      perCycle.push(categories);
      for (const category of categories) served.add(category);
      rotation = plan.rotation;
    }
    expect(perCycle[0]).toEqual(['stroller', 'high_chair', 'car_seat']);
    expect(perCycle[1]).toEqual(['play_gym', 'carrier', 'bouncer']);
    expect([...served].sort()).toEqual([...CATS].sort());
  });

  test('maxPages=1 serves all six categories in six cycles', () => {
    let rotation = emptyRotation();
    const served = new Set<ScopedCategory>();
    for (let cycle = 0; cycle < 6; cycle++) {
      const plan = planRotation(input({ rotation, maxPages: 1 }));
      for (const item of plan.items) if ('category' in item) served.add(item.category);
      rotation = plan.rotation;
    }
    expect([...served].sort()).toEqual([...CATS].sort());
  });

  test('maxPages=2 serves all six categories in three cycles', () => {
    let rotation = emptyRotation();
    const served = new Set<ScopedCategory>();
    for (let cycle = 0; cycle < 3; cycle++) {
      const plan = planRotation(input({ rotation, maxPages: 2 }));
      for (const item of plan.items) if ('category' in item) served.add(item.category);
      rotation = plan.rotation;
    }
    expect([...served].sort()).toEqual([...CATS].sort());
  });

  test('official work is selected before pending detail work and catalog searches', () => {
    const pending = details('stroller', 10);
    const official: OfficialCandidate[] = [{ id: 'official-carrier', fetch_url: 'https://example.org/carrier', canonical_url: 'https://example.org/carrier', category: 'carrier', registry_id: 'official:fixture', fields: ['official_msrp'] }];
    const plan = planRotation(input({ pending, official, maxPages: 3, searchRows: noSearches() }));
    expect(plan.items[0]).toMatchObject({ kind: 'official', source_id: 'official-carrier' });
    expect(plan.items[1]).toMatchObject({ kind: 'discovery', category: 'stroller' });
    expect(plan.items.filter(item => item.kind === 'search')).toHaveLength(0);
    expect(plan.items).toHaveLength(2);
  });

  test('the mixed window never selects a search for a category with pending work', () => {
    const plan = planRotation(input({ pending: details('stroller', 2), maxPages: 4 }));
    expect(plan.items.some(item => item.kind === 'search' && item.category === 'stroller')).toBe(false);
    expect(plan.items.filter(item => item.kind === 'discovery')).toHaveLength(1);
    expect(plan.items.filter(item => item.kind === 'search')).toHaveLength(3);
  });

  test('official cursor rotates multiple due official pages in one category', () => {
    const official: OfficialCandidate[] = ['one', 'two'].map(id => ({
      id, fetch_url: `https://example.org/${id}`, canonical_url: `https://example.org/${id}`, category: 'bouncer' as const, registry_id: 'official:fixture', fields: ['official_msrp'],
    }));
    const first = planRotation(input({ official, maxPages: 1 }));
    expect(first.items[0]).toMatchObject({ kind: 'official', source_id: 'one' });
    const second = planRotation(input({ official, maxPages: 1, rotation: first.rotation }));
    expect(second.items[0]).toMatchObject({ kind: 'official', source_id: 'two' });
  });

  test('legacy work gets its reserved slot even when category work fills the category cap', () => {
    const legacy: LegacyItem[] = [{ url: 'https://09pangpang.com/search/r/seed', operation: 'discovery' }];
    const plan = planRotation(input({ pending: details('stroller', 5), legacy, maxPages: 2, legacyBudget: 1 }));
    expect(plan.items).toHaveLength(2);
    expect(plan.items.filter(item => item.kind === 'legacy')).toHaveLength(1);
    expect(plan.items.filter(item => item.kind === 'discovery')).toHaveLength(1);
  });

  test('legacy work uses leftover capacity when no category work can fill it', () => {
    const legacy: LegacyItem[] = [{ url: 'https://09pangpang.com/search/r/seed', operation: 'discovery' }];
    const plan = planRotation(input({ legacy, maxPages: 3, legacyBudget: 0, searchRows: noSearches() }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ kind: 'legacy', url: 'https://09pangpang.com/search/r/seed' });
  });

  test('legacy work rotates so one URL cannot monopolise the reserved slot', () => {
    const legacy: LegacyItem[] = [
      { url: 'https://09pangpang.com/search/r/a', operation: 'discovery' },
      { url: 'https://09pangpang.com/search/r/b', operation: 'discovery' },
    ];
    const first = planRotation(input({ legacy, maxPages: 1, legacyBudget: 1, searchRows: noSearches() }));
    expect(first.items[0]).toMatchObject({ kind: 'legacy', url: 'https://09pangpang.com/search/r/a' });
    expect(first.rotation.legacy_cursor).toBe(1);
    const second = planRotation(input({ legacy, maxPages: 1, legacyBudget: 1, rotation: first.rotation, searchRows: noSearches() }));
    expect(second.items[0]).toMatchObject({ kind: 'legacy', url: 'https://09pangpang.com/search/r/b' });
    expect(second.rotation.legacy_cursor).toBe(0);
  });

  test('a truncated window rotates the next cycle start', () => {
    const plan = planRotation(input({ pending: [...details('stroller', 1), ...details('high_chair', 1)], maxPages: 1 }));
    expect(plan.items).toHaveLength(1);
    expect(plan.rotation.category_cursor).toBe(1);
    const next = planRotation(input({ pending: [...details('high_chair', 1)], rotation: plan.rotation, maxPages: 1 }));
    expect(next.items[0]).toMatchObject({ category: 'high_chair' });
  });

  test('category digest change resets cursors but retains official visit history', () => {
    const rotation = {
      ...emptyRotation(),
      category_digest: 'old',
      category_cursor: 4,
      legacy_cursor: 3,
      search_cursor: { stroller: 2 },
      official_cursor: { carrier: 1 },
      official_visits: {
        stokke: { source_id: 'stokke', url: 'https://example.org/a/', canonical_url: 'https://example.org/a', last_at: '2026-01-01T00:00:00Z', next_due_at: '2026-01-02T00:00:00Z', outcome: 'fetched' as const, reason: null },
      },
    };
    const reset = normalizeRotationForDigest(rotation, 'new');
    expect(reset).toMatchObject({ category_digest: 'new', category_cursor: 0, legacy_cursor: 0, search_cursor: {}, official_cursor: {} });
    expect(reset.official_visits).toEqual(rotation.official_visits);
    expect(normalizeRotationForDigest({ ...rotation, category_digest: 'new' }, 'new').category_cursor).toBe(4);
  });

  test('rotation state round-trips through JSON', () => {
    const plan = planRotation(input({ pending: details('carrier', 2), maxPages: 2 }));
    expect(JSON.parse(JSON.stringify(plan.rotation))).toEqual(plan.rotation);
  });

  test('a full mixed window leaves the cursor untouched', () => {
    const plan = planRotation(input({ maxPages: 6 }));
    expect(plan.items).toHaveLength(6);
    expect(plan.rotation.category_cursor).toBe(0);
  });
});
