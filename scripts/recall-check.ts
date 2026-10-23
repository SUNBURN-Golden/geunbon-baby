// Local Node research only. Never import this module into lib/, app/, or crawler/.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCpscRecalls, mergeRecalls, filterByBrand, type BrandRecall } from '../shared/cpsc-recalls';

export const endpoint = 'https://www.saferproducts.gov/RestWebServices/Recall';
type Sources = Record<string, { cpsc: { query: string; match_terms: string[]; date_from?: string } }>;
type FixtureRow = { title?: unknown; product?: unknown; error?: string };
type Fixture = Record<string, FixtureRow & { queries?: Record<string, FixtureRow> }>;
export type RecallResult = { status: 'ok' | 'fetch_failed'; query: string; queries: string[]; raw_count: number | null; kept: BrandRecall[]; rejected: { recall_id: string; title: string }[]; requests: { query: string; field: string; row_count: number }[]; error?: string };
const kstNow = () => new Date(Date.now() + 9 * 3600_000).toISOString().replace('Z', '+09:00');
const limit = 2 * 1024 * 1024;
export async function readBounded(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`http_${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('response_too_large');
  if (!response.body) throw new Error('empty_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function checkRecalls(sources: Sources, fixture?: Fixture) {
  const brands: Record<string, RecallResult> = {};
  let lastRequest = 0;
  for (const [brand, { cpsc }] of Object.entries(sources)) {
    const queries = [...new Set([cpsc.query, ...cpsc.match_terms])];
    const requests: RecallResult['requests'] = [];
    try {
      let rows: ReturnType<typeof parseCpscRecalls> = [];
      for (const query of queries) {
        for (const field of ['RecallTitle', 'ProductName'] as const) {
          let body: string;
          if (fixture) {
            const entry = fixture[brand];
            const row = entry?.queries ? entry.queries[query] : entry;
            if (!row || row.error) throw new Error('fixture_fetch_failed');
            const value = field === 'RecallTitle' ? row.title : row.product;
            body = typeof value === 'string' ? value : JSON.stringify(value ?? []);
          } else {
            const wait = Math.max(0, 5000 - (Date.now() - lastRequest));
            if (wait) await new Promise(r => setTimeout(r, wait));
            const url = new URL(endpoint);
            url.search = new URLSearchParams({ format: 'json', [field]: query, RecallDateStart: cpsc.date_from ?? '2010-01-01' }).toString();
            lastRequest = Date.now();
            const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': 'AgamajungRecallResearch/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
            body = await readBounded(response);
          }
          const parsed = parseCpscRecalls(body);
          requests.push({ query, field, row_count: parsed.length });
          rows = mergeRecalls(rows, parsed);
        }
      }
      const kept = filterByBrand(rows, cpsc.match_terms);
      const keptIds = new Set(kept.map(row => row.recall_id));
      const rejected = rows.filter(row => !keptIds.has(row.recall_id)).map(({ recall_id, title }) => ({ recall_id, title }));
      brands[brand] = { status: 'ok', query: cpsc.query, queries, raw_count: requests.reduce((n, r) => n + r.row_count, 0), kept, rejected, requests };
    } catch (error) {
      // Only controlled categories are persisted, never remote bodies, headers, or credentials.
      const message = error instanceof Error ? error.message : '';
      const safeError = /^(http_\d{3}|response_too_large|empty_body|cpsc_schema|fixture_fetch_failed)$/.test(message) ? message : 'request_or_parse_failed';
      brands[brand] = { status: 'fetch_failed', query: cpsc.query, queries, raw_count: null, kept: [], rejected: [], requests, error: safeError };
    }
  }
  return { endpoint, checked_at: kstNow(), empty_result_is_not_safety_guarantee: true, brands };
}
export async function main(args = process.argv.slice(2)) {
  const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const sources: Sources = JSON.parse(await readFile(value('--sources', 'seed/official-sources.json'), 'utf8'));
  const fixture: Fixture | undefined = args.includes('--fixture') ? JSON.parse(await readFile(value('--fixture', ''), 'utf8')) : undefined;
  const result = await checkRecalls(sources, fixture);
  if (Object.values(result.brands).every(row => row.status === 'fetch_failed')) throw new Error('all_brands_failed: output preserved');
  await writeFile(value('--out', 'seed/recalls.json'), JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Recall check failed; output preserved.'); process.exitCode = 1; });
}
