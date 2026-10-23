import { canonicalUrl } from './privacy-rules';

// Pure parser: the Linux discovery adapter remains independently owned. Parity is tested.
export type CpscRecall = {
  recall_id: string; title: string; recall_date: string; url: string;
  product_names: string[]; manufacturer_names: string[];
};
export type BrandRecall = Omit<CpscRecall, 'manufacturer_names'> & { matched_term: string };
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
function safe(raw: unknown): string | null {
  try { return typeof raw === 'string' ? canonicalUrl(raw) : null; } catch { return null; }
}
export function parseCpscRecalls(body: string): CpscRecall[] {
  if (body.trim().startsWith('<')) {
    return [...body.matchAll(/<Recall(?:\s[^>]*)?>([\s\S]*?)<\/Recall>/gi)].slice(0, 500).flatMap(m => {
      const tag = (name: string) => decode(m[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '');
      const url = safe(tag('URL')), id = tag('RecallID');
      const names = (name: string) => [...(m[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '').matchAll(/<Name[^>]*>([\s\S]*?)<\/Name>/gi)].map(n => decode(n[1]));
      return url && /^\d+$/.test(id) ? [{ recall_id: id, title: tag('Title'), recall_date: tag('RecallDate'), url, product_names: names('Products').length ? names('Products') : [tag('Name') || tag('Title')], manufacturer_names: names('Manufacturers') }] : [];
    });
  }
  const rows: unknown = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error('cpsc_schema');
  return rows.slice(0, 500).flatMap(r => {
    if (!r || typeof r !== 'object') return [];
    const url = safe(r.URL);
    const names = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(p => p && typeof p.Name === 'string' ? [p.Name] : []) : [];
    return url && Number.isSafeInteger(r.RecallID) ? [{ recall_id: String(r.RecallID), title: String(r.Title ?? ''), recall_date: String(r.RecallDate ?? ''), url, product_names: names(r.Products), manufacturer_names: names(r.Manufacturers) }] : [];
  });
}
export function mergeRecalls(a: CpscRecall[], b: CpscRecall[]): CpscRecall[] {
  return [...new Map([...a, ...b].map(r => [r.recall_id, r])).values()];
}
export function filterByBrand(rows: CpscRecall[], matchTerms: string[]): BrandRecall[] {
  return rows.flatMap(row => {
    const text = [row.title, ...row.product_names, ...row.manufacturer_names].join(' ');
    const matched = matchTerms.find(term => term.length > 0 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text));
    if (!matched) return [];
    const { manufacturer_names: _manufacturers, ...kept } = row;
    void _manufacturers;
    return [{ ...kept, matched_term: matched }];
  });
}
