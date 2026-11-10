import type { RotationState, ScopedCategory } from './types';

export type PendingItem = {
  url: string;
  category: ScopedCategory;
  operation: 'recheck' | 'discovery';
};

export type LegacyItem = {
  url: string;
  operation: 'recheck' | 'discovery';
};

export type OfficialCandidate = {
  id: string;
  fetch_url: string;
  canonical_url: string;
  category: ScopedCategory;
  registry_id: string;
  fields: string[];
};

export type SearchRow = {
  url: string;
  product_id: string;
  category: ScopedCategory;
  term: string;
};

export type WorkItem =
  | { kind: 'explicit'; tier: -1; url: string }
  | { kind: 'official'; tier: 0; url: string; category: ScopedCategory; source_id: string; canonical_url: string; registry_id: string; fields: string[] }
  | { kind: 'recheck'; tier: 1; url: string; category: ScopedCategory }
  | { kind: 'discovery'; tier: 2; url: string; category: ScopedCategory }
  | { kind: 'search'; tier: 3; url: string; category: ScopedCategory; product_id: string; term: string }
  | { kind: 'legacy'; tier: 4; url: string; operation: 'recheck' | 'discovery' };

export type PlanInput = {
  categories: readonly ScopedCategory[];
  categoryQuota: number;
  maxPages: number;
  legacyBudget: number;
  pending: readonly PendingItem[];
  legacy: readonly LegacyItem[];
  official: readonly OfficialCandidate[];
  searchRows: Readonly<Record<ScopedCategory, readonly SearchRow[]>>;
  pendingUrls: ReadonlySet<string>;
  rotation: RotationState;
  categoryDigest: string;
};

export type PlanResult = {
  items: WorkItem[];
  rotation: RotationState;
  scheduled: ScopedCategory[];
  served: ScopedCategory[];
};

/** Reset scheduling cursors when the category policy changes, keeping visit history. */
export function normalizeRotationForDigest(rotation: RotationState, digest: string): RotationState {
  if (rotation.category_digest === digest) return rotation;
  return { ...rotation, category_digest: digest, category_cursor: 0, legacy_cursor: 0, search_cursor: {}, official_cursor: {} };
}

function rotate<T>(rows: readonly T[], cursor: number): T[] {
  if (!rows.length) return [];
  const index = ((cursor % rows.length) + rows.length) % rows.length;
  return [...rows.slice(index), ...rows.slice(0, index)];
}

function byUrl(a: { url: string }, b: { url: string }) {
  return a.url.localeCompare(b.url);
}

/**
 * Quota-fair planner.
 *
 * 1. Due official pages are selected first, round-robin across categories, up to
 *    the page budget. They are visit-only and low-frequency, so they do not spend
 *    a category's catalog quota; when they fill a cycle the categories get their
 *    turn on the next (non-official) cycle.
 * 2. One mixed rotation window follows. Every category gets a turn: up to
 *    `categoryQuota` pending/official-detail items, or one catalog search when the
 *    category has no work. Because searches share the same rotation window, a
 *    backlog concentrated in one category cannot consume every slot and starve
 *    search-only categories.
 * 3. Legacy/uncategorized work is guaranteed `legacy_budget_per_cycle` and may use
 *    any leftover capacity. Its starting point rotates so one URL cannot hold the
 *    reserved slot forever.
 *
 * The category cursor advances by the number of categories examined in the first
 * window that hit the page cap, so a truncated cycle rotates the next cycle's
 * starting point.
 */
