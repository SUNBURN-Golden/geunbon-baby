import { join } from 'node:path';
import { evaluateUrlDomainPolicy, assertDomainPolicyReadable } from './domain-policy';
import { createDeepSeekClient } from './client';
import { buildExtractionPrompt, normalizeExtractionWithCatalog, parseModelJson } from './extract';
import { createPublicFetcher, fetchPublicText } from './public-fetch';
import { maybeProposeParserFix } from './proposals';
import { enqueueReviewIfNew, countPending, hasPendingUrl } from './review-queue';
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

export type FetchPageResult = { ok: true; text: string; finalUrl: string } | { ok: false; reason: string };
export type RunnerOptions = {
  mode: 'once' | 'dry_run' | 'daemon_tick';
  urls?: string[];
  stateDir?: string;
  store?: CollectorStore;
  client?: ReturnType<typeof createDeepSeekClient>;
  fetchImpl?: typeof fetch;
  fetchPage?: (url: string) => Promise<FetchPageResult>;
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
  const reserve = cycleAdmit(memory, config);
  let haltReason: string | null = null;
  if (!reserve.ok && queue.length) {
    haltReason = reserve.reason;
    memory.plan_notes.push(`halt: ${reserve.reason}`);
    await logOutcome(dir, {
      run_id: runId,
      cycle_id: cycleId,
      url: queue[0],
      outcome: 'fetch_blocked',
      detail: { budget_gate: reserve.reason, note: 'no_cycle_spend' },
    });
  }
  let extractions = 0;
  let proposals = 0;
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
    if (reserve.ok) {
      for (const seedUrl of queue.slice(0, config.memory.max_queue_urls)) {
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
        try {
          if (host === 'fixture.example') {
            const { readFile } = await import('node:fs/promises');
            text = await readFile(join(process.cwd(), 'tests/fixtures/deepseek-web/sample-page.txt'), 'utf8');
            pageUrl = seedUrl;
            fetched = true;
          } else if (options.mode === 'dry_run') {
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
            const page = options.fetchPage ? await options.fetchPage(pageUrl) : await fetchPublicText(fetcher, pageUrl);
            if (!page.ok) {
              blocked++;
              memory.plan_notes.push(`fetch_block ${pageUrl}: ${page.reason}`);
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'fetch_blocked', detail: { stage: 'fetch', reason: page.reason } });
              continue;
            }
            text = page.text;
            pageUrl = page.finalUrl;
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
            const plan = planPangpangPage(text, pageUrl, new Date(nowMs()), config);
            if (plan.kind === 'listing') {
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
          if (!fetched || !text) continue;
          const modeledKey = pageUrl;
          if (memory.modeled_post_urls.includes(modeledKey) || (await hasPendingUrl(dir, modeledKey))) {
            dedupSkips++;
            memory.plan_notes.push(`skip_modeled_post ${modeledKey}`);
            memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'duplicate_skip', detail: { reason: 'already_modeled_or_pending' } });
            continue;
          }
          const admission = cycleAdmit(memory, config);
          if (!admission.ok) {
            haltReason = admission.reason;
            memory.plan_notes.push(`halt: ${admission.reason}`);
            break;
          }
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
            const checked = new Date(nowMs()).toISOString().slice(0, 10);
            await progress();
            const completion = await ctx.complete({
              system: '당신은 가격을 발명하지 않는 공개 웹 추출기다. JSON만 출력한다.',
              user: buildExtractionPrompt(text, pageUrl),
            }, admission.reserve);
            cycleTouched.add(seedUrl);
            const catalogHint = memory.pending_catalog_meta[seedUrl] ?? memory.pending_catalog_meta[pageUrl];
            const offerRef = postIdFromUrl(pageUrl) ?? undefined;
            const extraction = normalizeExtractionWithCatalog(parseModelJson(completion.content), pageUrl, checked, {
              ...catalogHint,
              offer_ref: offerRef,
            });
            if (!memory.modeled_post_urls.includes(modeledKey)) {
              memory.modeled_post_urls = [...memory.modeled_post_urls, modeledKey].slice(-500);
            }
            if (extraction.in_scope) {
              report.items_extracted++;
              await progress();
              const q = await enqueueReviewIfNew(dir, extraction);
              if (q.enqueued) {
                extractions++;
                await progress();
                const cat = (extraction.category !== '정보 없음' ? extraction.category : catalogHint?.category) as ScopedCategory | undefined;
                if (cat) {
                  coverage.extracted[cat] = (coverage.extracted[cat] ?? 0) + 1;
                }
                await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'extracted', detail: { catalog_product_id: extraction.catalog_product_id } });
              } else {
                dedupSkips++;
                await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'duplicate_skip', detail: { reason: q.reason } });
              }
            } else {
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'out_of_scope' });
            }
            const proposal = await maybeProposeParserFix(dir, pageUrl, text, extraction);
            if (proposal) proposals++;
            if (!memory.observed_urls.includes(seedUrl)) memory.observed_urls.push(seedUrl);
            memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
            await progress();
            if (completion.usage.total_tokens === null) { haltReason = 'usage_unknown'; break; }
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
          if (error instanceof Error && error.message === 'model_should_not_run') throw error;
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
