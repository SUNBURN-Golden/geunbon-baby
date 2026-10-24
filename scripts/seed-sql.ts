import { models } from '../seed/models.json';
import tripp from '../seed/tripp_trapp.json';

const quote = (v: string | number | null) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;

export function buildSeedSql() {
  // Explicit columns keep model notes and official prices separate from seller identities.
  const rows = models.map((m, i) => `INSERT INTO models (id,brand,name,category,importer,importer_status,official_price,source_url,checked,verify_level,note) VALUES (${[ `model-${i + 1}`, m.brand, m.model, m.category, m.kr_importer, m.kr_importer_status, m.kr_official_price_krw, m.source_url, m.checked, m.verify_level, m.note ].map(quote).join(',')}) ON CONFLICT(id) DO NOTHING;`);
  const sellers = [...new Map(tripp.kr_retailers.map(r => [r.retailer, r])).values()];
  rows.push(...sellers.map((s, i) => `INSERT INTO sellers (id,name,source_url) VALUES (${[`seller-${i + 1}`, s.retailer, s.source].map(quote).join(',')}) ON CONFLICT(id) DO NOTHING;`));
  return { sql: rows.join('\n'), modelCount: models.length, sellerCount: sellers.length, checked: tripp.checked };
}
