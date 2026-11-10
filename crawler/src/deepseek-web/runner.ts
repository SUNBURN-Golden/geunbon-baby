import { pangpangIdentityAllowed, pangpangPost } from '../../lib/external/pangpang';
import { join } from 'node:path';
import { evaluateUrlDomainPolicy, assertDomainPolicyReadable } from './domain-policy';
import { createDeepSeekClient } from './client';
import { kstDate } from '../../lib/kst';
import { buildExtractionPrompt, SYSTEM_INSTRUCTIONS, validateExtraction, checkExtraction } from './extract';
import { createPublicFetcher, fetchPublicText } from './public-fetch';
import { buildParserProposal } from './proposals';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { modelProfile } from './config';
import { preparePage } from './page-content';
import { candidateDecision } from './candidate-filter';
import { ExtractionCache, contractHash, cacheKey, representation, type CacheEntry } from './extraction-cache';
import { deliverCached } from './cache-delivery';
import type { ConditionalRequest } from '../../lib/external/fetch';
import { countPending } from './review-queue';
import { cycleAdmit } from './budget-cycle';
import { cycleLifecycle, waitFor, type CycleContext } from './lifecycle';
import type { WriterOwnership } from './writer-ownership';
import type { DeepSeekWebConfig } from './types';
import { logOutcome } from './outcomes';
import { isPangpangHost, planPangpangPage } from './source-select';
import { pickNextPublicSearchUrl, rememberSearchHints } from './search-query-plan';
import { isPangpangListingUrl, listingDiscoveryDue, recordListingDiscovery, shouldDedupObservedSeed } from './listing-discovery';
import { loadGeunbonCatalog, postIdFromUrl, searchMetaForUrl } from './catalog';
import type { CollectionReport, CollectionStatus, ScopedCategory, TickCoverage } from './types';
import type { CollectorStore } from '../store';

export type FetchPageResult = { ok: true; text: string; finalUrl: string; status?: number; etag?: string | null; last_modified?: string | null } | { ok: false; reason: string };
export type RunnerOptions = {
  mode: 'once' | 'dry_run' | 'daemon_tick';
  urls?: string[];
  stateDir?: string;
  store?: CollectorStore;
  client?: ReturnType<typeof createDeepSeekClient>;
  fetchImpl?: typeof fetch;
  fetchPage?: (url: string, conditional?: ConditionalRequest) => Promise<FetchPageResult>;
  now?: () => number;
  signal?: AbortSignal;
  fault?: (point: string) => void;
  ownership?: WriterOwnership;
  loadConfig?: () => DeepSeekWebConfig;
};

function mergePending(memory: { pending_urls: string[] }, urls: string[]) {
  const seen = new Set(memory.pending_urls);
  for (const url of urls) {
    if (!seen.has(url)) {
      memory.pending_urls.push(url);
      seen.add(url);
    }
  }
}

function resolveCollectionStatus(input: {
  queueLen: number;
  haltReason: string | null;
  extractions: number;
  listingEnqueued: number;
  listingNoCandidates: number;
  dedupSkips: number;
  policyBlocked: number;
}): CollectionStatus {
  if (input.haltReason === 'budget_tokens' || input.haltReason === 'budget_requests') return 'budget_saturated';
  if (input.extractions > 0 || input.listingEnqueued > 0) return 'active';
  if (input.listingNoCandidates > 0) return 'listing_no_candidates';
  if (input.dedupSkips > 0 && input.policyBlocked === 0) return 'idle_dedup';
  if (input.policyBlocked > 0) return 'blocked';
  if (!input.queueLen) return 'idle';
  return 'active';
}

