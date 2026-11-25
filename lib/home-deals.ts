import { homeCopy } from './copy/home.ko';
import { dealFields, dealContextJoins, type DealWithContext } from './deals';
import { ROUND_LINK, validPublicationProof } from './deal-evidence-sql';
import { activeStart, officialProofExpiry, publicDealApprovalExpiry, publicDealEligibility, verifiedActive, verifiedInterval, verifiedStart } from './verified-deal-sql';

export const sectionKeys = ['closing', 'low', 'discount', 'new'] as const;
export type SectionKey = typeof sectionKeys[number];
export type HomeFilters = { category: string | null; brand: string | null };
export type HomeFacet = { value: string; label: string; count: number };
export type HomeInventory = {
  count: number;
  maximum: number | null;
  nextRefreshAt: string;
  categories: HomeFacet[];
  brands: HomeFacet[];
  sections: { key: SectionKey; deals: DealWithContext[] }[];
};
type HomeSummary = Omit<HomeInventory, 'sections'> & { sections: Record<SectionKey, string[]> };
const categoryEntries = Object.entries(homeCopy.categories);
const cardJson = Object.entries(dealFields('clock.as_of')).map(([key, column]) => `'${key}', ${column}`).join(', ');

// Narrow projections drive filters, history, rankings and refresh. Only the
// distinct preview IDs reach the shared public card projection.
export const HOME_DEALS_SQL = `
WITH clock(as_of, midnight, recent, category, brand) AS (VALUES (?, ?, ?, ?, ?)),
categories(value, label, position) AS (VALUES ${categoryEntries.map((_, index) => `(?, ?, ${index})`).join(', ')}),
intervals AS MATERIALIZED (
  SELECT d.id, d.model_id, d.version, d.price_evidence_id, d.deal_price_krw AS price,
    d.ends_at AS closing, d.discount_pct,
    MIN(${officialProofExpiry('d.price_checked_at')}, (${publicDealApprovalExpiry('d', 'clock.as_of')})) AS proof_expiry
  FROM clock CROSS JOIN deals AS d INDEXED BY verified_deal_ending
  WHERE ${verifiedActive} AND d.ends_at >= clock.as_of AND ${activeStart} <= clock.as_of
    AND ${publicDealEligibility('d', 'clock.as_of')}
),
brand_labels AS (
  SELECT brand AS label, 0 AS priority FROM models
  UNION ALL
  SELECT trim(d.brand_label), 1
  FROM deals AS d INDEXED BY published_unmatched_deal_brands
  WHERE d.status = 'published' AND d.model_id IS NULL AND d.brand_label IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deal_bundle_items WHERE deal_id = d.id)
  UNION ALL
  SELECT trim(b.brand), 1 FROM deal_bundle_items AS b INDEXED BY unmatched_bundle_brands
  CROSS JOIN deals AS d ON d.id = b.deal_id AND d.status = 'published'
  WHERE b.model_id IS NULL AND b.brand IS NOT NULL
),
brand_choices AS MATERIALIZED (
  SELECT lower(label) AS brand_key, COALESCE(MIN(CASE WHEN priority = 0 THEN label END), MIN(label)) AS label
  FROM brand_labels WHERE label <> '' GROUP BY lower(label)
),
items AS MATERIALIZED (
  SELECT i.id,
    lower(CASE WHEN m.id IS NOT NULL THEN m.brand ELSE trim(d.brand_label) END) AS brand_key,
    c.value AS category
  FROM intervals AS i
  CROSS JOIN deals AS d ON d.id = i.id
  LEFT JOIN models AS m ON m.id = i.model_id
  LEFT JOIN categories AS c ON (CASE WHEN m.id IS NOT NULL THEN m.category ELSE trim(d.category_label) END) IN (c.value, c.label)
  WHERE NOT EXISTS (SELECT 1 FROM deal_bundle_items WHERE deal_id = i.id)
  UNION ALL
  SELECT i.id, lower(CASE WHEN m.id IS NOT NULL THEN m.brand ELSE trim(b.brand) END), c.value
  FROM intervals AS i
  CROSS JOIN deal_bundle_items AS b ON b.deal_id = i.id
  LEFT JOIN models AS m ON m.id = b.model_id
  LEFT JOIN deals AS d ON d.id = i.id AND 1 = (SELECT COUNT(*) FROM deal_bundle_items WHERE deal_id = i.id)
  LEFT JOIN categories AS c ON (CASE WHEN m.id IS NOT NULL THEN m.category ELSE trim(d.category_label) END) IN (c.value, c.label)
),
category_counts AS (
  SELECT item.category, COUNT(DISTINCT item.id) AS count FROM items AS item, clock
  WHERE clock.brand IS NULL OR item.brand_key = lower(clock.brand) GROUP BY item.category
),
brand_counts AS (
  SELECT item.brand_key, COUNT(DISTINCT item.id) AS count FROM items AS item, clock
  WHERE clock.category IS NULL OR item.category = clock.category GROUP BY item.brand_key
),
matching_ids AS MATERIALIZED (
  SELECT DISTINCT item.id FROM items AS item, clock
  WHERE (clock.category IS NULL OR item.category = clock.category)
    AND (clock.brand IS NULL OR item.brand_key = lower(clock.brand))
),
matching AS MATERIALIZED (
  SELECT i.* FROM intervals AS i, clock
  WHERE (clock.category IS NULL AND clock.brand IS NULL) OR i.id IN (SELECT id FROM matching_ids)
),
comparable AS MATERIALIZED (
  SELECT a.*, h.configuration_key, h.opened_at, sr.id AS round_id, sr.opened_at AS round_opening
  FROM matching AS a CROSS JOIN clock
  CROSS JOIN deals AS d ON d.id = a.id
  LEFT JOIN deal_price_history h ON h.deal_id=a.id AND h.deal_version=a.version
    AND h.price_evidence_id=a.price_evidence_id AND h.published_at<=clock.as_of AND ${validPublicationProof('h')}
  ${ROUND_LINK}
),
target_configurations AS (
  SELECT DISTINCT configuration_key FROM comparable
  WHERE configuration_key IS NOT NULL AND round_opening <= (SELECT as_of FROM clock)
),
history AS MATERIALIZED (
  SELECT h.configuration_key, h.deal_price_krw AS price, sr.id AS round_id, sr.opened_at AS round_opening
  FROM target_configurations AS target
  CROSS JOIN deal_price_history AS h ON h.configuration_key = target.configuration_key
  CROSS JOIN deals AS d ON d.id = h.deal_id AND d.status = 'published'
  LEFT JOIN deal_round_reviews rr ON rr.deal_id=h.deal_id AND rr.deal_version=h.deal_version
  LEFT JOIN seller_rounds sr ON sr.id=rr.round_id AND sr.seller_id=d.seller_id
  CROSS JOIN clock
  WHERE h.published_at<=clock.as_of AND ${validPublicationProof('h')}
),
configuration_lows AS (
  SELECT configuration_key, MIN(price) AS lowest FROM history GROUP BY configuration_key
),
round_prices AS MATERIALIZED (
  SELECT configuration_key, round_id, round_opening
  FROM history, clock WHERE round_opening<=clock.as_of
  GROUP BY configuration_key, round_id HAVING MIN(price)=MAX(price)
),
lows AS (
  SELECT a.id, a.closing FROM comparable AS a
  JOIN configuration_lows AS low ON low.configuration_key=a.configuration_key AND low.lowest=a.price
  JOIN round_prices AS own ON own.configuration_key=a.configuration_key AND own.round_id=a.round_id
  WHERE EXISTS (
    SELECT 1 FROM round_prices AS prior
    WHERE prior.configuration_key=a.configuration_key AND prior.round_id<>a.round_id
      AND prior.round_opening<a.round_opening
  )
),
today_preview AS (
  SELECT id FROM matching, clock WHERE closing < midnight ORDER BY closing, id LIMIT 3
),
low_preview AS (
  SELECT id FROM lows ORDER BY closing, id LIMIT 3
),
discount_preview AS (
  SELECT id FROM matching ORDER BY discount_pct DESC, closing, id LIMIT 3
),
new_preview AS (
  SELECT id FROM comparable, clock WHERE opened_at BETWEEN recent AND as_of ORDER BY opened_at DESC, id LIMIT 3
),
selected_ids AS MATERIALIZED (
  SELECT id FROM today_preview UNION SELECT id FROM low_preview
  UNION SELECT id FROM discount_preview UNION SELECT id FROM new_preview
),
refresh_candidates(instant) AS (
  SELECT midnight FROM clock
  UNION ALL SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(closing), '+0.001 seconds') FROM intervals
  UNION ALL SELECT MIN(proof_expiry) FROM intervals
  UNION ALL
  SELECT (SELECT d.${verifiedStart} FROM deals AS d INDEXED BY verified_deal_upcoming
    WHERE ${verifiedInterval} AND d.${verifiedStart} > clock.as_of
      AND ${publicDealEligibility('d','clock.as_of')}
      AND d.${verifiedStart} < MIN(${officialProofExpiry('d.price_checked_at')}, (${publicDealApprovalExpiry('d', 'clock.as_of')}))
    ORDER BY d.${verifiedStart}, d.id LIMIT 1)
  FROM clock
  UNION ALL SELECT MIN(r.opened_at) FROM seller_rounds r, clock
    WHERE r.opened_at>as_of AND EXISTS (SELECT 1 FROM deal_round_reviews link JOIN intervals i ON i.id=link.deal_id
      AND i.version=link.deal_version WHERE link.round_id=r.id)
)
SELECT 'summary' AS kind, json_object(
  'count', (SELECT COUNT(*) FROM matching),
  'maximum', (SELECT MAX(discount_pct) FROM matching),
  'nextRefreshAt', (SELECT MIN(instant) FROM refresh_candidates),
  'categories', (SELECT json_group_array(json_object('value', c.value, 'label', c.label, 'count', COALESCE(n.count, 0)) ORDER BY c.position)
    FROM categories AS c LEFT JOIN category_counts AS n ON n.category = c.value),
  'brands', (SELECT json_group_array(json_object('value', b.label, 'label', b.label, 'count', COALESCE(n.count, 0)) ORDER BY b.label COLLATE NOCASE, b.label)
    FROM brand_choices AS b LEFT JOIN brand_counts AS n ON n.brand_key = b.brand_key),
  'sections', json_object(
    'closing', (SELECT json_group_array(id) FROM today_preview),
    'low', (SELECT json_group_array(id) FROM low_preview),
    'discount', (SELECT json_group_array(id) FROM discount_preview),
    'new', (SELECT json_group_array(id) FROM new_preview)
  )
) AS payload
UNION ALL
SELECT 'card', json_object(${cardJson})
FROM selected_ids AS picked CROSS JOIN deals AS d ON d.id = picked.id CROSS JOIN clock
${dealContextJoins}
`;

export async function homeDeals(db: D1Database, asOf: number, filters: HomeFilters): Promise<HomeInventory> {
  const day = 86_400_000;
  const offset = 9 * 3_600_000;
  const midnight = Math.floor((asOf + offset) / day) * day - offset;
  const iso = (instant: number) => new Date(instant).toISOString();
  const result = await db.prepare(HOME_DEALS_SQL)
    .bind(iso(asOf), iso(midnight + day), iso(midnight - 6 * day), filters.category, filters.brand, ...categoryEntries.flat())
    .all<{ kind: 'summary' | 'card'; payload: string }>();
  const summaryRow = result.results?.find(row => row.kind === 'summary');
  if (!result.success || !summaryRow) throw new Error('Home deal query failed');
  const { sections, ...summary } = JSON.parse(summaryRow.payload) as HomeSummary;
  const cards = new Map(result.results.filter(row => row.kind === 'card').map(row => {
    const card = JSON.parse(row.payload) as DealWithContext;
    return [card.id, card] as const;
  }));
  return {
    ...summary,
    sections: sectionKeys.map(key => ({
      key, deals: sections[key].map(id => cards.get(id)!),
    })),
  };
}
