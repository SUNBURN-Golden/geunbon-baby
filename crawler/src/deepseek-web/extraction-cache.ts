import { FACT_CHECK_VERSION, CHECKED_SCHEMA_VERSION, INTERPRETATION_POLICY } from '../../lib/deal-fact-check';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalUrl, filterChanged, filterText, PRIVACY_VERSION, URL_IDENTITY_VERSION } from '../../../shared/privacy-rules';
import { safeEtag, safeModified } from '../agamajung/http-validators';
import { atomicState, readState, safePath } from './atomic-state';
import { sha256, PREPARATION_VERSION } from './page-content';
import { CANDIDATE_FILTER_VERSION, type CandidateDecision } from './candidate-filter';
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS, OUTPUT_SCHEMA, VALIDATION_VERSION, validateLegacyExtraction, validateCheckedExtraction, isCheckedExtraction } from './extract';
import type { GeunbonCatalog } from './catalog';
import type { DeepSeekWebConfig, GongguExtraction, ModelProfile, ParserFixProposal } from './types';
import { REQUEST_REPRESENTATION } from '../../lib/external/fetch';
export const CACHE_VERSION = 2;
export { stableSerialize, cacheKey } from './cache-identity';
import { stableSerialize, cacheKey } from './cache-identity';
export function contractHash(config: DeepSeekWebConfig, catalog: GeunbonCatalog, profile: ModelProfile) {
  return sha256(stableSerialize({ provider: config.model.provider, profile, response_format: 'json_object', system: SYSTEM_INSTRUCTIONS, schema: OUTPUT_SCHEMA,
    prompt: PROMPT_VERSION, preparation: PREPARATION_VERSION, privacy: PRIVACY_VERSION, identity: URL_IDENTITY_VERSION,
    filter: CANDIDATE_FILTER_VERSION, catalog, scope: config.scope_categories, validation: VALIDATION_VERSION, fact_check: FACT_CHECK_VERSION, checked_schema: CHECKED_SCHEMA_VERSION, interpretation: INTERPRETATION_POLICY }));
}
export const urlContractKey = (url: string, contract: string) => sha256(stableSerialize([url, contract, REQUEST_REPRESENTATION]));
export type CacheEntry = {
  version: 1 | 2; cache_key: string; canonical_url: string; content_hash: string; contract_hash: string;
  candidate: CandidateDecision; result: GongguExtraction; extracted_at: string;
  proposal: ParserFixProposal | null; pending_delivery: boolean;
};
export type Representation = { version: 1; canonical_url: string; contract_hash: string; representation: string; fetch_url: string; entry_key: string | null; content_hash: string | null; etag: string | null; last_modified: string | null; revalidated_at: string };
export type PendingResult = { version: 1 | 2; entry: CacheEntry; representation: Representation };
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const fail = () => new Error('extraction_cache_unavailable');
const ENTRY_NAME = /^[a-f0-9]{64}\.json$/;
// Matches the atomic writer's `.<randomUUID()>.tmp` files only.
const TEMP_NAME = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
function read<T>(path: string): T | null {
  try {
    const p = safePath(path), stat = lstatSync(p);
    if (stat.size > 48000 || !(stat.mode & 0o444)) throw fail();
    const parsed = JSON.parse(readState(p));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail();
    return parsed;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw fail(); }
}
export function validEntry(e: CacheEntry): boolean {
  try {
    if (!e || ![1, 2].includes(e.version) || !hex(e.cache_key) || !hex(e.content_hash) || !hex(e.contract_hash) || canonicalUrl(e.canonical_url) !== e.canonical_url || e.cache_key !== cacheKey(e.canonical_url, e.content_hash, e.contract_hash) || !time(e.extracted_at) || typeof e.pending_delivery !== 'boolean') return false;
    if (Buffer.byteLength(JSON.stringify(e), 'utf8') > 48000 || Object.keys(e).some(k => !['version', 'cache_key', 'canonical_url', 'content_hash', 'contract_hash', 'candidate', 'result', 'extracted_at', 'proposal', 'pending_delivery'].includes(k))) return false;
    if (!e.candidate?.accepted || !['candidate_pangpang_deal', 'candidate_text_deal'].includes(e.candidate.code) || !e.candidate.match || typeof e.candidate.match.product_id !== 'string') return false;
    if (Object.keys(e.candidate).some(k => !['accepted', 'code', 'match'].includes(k)) || Object.keys(e.result).some(k => !['brand', 'model', 'category', 'gonggu_price', 'regular_price', 'period', 'gifts', 'conditions', 'seller', 'url', 'checked_date', 'in_scope', 'notes', 'catalog_product_id', 'offer_ref', ...(e.version === 2 ? ['start_date', 'end_date', 'fact_check'] : [])].includes(k))) return false;
    const match = e.candidate.match;
    if (!['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer'].includes(match.category) || ![match.product_id, match.brand, match.product_line].every(v => typeof v === 'string' && v.length > 0 && v.length <= 100 && !filterChanged(v)) || !Number.isSafeInteger(match.score) || match.score < 1) return false;
    if (e.result.offer_ref !== undefined && (typeof e.result.offer_ref !== 'string' || !/^\d{1,40}$/.test(e.result.offer_ref))) return false;
    if (e.version === 2) {
      validateCheckedExtraction(e.result);
      if (e.result.fact_check!.source_hash !== e.content_hash || e.result.fact_check!.observed_at !== e.extracted_at) return false;
    } else {
      const validated = validateLegacyExtraction(JSON.stringify(e.result), e.canonical_url, e.result.checked_date);
      if (validated.url !== e.result.url) return false;
    }
    if (e.result.url !== e.canonical_url || e.result.catalog_product_id !== e.candidate.match.product_id) return false;
    if (e.version === 2 && e.proposal && ![e.result.fact_check!.fields.gonggu_price,e.result.fact_check!.fields.regular_price].some(f => f.value !== null && f.evidence.quote === e.proposal!.evidence_quote)) return false;
    if (e.proposal && Object.values(e.proposal).some(v => typeof v === 'string' && filterChanged(v))) return false;
    if (e.proposal !== null && (!e.proposal || e.proposal.kind !== 'parser_fix_proposal' || e.proposal.self_edit !== false || e.proposal.url !== e.canonical_url || JSON.stringify(e.proposal).length > 4000)) return false;
    return true;
  } catch { return false; }
}
export function validRepresentation(r: Representation): boolean {
  try {
    return !!r && !Object.keys(r).some(k => !['version', 'canonical_url', 'contract_hash', 'representation', 'fetch_url', 'entry_key', 'content_hash', 'etag', 'last_modified', 'revalidated_at'].includes(k)) && r.version === 1 && canonicalUrl(r.canonical_url) === r.canonical_url && canonicalUrl(r.fetch_url) === r.canonical_url && filterText(r.fetch_url, 2048) === r.fetch_url && hex(r.contract_hash) && r.representation === REQUEST_REPRESENTATION &&
      (r.entry_key === null && r.content_hash === null || hex(r.entry_key) && hex(r.content_hash) && r.entry_key === cacheKey(r.canonical_url, r.content_hash, r.contract_hash)) &&
      (r.etag === null || safeEtag(r.etag) === r.etag) && (r.last_modified === null || safeModified(r.last_modified) === r.last_modified) && time(r.revalidated_at);
  } catch { return false; }
}
export function validReceipt(r: PendingResult): boolean {
  return !!r && Object.keys(r).every(k => ['version', 'entry', 'representation'].includes(k)) && [1, 2].includes(r.version) && r.version === r.entry?.version && validEntry(r.entry) && validRepresentation(r.representation) &&
    r.representation.entry_key === r.entry.cache_key && r.representation.canonical_url === r.entry.canonical_url && r.representation.content_hash === r.entry.content_hash &&
    r.representation.contract_hash === r.entry.contract_hash && Buffer.byteLength(JSON.stringify(r), 'utf8') <= 48000;
}
export class ExtractionCache {
  constructor(readonly dir: string) {}
  private entryPath(key: string) { if (!hex(key)) throw fail(); return join(this.dir, 'extraction-cache', 'entries', `${key}.json`); }
  private indexPath(url: string, contract: string) { return join(this.dir, 'extraction-cache', 'urls', `${urlContractKey(url, contract)}.json`); }
  entry(key: string) {
    const e = read<CacheEntry>(this.entryPath(key));
    if (e && (!validEntry(e) || e.cache_key !== key)) throw fail();
    return e;
  }
  checkedEntry(key: string) { const e = this.entry(key); return e && e.version === 2 && isCheckedExtraction(e.result) ? e : null; }
  private index(url: string, contract: string): Representation | null {
    const r = read<Representation>(this.indexPath(url, contract));
    if (!r) return null;
    if (!validRepresentation(r) || r.canonical_url !== url || r.contract_hash !== contract) throw fail();
    return r;
  }
  prior(url: string, contract: string): { representation: Representation; entry: CacheEntry } | null {
    const r = this.index(url, contract);
    if (!r || !r.entry_key) return null;
    const e = this.checkedEntry(r.entry_key);
    return e ? { representation: r, entry: e } : null;
  }
  observe(r: Representation) {
    if (!validRepresentation(r)) throw fail();
    try { read<Representation>(this.indexPath(r.canonical_url, r.contract_hash)); this.prior(r.canonical_url, r.contract_hash); atomicState(this.indexPath(r.canonical_url, r.contract_hash), r); } catch { throw fail(); }
  }
  put(e: CacheEntry, fault?: (point: string) => void, faultPoint?: string) {
    if (!validEntry(e)) throw fail();
    try { this.entry(e.cache_key); atomicState(this.entryPath(e.cache_key), e, fault && faultPoint ? { hook: fault, point: faultPoint } : undefined); } catch { throw fail(); }
  }
  promote(r: PendingResult, fault?: (point: string) => void) {
    if (!validReceipt(r)) throw new Error('pending_result_unavailable');
    this.put(r.entry, fault, 'cache_entry_temp_written'); fault?.('cache_entry_written');
    this.observe(r.representation); fault?.('cache_index_published');
  }
  pending(limit: number) {
    try {
      const dir = safePath(join(this.dir, 'extraction-cache', 'entries'), true);
      let names: string[];
      try { names = readdirSync(dir).sort(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
      const all: CacheEntry[] = [];
      for (const name of names) {
        if (TEMP_NAME.test(name)) {
          // A SIGKILL during atomicState can strand an unreferenced temp file.
          // It was never a cache record, so remove it instead of failing closed.
          const p = safePath(join(dir, name));
          if (!lstatSync(p).isFile()) throw fail();
          rmSync(p, { force: true });
          continue;
        }
        if (!ENTRY_NAME.test(name)) throw fail();
        const e = this.entry(name.slice(0, -5));
        if (e) all.push(e);
      }
      const grouping = (e: CacheEntry) => `${e.canonical_url}\u0000${e.contract_hash}`;
      const newer = (a: CacheEntry, b: CacheEntry) => a.extracted_at > b.extracted_at || a.extracted_at === b.extracted_at && a.cache_key > b.cache_key;
      const latest = new Map<string, CacheEntry>();
      for (const e of all) {
        const prior = latest.get(grouping(e));
        if (!prior || newer(e, prior)) latest.set(grouping(e), e);
      }
      const current: CacheEntry[] = [];
      for (const e of all) {
        if (!e.pending_delivery || e.version !== 2) continue;
        // The URL index points at the latest observed representation. A pending
        // entry the index no longer references is superseded: retrying its
        // delivery is impossible, and leaving it pending pins the URL forever.
        // If the index is missing (crash before publication), a newer entry for
        // the same URL/contract is equally conclusive evidence of supersession.
        const index = this.index(e.canonical_url, e.contract_hash);
        const latestEntry = latest.get(grouping(e));
        const superseded = index ? index.entry_key !== e.cache_key : !!latestEntry && latestEntry.cache_key !== e.cache_key;
        if (superseded) { this.put({ ...e, pending_delivery: false }); continue; }
        current.push(e);
      }
      // Return at most one current representation per canonical URL.
      const selected = new Map<string, CacheEntry>();
      for (const e of current) {
        const prior = selected.get(e.canonical_url);
        if (!prior) { selected.set(e.canonical_url, e); continue; }
        const preferEntry = e.extracted_at > prior.extracted_at || e.extracted_at === prior.extracted_at && e.cache_key > prior.cache_key;
        const keep = preferEntry ? e : prior, drop = preferEntry ? prior : e;
        selected.set(e.canonical_url, keep);
        this.put({ ...drop, pending_delivery: false });
      }
      return [...selected.values()].slice(0, limit);
    } catch { throw fail(); }
  }
}
export function representation(url: string, contract: string, fetchUrl: string, at: string, entry: CacheEntry | null, etag?: string | null, modified?: string | null): Representation {
  const safeFetch = filterText(fetchUrl, 2048) === fetchUrl;
  return { version: 1, canonical_url: url, contract_hash: contract, representation: REQUEST_REPRESENTATION, fetch_url: safeFetch ? fetchUrl : url, entry_key: entry?.cache_key ?? null, content_hash: entry?.content_hash ?? null, etag: entry && safeFetch ? safeEtag(etag) : null, last_modified: entry && safeFetch ? safeModified(modified) : null, revalidated_at: at };
}