export async function runDeepSeekWeb(options: RunnerOptions): Promise<CollectionReport> {
  return cycleLifecycle(options, ctx => executeCycle(options, ctx));
}
async function executeCycle(options: RunnerOptions, ctx: CycleContext): Promise<void> {
  const { config, dir, memory, report } = ctx;
  const runId = report.run_id, cycleId = report.cycle_id;
  options = { ...options, store: ctx.store };
  const nowMs = options.now ?? Date.now;
  const fetchImpl: typeof fetch = (url, init) => (options.fetchImpl ?? fetch)(url, { ...init, signal: options.signal ? AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal });
  const fetcher = createPublicFetcher(config, { fetch: fetchImpl, sleep: async ms => { await waitFor(ms, options.signal); options.signal?.throwIfAborted(); } });
  const queue: string[] = [...memory.pending_urls];
  const explicit = options.urls?.length ? [...options.urls] : [];
  if (explicit.length) queue.push(...explicit);
  else if (!memory.pending_urls.length) {
    queue.push(...config.seed_urls);
    if (options.mode === 'once' || options.mode === 'daemon_tick') {
      const planned = pickNextPublicSearchUrl(memory, config);
      if (planned && !queue.includes(planned)) queue.push(planned);
      for (const url of memory.observed_urls) {
        if (isPangpangListingUrl(url) && listingDiscoveryDue(memory, url, config, nowMs()) && !queue.includes(url)) {
          queue.push(url);
        }
      }
    }
  }
  if (!queue.length && options.mode === 'dry_run') {
    queue.push('https://fixture.example/deepseek-web-sample');
  }
  const cache = new ExtractionCache(dir);
  const contract = contractHash(config, loadGeunbonCatalog(), modelProfile(config));
  let haltReason: string | null = null;
  let extractions = report.extractions;
  let proposals = report.proposals;
  let blocked = 0;
  let listingEnqueued = 0;
  let listingRefreshAttempts = 0;
  let listingNoCandidates = 0;
  let dedupSkips = 0;
  let policyBlocked = 0;
  const coverage: TickCoverage = { searches: [], listing: {}, extracted: {} };
  const catalog = loadGeunbonCatalog();
  memory.plan_notes.push(`${runId}: plan ${queue.length} url(s), mode=${options.mode}`);
  const cycleTouched = new Set<string>();
  const progress = async () => {
    Object.assign(report, { extractions, items_sent_to_review: extractions, proposals, blocked, listing_enqueued: listingEnqueued, listing_refresh_attempts: listingRefreshAttempts, dedup_skips: dedupSkips, coverage });
    await ctx.checkpoint();
  };
  try {
    {
      for (const rawSeed of queue.slice(0, config.memory.max_queue_urls)) {
        let seedUrl: string;
        try { seedUrl = canonicalUrl(rawSeed); } catch { blocked++; policyBlocked++; continue; }
        options.signal?.throwIfAborted();
        if (shouldDedupObservedSeed(memory, seedUrl, config, nowMs())) {
          dedupSkips++;
          memory.plan_notes.push(`dedup_observed_seed ${seedUrl}`);
          await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: seedUrl, outcome: 'duplicate_skip', detail: { reason: 'dedup_observed_seed' } });
          continue;
        }
        if (cycleTouched.has(seedUrl)) {
          dedupSkips++;
          await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: seedUrl, outcome: 'duplicate_skip', detail: { within_cycle: true } });
          continue;
        }
        cycleTouched.add(seedUrl);
        let pageUrl = seedUrl;
        if (isPangpangListingUrl(seedUrl)) {
          const meta = memory.last_catalog_search?.url === seedUrl
            ? memory.last_catalog_search
            : searchMetaForUrl(catalog, seedUrl);
          coverage.searches.push({
            url: seedUrl,
            catalog_product_id: meta.product_id,
            category: meta.category,
            term: meta.term,
          });
        }
        const initialPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
        if (initialPolicy.blocked) {
          blocked++;
          policyBlocked++;
          memory.plan_notes.push(`block ${pageUrl}: ${initialPolicy.reason}`);
          haltReason = haltReason ?? initialPolicy.reason;
          await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'fetch_blocked', detail: { stage: 'policy', reason: initialPolicy.reason } });
          continue;
        }
        const host = new URL(pageUrl).hostname;
        const listingRefresh = isPangpangListingUrl(seedUrl) && listingDiscoveryDue(memory, seedUrl, config, nowMs());
        let text = '';
        let fetched = false;
        let reused: CacheEntry | null = null;
        let fetchUrl = pageUrl;
        let etag: string | null | undefined, modified: string | null | undefined;
        try {
          if (host === 'fixture.example' && !options.fetchPage) {
            const { readFile } = await import('node:fs/promises');
            text = await readFile(join(process.cwd(), 'tests/fixtures/deepseek-web/sample-page.txt'), 'utf8');
            pageUrl = seedUrl;
            fetched = true;
          } else if (options.mode === 'dry_run' && !options.fetchPage) {
            if (listingRefresh) {
              blocked++;
              memory.plan_notes.push(`skip_live_fetch ${pageUrl}: dry_run_listing`);
              continue;
            }
            blocked++;
            memory.plan_notes.push(`skip_live_fetch ${pageUrl}: dry_run`);
            continue;
          } else {
            if (listingRefresh) listingRefreshAttempts++;
            const prior = cache.prior(pageUrl, contract);
            const conditional = prior && prior.representation.fetch_url === pageUrl && (prior.representation.etag || prior.representation.last_modified) ? { fetch_url: prior.representation.fetch_url, etag: prior.representation.etag, last_modified: prior.representation.last_modified } : undefined;
            const checkPolicy = (url: string) => {
              if (pangpangPost(seedUrl) && new URL(url).pathname !== '/robots.txt' && !pangpangIdentityAllowed(seedUrl, url)) throw new Error('source_response_invalid');
              if (options.store) assertDomainPolicyReadable(options.store);
              const policy = evaluateUrlDomainPolicy(options.store, url, config);
              if (policy.blocked) throw new Error(policy.reason!);
            };
            const getPage = (condition?: ConditionalRequest) => {
              checkPolicy(pageUrl);
              return options.fetchPage ? options.fetchPage(pageUrl, condition) : fetchPublicText(fetcher, pageUrl, condition, checkPolicy);
            };
            let page = await getPage(conditional);
            if (page.ok && page.status === 304) {
              if (prior && conditional && page.finalUrl === prior.representation.fetch_url && canonicalUrl(page.finalUrl) === pageUrl) reused = prior.entry;
              else {
                page = await getPage(); // Exactly one unconditional fallback.
                if (page.ok && page.status === 304) throw new Error('source_response_invalid');
              }
            }
            if (!page.ok) {
              blocked++;
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'fetch_blocked', detail: { reason: page.reason } });
              continue;
            }
            if (page.status !== undefined && page.status !== 200 && page.status !== 304) throw new Error('source_response_invalid');
            text = page.text;
            if (pangpangPost(seedUrl) && !pangpangIdentityAllowed(seedUrl, page.finalUrl)) throw new Error('source_response_invalid');
            fetchUrl = page.finalUrl;
            pageUrl = canonicalUrl(page.finalUrl);
            etag = page.etag; modified = page.last_modified;
            if (cycleTouched.has(pageUrl) && pageUrl !== seedUrl) { dedupSkips++; continue; }
            cycleTouched.add(pageUrl);
            if (!reused) cache.observe(representation(pageUrl, contract, fetchUrl, new Date(nowMs()).toISOString(), null));
            fetched = true;
            const redirectPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
            if (redirectPolicy.blocked) {
              blocked++;
              policyBlocked++;
              memory.plan_notes.push(`block_redirect ${pageUrl}: ${redirectPolicy.reason}`);
              haltReason = haltReason ?? redirectPolicy.reason;
              continue;
            }
          }
          if (isPangpangHost(host) && text) {
            let plan: ReturnType<typeof planPangpangPage>;
            try { plan = planPangpangPage(text, pageUrl, new Date(nowMs()), config); }
            catch {
              report.candidate_pages_rejected!++;
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'candidate_rejected', detail: { reason: 'candidate_preparation_limit' } });
              continue;
            }
            if (plan.kind === 'listing') {
              report.candidate_pages_rejected!++;
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'candidate_rejected', detail: { reason: 'candidate_listing' } });
              rememberSearchHints(memory, plan.suggested_searches);
              const enqueueCount = plan.enqueue.length;
              recordListingDiscovery(memory, seedUrl, config, enqueueCount, new Date(nowMs()));
              for (const row of plan.enqueue_catalog) {
                memory.pending_catalog_meta[row.url] = { catalog_product_id: row.catalog_product_id, category: row.category };
              }
              for (const [cat, n] of Object.entries(plan.scoped_by_category)) {
                const key = cat as ScopedCategory;
                const prev = coverage.listing[key] ?? { raw: 0, scoped: 0, enqueued: 0 };
                coverage.listing[key] = {
                  raw: Math.max(prev.raw, plan.raw_product_count),
                  scoped: (prev.scoped ?? 0) + n,
                  enqueued: (prev.enqueued ?? 0) + plan.enqueue_catalog.filter(e => e.category === key).length,
                };
              }
              if (!Object.keys(plan.scoped_by_category).length && plan.raw_product_count) {
                coverage.listing.unscoped = {
                  raw: plan.raw_product_count,
                  scoped: plan.scope_counts.core,
                  enqueued: enqueueCount,
                };
              }
              if (enqueueCount) {
                mergePending(memory, plan.enqueue);
                listingEnqueued += enqueueCount;
                await logOutcome(dir, {
                  run_id: runId,
                  cycle_id: cycleId,
                  url: pageUrl,
                  outcome: 'listing_enqueued',
                  detail: {
                    enqueue: plan.enqueue,
                    raw_product_count: plan.raw_product_count,
                    scoped_candidate_count: plan.scoped_candidate_count,
                    scope_counts: plan.scope_counts,
                    migration_refresh: listingRefresh,
                  },
                });
              } else if (plan.zero_reason === 'parser_empty') {
                listingNoCandidates++;
                await logOutcome(dir, {
                  run_id: runId,
                  cycle_id: cycleId,
                  url: pageUrl,
                  outcome: 'listing_parser_empty',
                  detail: { parser_outcome_counts: plan.parser_outcome_counts, migration_refresh: listingRefresh },
                });
              } else {
                listingNoCandidates++;
                await logOutcome(dir, {
                  run_id: runId,
                  cycle_id: cycleId,
                  url: pageUrl,
                  outcome: 'listing_scope_no_core',
                  detail: {
                    raw_product_count: plan.raw_product_count,
                    scope_counts: plan.scope_counts,
                    suggested_searches: plan.suggested_searches,
                    migration_refresh: listingRefresh,
                  },
                });
              }
              if (!memory.observed_urls.includes(seedUrl)) memory.observed_urls.push(seedUrl);
              memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
              cycleTouched.add(seedUrl);
              continue;
            }
          }
          if (!fetched) continue;
          const at = new Date(nowMs()).toISOString();
          const prepared = reused ? null : preparePage(text, pageUrl);
          const decision = reused ? reused.candidate : candidateDecision(prepared!, catalog, config);
          if (prepared?.truncated) await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'preparation_truncated' });
          if (!decision.accepted) {
            report.candidate_pages_rejected!++;
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'candidate_rejected', detail: { reason: decision.code } });
            memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
            continue;
          }
          report.candidate_pages_accepted!++;
          const key = reused?.cache_key ?? cacheKey(pageUrl, prepared!.content_hash, contract);
          let entry = reused ?? cache.checkedEntry(key);
          if (entry) report.extraction_cache_hits!++;
          else report.extraction_cache_misses!++;
          try {
            if (options.store) assertDomainPolicyReadable(options.store);
            const preModelPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
            if (preModelPolicy.blocked) {
              blocked++;
              policyBlocked++;
              memory.plan_notes.push(`block_pre_model ${pageUrl}: ${preModelPolicy.reason}`);
              haltReason = haltReason ?? preModelPolicy.reason;
              continue;
            }
            let unknownUsage = false;
            if (!entry) {
              const admission = cycleAdmit(memory, config);
              if (!admission.ok) {
                haltReason = admission.reason;
                mergePending(memory, [pageUrl]);
                continue; // Discovery and cached results still progress within the bounded queue.
              }
              mergePending(memory, [pageUrl]);
              await progress();
              const completion = await ctx.complete({ system: SYSTEM_INSTRUCTIONS, user: buildExtractionPrompt(prepared!) }, admission.reserve, result => {
                const raw = validateExtraction(result.content, pageUrl, kstDate(at), result.finish_reason);
                const extraction = checkExtraction(raw, prepared!, at);
                extraction.catalog_product_id = decision.match!.product_id;
                const offerRef = postIdFromUrl(pageUrl);
                if (offerRef) extraction.offer_ref = offerRef;
                entry = { version: 2, cache_key: key, canonical_url: pageUrl, content_hash: prepared!.content_hash, contract_hash: contract,
                  candidate: decision, result: extraction, extracted_at: at, proposal: buildParserProposal(pageUrl, prepared!.text, extraction, at), pending_delivery: true };
                return { version: 2, entry, representation: representation(pageUrl, contract, fetchUrl, at, entry, etag, modified) };
              });
              unknownUsage = completion.usage.total_tokens === null;
              if (entry!.result.in_scope) report.items_extracted++;
              cache.promote(memory.pending_result!, options.fault);
              memory.pending_result = null;
              await ctx.checkpoint();
              options.fault?.('receipt_cleared');
            } else {
              cache.observe(representation(pageUrl, contract, fetchUrl, at, entry, etag ?? (reused ? cache.prior(pageUrl, contract)?.representation.etag : null), modified ?? (reused ? cache.prior(pageUrl, contract)?.representation.last_modified : null)));
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'extraction_cache_hit' });
            }
            const delivered = await deliverCached(cache, entry!, config, options.store, at, options.fault);
            if (delivered.review) {
              extractions++;
              const cat = entry!.result.category;
              if (cat !== '정보 없음') coverage.extracted[cat] = (coverage.extracted[cat] ?? 0) + 1;
            }
            if (delivered.proposal) proposals++;
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: entry!.result.in_scope ? 'extracted' : 'out_of_scope' });
            memory.observed_urls = [...new Set([...memory.observed_urls, pageUrl])];
            if (!delivered.deferred) memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl && u !== pageUrl);
            else mergePending(memory, [pageUrl]);
            await progress();
            if (unknownUsage) { haltReason = 'usage_unknown'; break; }
          } catch (error) {
            await logOutcome(dir, {
              run_id: runId,
              cycle_id: cycleId,
              url: pageUrl,
              outcome: 'model_failed',
              detail: { reason: 'model_failed' },
            });
            throw error;
          }
        } catch (error) {
          if (error instanceof Error && ['domain_stopped', 'prohibited_domain', 'unsafe_url'].includes(error.message)) {
            blocked++; policyBlocked++; haltReason = haltReason ?? error.message;
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: seedUrl, outcome: 'fetch_blocked', detail: { reason: error.message } });
            continue;
          }
          throw error;
        }
      }
    }
    const collectionStatus = resolveCollectionStatus({
      queueLen: queue.length,
      haltReason,
      extractions,
      listingEnqueued,
      listingNoCandidates,
      dedupSkips,
      policyBlocked,
    });
    if (collectionStatus === 'idle_dedup' && !haltReason) haltReason = 'dedup_observed_seed';
    memory.last_run_id = runId;
    memory.last_collection_status = collectionStatus;
    memory.output_counts = { extractions, proposals, blocked, review_pending: await countPending(dir) };
    Object.assign(report, { collection_status: collectionStatus, halt_reason: haltReason, reason: haltReason, review_pending: memory.output_counts.review_pending });
  } finally {
    await progress();
  }
}