export function planRotation(input: PlanInput): PlanResult {
  const rotation: RotationState = {
    ...input.rotation,
    legacy_cursor: input.rotation.legacy_cursor ?? 0,
    search_cursor: { ...input.rotation.search_cursor },
    official_cursor: { ...input.rotation.official_cursor },
  };
  const categories = [...input.categories];
  const C = categories.length;
  const maxPages = Math.max(0, input.maxPages);
  const quota = Math.max(1, input.categoryQuota);

  const legacyWork = [...input.legacy].sort((a, b) => (a.operation === b.operation ? byUrl(a, b) : a.operation === 'recheck' ? -1 : 1));
  const reservedLegacy = Math.min(Math.max(0, input.legacyBudget), legacyWork.length);
  const categoryCap = Math.max(0, maxPages - reservedLegacy);

  const order = rotate(categories, rotation.category_cursor);
  const pendingCategories = new Set(input.pending.map(p => p.category));
  const officialQueues = new Map<ScopedCategory, WorkItem[]>();
  const pendingQueues = new Map<ScopedCategory, WorkItem[]>();
  for (const category of categories) {
    officialQueues.set(category, rotate(
      input.official.filter(o => o.category === category).sort((a, b) => a.id.localeCompare(b.id)),
      rotation.official_cursor[category] ?? 0,
    ).map<WorkItem>(o => ({ kind: 'official', tier: 0, url: o.fetch_url, category, source_id: o.id, canonical_url: o.canonical_url, registry_id: o.registry_id, fields: o.fields })));
    pendingQueues.set(category, [
      ...input.pending.filter(p => p.category === category && p.operation === 'recheck').sort(byUrl).map<WorkItem>(p => ({ kind: 'recheck', tier: 1, url: p.url, category })),
      ...input.pending.filter(p => p.category === category && p.operation === 'discovery').sort(byUrl).map<WorkItem>(p => ({ kind: 'discovery', tier: 2, url: p.url, category })),
    ]);
  }

  const items: WorkItem[] = [];
  const served = new Set<ScopedCategory>();
  let cursorAdvance: number | null = null;

  // Official pass: due official pages first, round-robin across the rotation window.
  if (C > 0 && categoryCap > 0) {
    let round = 0;
    let added = true;
    while (items.length < categoryCap && added) {
      added = false;
      let examined = 0;
      for (const category of order) {
        examined++;
        const queue = officialQueues.get(category)!;
        for (let n = 0; n < quota && queue.length && items.length < categoryCap; n++) {
          const item = queue.shift()!;
          items.push(item);
          served.add(category);
          added = true;
          rotation.official_cursor[category] = (rotation.official_cursor[category] ?? 0) + 1;
        }
        if (items.length >= categoryCap) {
          // Only a truncated first window changes the rotation start. Extra rounds
          // already examined every category, so the cursor stays put.
          if (round === 0) cursorAdvance = examined;
          break;
        }
      }
      round++;
    }
  }

  // Mixed rotation window: pending work or, for idle categories, one catalog search.
  if (C > 0 && items.length < categoryCap) {
    let examined = 0;
    for (const category of order) {
      examined++;
      const queue = pendingQueues.get(category)!;
      let added = false;
      for (let n = 0; n < quota && queue.length && items.length < categoryCap; n++) {
        items.push(queue.shift()!);
        served.add(category);
        added = true;
      }
      if (!added && queue.length === 0 && !pendingCategories.has(category)) {
        const search = pickSearch(input, rotation, items, category);
        if (search) {
          items.push(search);
          served.add(category);
        }
      }
      if (items.length >= categoryCap) {
        cursorAdvance = examined;
        break;
      }
    }
  }

  if (cursorAdvance !== null && C > 0) {
    rotation.category_cursor = ((rotation.category_cursor + cursorAdvance) % C + C) % C;
  }

  // Legacy work is guaranteed its reserve and may use leftover capacity.
  const remaining = maxPages - items.length;
  if (remaining > 0 && legacyWork.length) {
    const rotatedLegacy = rotate(legacyWork, rotation.legacy_cursor);
    const selected = rotatedLegacy.slice(0, remaining);
    for (const item of selected) items.push({ kind: 'legacy', tier: 4, url: item.url, operation: item.operation });
    rotation.legacy_cursor = (rotation.legacy_cursor + selected.length) % legacyWork.length;
  }

  const scheduled = [...new Set(items.flatMap(item => 'category' in item ? [item.category] : []))];
  rotation.last_cycle = { categories: scheduled, official: items.filter(i => i.kind === 'official').length, pages: items.length };
  return { items, rotation, scheduled, served: scheduled };
}

/** Pick the next selectable search row for a category, skipping pending/selected URLs. */
function pickSearch(input: PlanInput, rotation: RotationState, items: readonly WorkItem[], category: ScopedCategory): WorkItem | null {
  const rows = input.searchRows[category] ?? [];
  if (!rows.length) return null;
  const cursor = rotation.search_cursor[category] ?? 0;
  for (let offset = 0; offset < rows.length; offset++) {
    const index = ((cursor + offset) % rows.length + rows.length) % rows.length;
    const row = rows[index];
    if (input.pendingUrls.has(row.url) || items.some(item => item.url === row.url)) continue;
    rotation.search_cursor[category] = index + 1;
    return { kind: 'search', tier: 3, url: row.url, category, product_id: row.product_id, term: row.term };
  }
  return null;
}
