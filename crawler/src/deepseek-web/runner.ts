import { pangpangIdentityAllowed, pangpangPost } from '../../lib/external/pangpang';
import { join } from 'node:path';
import { evaluateUrlDomainPolicy, assertDomainPolicyReadable } from './domain-policy';
import { createDeepSeekClient } from './client';
import { kstDate } from '../../lib/kst';
import { buildExtractionPrompt, SYSTEM_INSTRUCTIONS, validateExtraction, checkExtraction } from './extract';
import { createPublicFetcher, fetchPublicText, type FetchPageResult } from './public-fetch';
import { buildParserProposal } from './proposals';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { digest } from '../../engine/util';
import { modelProfile } from './config';
import { preparePage } from './page-content';
import { candidateDecision } from './candidate-filter';
import { ExtractionCache, contractHash, cacheKey, representation, type CacheEntry } from './extraction-cache';
import { deliverCached } from './cache-delivery';
import type { ConditionalRequest, FetchFailure, RequestStage } from '../../lib/external/fetch';
import { countPending } from './review-queue';
import { cycleAdmit } from './budget-cycle';
import { cycleLifecycle, waitFor, type CycleContext } from './lifecycle';
import type { WriterOwnership } from './writer-ownership';
import type { DeepSeekWebConfig, OfficialSourceConfig, OfficialVisitOutcome, RunMemory, ScopedCategory } from './types';
import { fetchFailureDetail, logOutcome } from './outcomes';
import { fetchEligible, isGoneUrl } from './memory';
import { isPangpangHost, planPangpangPage } from './source-select';
import { rememberSearchHints } from './search-query-plan';
import { isPangpangListingUrl, listingDiscoveryDue, recordListingDiscovery, shouldDedupObservedSeed } from './listing-discovery';
import { catalogSearchUrls, loadGeunbonCatalog, postIdFromUrl, searchMetaForUrl } from './catalog';
import { enabledOfficialSources, effectiveRecheckMs, officialDue, admitOfficial, officialLegacySources } from './official-sources';
import { normalizeRotationForDigest, planRotation, type LegacyItem, type OfficialCandidate, type PendingItem, type SearchRow, type WorkItem } from './rotation';
import { SourceRegistryStore } from '../source-registry/store';
import { loadRegistrySeed } from '../source-registry/seed';
import type { CollectionReport, CollectionStatus, TickCoverage } from './types';
import type { CollectorStore } from '../store';

export type { FetchPageResult } from './public-fetch';
export type RunnerOptions = {
  mode: 'once' | 'dry_run' | 'daemon_tick';
  urls?: string[];
  stateDir?: string;
  store?: CollectorStore;
  registry?: SourceRegistryStore;
  client?: ReturnType<typeof createDeepSeekClient>;
  fetchImpl?: typeof fetch;
  fetchPage?: (url: string, conditional?: ConditionalRequest) => Promise<FetchPageResult>;
  now?: () => number;
  signal?: AbortSignal;
  fault?: (point: string) => void;
  ownership?: WriterOwnership;
  loadConfig?: () => DeepSeekWebConfig;
};

class OfficialRegistryBlocked extends Error {
  constructor(readonly stage: 'initial' | 'redirect', readonly reason: string) {
    super('official_registry_blocked');
  }
}

class OfficialDomainBlocked extends Error {
  constructor(readonly policyReason: string) {
    super('official_domain_blocked');
  }
}

function mergePending(memory: { pending_urls: string[] }, urls: string[]) {
  const seen = new Set(memory.pending_urls);
  for (const url of urls) {
    if (!seen.has(url)) {
      memory.pending_urls.push(url);
      seen.add(url);
    }
  }
}

/** Remove a URL from the bounded pending queue and its category metadata together. */
function forgetPending(memory: RunMemory, url: string) {
  memory.pending_urls = memory.pending_urls.filter(u => u !== url);
  delete memory.pending_catalog_meta[url];
}

function categoryPolicyDigest(config: DeepSeekWebConfig): string {
  return digest({
    policy_version: 1,
    categories: config.scope_categories.map(category => category.id),
    category_quota_per_cycle: config.selection.category_quota_per_cycle,
    legacy_budget_per_cycle: config.selection.legacy_budget_per_cycle,
    max_pages_per_cycle: config.selection.max_pages_per_cycle,
  });
}

/** Registry URL identity is unescaped; fetch URLs keep the original spelling. */
function registryCheckUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${decodeURI(url.pathname)}${url.search}`;
  } catch {
    return raw;
  }
}

function emptyOfficialCoverage() {
  return { due: 0, attempted: 0, fetched: 0, registry_denied: 0, domain_blocked: 0, robots_blocked: 0, redirect_blocked: 0, fetch_failed: 0 };
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
  const fetcher = createPublicFetcher(config, { fetch: options.fetchImpl, now: nowMs, sleep: ms => waitFor(ms, options.signal) });
  const explicit = options.urls?.length ? [...options.urls] : [];
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
  const coverage: TickCoverage = {
    searches: [], listing: {}, extracted: {}, official: {},
    rotation: { cursor_before: memory.rotation.category_cursor, cursor_after: memory.rotation.category_cursor, scheduled: [], served: [], planned_pages: 0, skipped_pending: 0 },
  };
  const catalog = loadGeunbonCatalog();
  const categories = config.scope_categories.map(category => category.id);
  const enabledOfficial = enabledOfficialSources(config);
  let registry = options.registry;
  if (!registry && options.store && enabledOfficial.length) {
    registry = new SourceRegistryStore(
      options.store,
      [...options.store.settings.sources, ...officialLegacySources(config, loadRegistrySeed())],
    );
  }
  const sourcesById = new Map(enabledOfficial.map(source => [source.id, source]));
  const cycleTouched = new Set<string>();

  const recordOfficialVisit = (source: OfficialSourceConfig, outcome: OfficialVisitOutcome, reason: string | null, at: number, retryAfter?: string) => {
    const recheck = outcome === 'fetched' ? effectiveRecheckMs(source, config) : Math.min(effectiveRecheckMs(source, config), 900000);
    let canonical = source.url;
    try { canonical = canonicalUrl(source.url); } catch { /* keep the raw fetch URL as identity fallback */ }
    memory.rotation.official_visits[source.id] = {
      source_id: source.id,
      url: source.url,
      canonical_url: canonical,
      last_at: new Date(at).toISOString(),
      next_due_at: retryAfter ?? new Date(at + recheck).toISOString(),
      outcome,
      reason,
    };
  };

  const isGone = (url: string) => isGoneUrl(memory, url);
  const recordFetchFailure = (url: string, failure: FetchFailure) => {
    const detail = fetchFailureDetail(failure);
    if (detail.reason === 'http_gone') {
      const gone = (canonical: string) => {
        memory.gone_urls[canonical] = detail.status;
        forgetPending(memory, canonical);
      };
      const requestedUrl = canonicalUrl(url);
      gone(requestedUrl);
      // A same-origin redirect can identify both the dead page and its alias.
      let respondingUrl: string | undefined;
      try { respondingUrl = canonicalUrl(failure.url); } catch { /* Do not retain an unsafe redirect URL. */ }
      if (respondingUrl && respondingUrl !== requestedUrl) gone(respondingUrl);
    } else if (failure.kind === 'http' && failure.retryAt !== null) {
      memory.fetch_retry_after[failure.hostname] = failure.retryAt;
    }
    return detail;
  };

  // Build this cycle's bounded work list.
  const planAt = nowMs();
  const eligibleAtPlan = (url: string) => fetchEligible(memory, url, planAt);
  const eligiblePending = memory.pending_urls.filter(eligibleAtPlan);
  const pendingUrls = new Set(memory.pending_urls);
  const rotationBefore = memory.rotation.category_cursor;
  let workItems: WorkItem[] = [];
  let scheduled: ScopedCategory[] = [];
  let served: ScopedCategory[] = [];
  if (explicit.length) {
    // Operator diagnostics bypass rotation entirely and never advance cursors.
    workItems = explicit.filter(eligibleAtPlan).map(url => ({ kind: 'explicit', tier: -1, url } as WorkItem));
    for (const url of eligiblePending) {
      if (!explicit.includes(url)) workItems.push({ kind: 'legacy', tier: 4, url, operation: memory.observed_urls.includes(url) ? 'recheck' : 'discovery' });
    }
  } else if (options.mode === 'dry_run') {
    // Fixture/seed dry runs never plan or advance rotation state.
    const urls = memory.pending_urls.length ? [...memory.pending_urls] : config.seed_urls.length ? [...config.seed_urls] : ['https://fixture.example/deepseek-web-sample'];
    workItems = urls.filter(eligibleAtPlan).map(url => ({ kind: 'legacy', tier: 4, url, operation: 'discovery' } as WorkItem));
  } else {
    const nextDigest = categoryPolicyDigest(config);
    memory.rotation = normalizeRotationForDigest(memory.rotation, nextDigest);
    const pending: PendingItem[] = [];
    const legacy: LegacyItem[] = [];
    const legacyUrls = new Set<string>();
    const scopedCategories = new Set(categories);
    for (const url of eligiblePending) {
      const meta = memory.pending_catalog_meta[url];
      const operation = memory.observed_urls.includes(url) ? 'recheck' as const : 'discovery' as const;
      // A removed scope category used to strand its queued details forever. Treat
      // orphaned metadata as legacy work so it is still drained (and its metadata
      // is cleared when the URL finally leaves the queue).
      if (meta && scopedCategories.has(meta.category)) pending.push({ url, category: meta.category, operation });
      else if (!legacyUrls.has(url)) { legacy.push({ url, operation }); legacyUrls.add(url); }
    }
    for (const url of config.seed_urls) {
      if (eligibleAtPlan(url) && !legacyUrls.has(url) && !pendingUrls.has(url)) { legacy.push({ url, operation: 'discovery' }); legacyUrls.add(url); }
    }
    for (const url of memory.observed_urls) {
      if (isPangpangListingUrl(url) && !pendingUrls.has(url) && !legacyUrls.has(url) && eligibleAtPlan(url) && listingDiscoveryDue(memory, url, config, planAt)) {
        legacy.push({ url, operation: 'discovery' });
        legacyUrls.add(url);
      }
    }

    const official: OfficialCandidate[] = [];
    if (enabledOfficial.length && !registry) {
      memory.plan_notes.push(`${runId}: official lane skipped: registry_unavailable`);
    } else if (registry) {
      for (const source of enabledOfficial) {
        if (!eligibleAtPlan(source.url) || !officialDue(memory.rotation, source, planAt)) continue;
        const cov = coverage.official[source.category] ??= emptyOfficialCoverage();
        cov.due++;
        const decision = admitOfficial(registry, source);
        if (!decision.allowed) {
          cov.registry_denied++;
          recordOfficialVisit(source, 'registry_denied', decision.reason, nowMs());
          await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: source.url, outcome: 'official_registry_denied', detail: { reason: decision.reason, registry_id: source.registry_id } });
          continue;
        }
        let canonical: string;
        try { canonical = canonicalUrl(source.url); } catch { continue; }
        official.push({ id: source.id, fetch_url: source.url, canonical_url: canonical, category: source.category, registry_id: source.registry_id, fields: source.fields });
      }
    }

    const searchRows: Partial<Record<ScopedCategory, SearchRow[]>> = {};
    for (const row of catalogSearchUrls(catalog)) {
      if (eligibleAtPlan(row.url)) (searchRows[row.category] ??= []).push(row);
    }
    const plan = planRotation({
      categories,
      categoryQuota: config.selection.category_quota_per_cycle,
      maxPages: config.selection.max_pages_per_cycle,
      legacyBudget: config.selection.legacy_budget_per_cycle,
      pending,
      legacy,
      official,
      searchRows: searchRows as Record<ScopedCategory, SearchRow[]>,
      pendingUrls,
      rotation: memory.rotation,
      categoryDigest: nextDigest,
    });
    memory.rotation = plan.rotation;
    workItems = plan.items;
    scheduled = plan.scheduled;
    served = plan.served;
  }
  workItems.sort((a, b) => a.tier - b.tier);
  const selectedUrls = new Set(workItems.map(item => item.url));
  coverage.rotation = {
    cursor_before: rotationBefore,
    cursor_after: memory.rotation.category_cursor,
    scheduled,
    served,
    planned_pages: workItems.length,
    skipped_pending: memory.pending_urls.filter(url => !selectedUrls.has(url)).length,
  };
  if (!explicit.length && options.mode !== 'dry_run') {
    memory.plan_notes.push(`${runId}: rotation ${rotationBefore}->${memory.rotation.category_cursor}, scheduled [${scheduled.join(',')}], pages ${workItems.length}, skipped_pending ${coverage.rotation.skipped_pending}`);
  }
  const maxQueue = Math.max(config.memory.max_queue_urls, explicit.length);
  memory.plan_notes.push(`${runId}: plan ${workItems.length} url(s), mode=${options.mode}`);

  const progress = async () => {
    Object.assign(report, { extractions, items_sent_to_review: extractions, proposals, blocked, listing_enqueued: listingEnqueued, listing_refresh_attempts: listingRefreshAttempts, dedup_skips: dedupSkips, coverage });
    await ctx.checkpoint();
  };

  const executeOfficial = async (item: Extract<WorkItem, { kind: 'official' }>) => {
    const source = sourcesById.get(item.source_id);
    if (!source || !registry) return;
    const cov = coverage.official[item.category] ??= emptyOfficialCoverage();
    cov.attempted++;
    options.signal?.throwIfAborted();
    let outcome: OfficialVisitOutcome;
    let reason: string | null = null;
    let failureDetail: ReturnType<typeof recordFetchFailure> | undefined;
    try {
      // Defense in depth: verify current authority immediately before fetching.
      const pre = evaluateUrlDomainPolicy(options.store, item.url, config);
      if (pre.blocked) throw new OfficialDomainBlocked(pre.reason!);
      const readmit = admitOfficial(registry, source);
      if (!readmit.allowed) throw new OfficialRegistryBlocked('initial', readmit.reason);
      const checkPolicy = (raw: string, stage: RequestStage) => {
        const policy = evaluateUrlDomainPolicy(options.store, raw, config);
        if (policy.blocked) throw new OfficialDomainBlocked(policy.reason!);
        if (stage === 'robots' || new URL(raw).pathname === '/robots.txt') return;
        const decision = registry!.decide(item.registry_id, registryCheckUrl(raw), item.fields);
        if (!decision.allowed) throw new OfficialRegistryBlocked(raw === item.url ? 'initial' : 'redirect', decision.reason);
      };
      const page = await fetchPublicText(fetcher, item.url, { beforeRequest: checkPolicy, signal: options.signal });
      if (!page.ok && page.failure) {
        outcome = 'fetch_failed';
        failureDetail = recordFetchFailure(item.url, page.failure);
        reason = failureDetail.reason;
      } else if (!page.ok) {
        const block = page.block;
        if (block?.reason === 'robots') { outcome = 'robots_blocked'; reason = 'robots'; }
        else if (block && ['cross_origin', 'scheme', 'hard_block', 'denylist'].includes(block.reason)) { outcome = 'redirect_blocked'; reason = block.reason; }
        else { outcome = 'fetch_failed'; reason = 'robots_or_policy'; }
      } else {
        const finalDecision = registry.decide(item.registry_id, registryCheckUrl(page.finalUrl), item.fields);
        if (!finalDecision.allowed) { outcome = 'redirect_blocked'; reason = finalDecision.reason; }
        else { outcome = 'fetched'; reason = null; }
      }
    } catch (error) {
      if (error instanceof OfficialRegistryBlocked) {
        outcome = error.stage === 'initial' ? 'registry_denied' : 'redirect_blocked';
        reason = error.reason;
      } else if (error instanceof OfficialDomainBlocked) {
        outcome = 'domain_blocked';
        reason = error.policyReason;
      } else throw error;
    }
    const at = nowMs();
    recordOfficialVisit(source, outcome, reason, at, failureDetail?.reason === 'http_host_backoff' ? failureDetail.retry_after : undefined);
    if (outcome === 'fetched') cov.fetched++;
    else if (outcome === 'registry_denied') cov.registry_denied++;
    else if (outcome === 'domain_blocked') cov.domain_blocked++;
    else if (outcome === 'robots_blocked') cov.robots_blocked++;
    else if (outcome === 'redirect_blocked') cov.redirect_blocked++;
    else cov.fetch_failed++;
    const outcomeKind = outcome === 'fetched' ? 'official_visit'
      : outcome === 'registry_denied' ? 'official_registry_denied'
      : outcome === 'domain_blocked' ? 'official_domain_blocked'
      : outcome === 'robots_blocked' ? 'official_robots_blocked'
      : outcome === 'redirect_blocked' ? 'official_redirect_blocked'
      : 'official_fetch_failed';
    await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: item.url, outcome: outcomeKind, detail: { category: item.category, source_id: item.source_id, reason, ...failureDetail } });
    await progress();
  };

  try {
    {
      for (const item of workItems.slice(0, maxQueue)) {
        options.signal?.throwIfAborted();
        if (!fetchEligible(memory, item.url, nowMs())) continue;
        if (item.kind === 'official') {
          await executeOfficial(item);
          continue;
        }
        const rawSeed = item.url;
        let seedUrl: string;
        try { seedUrl = canonicalUrl(rawSeed); } catch { blocked++; policyBlocked++; continue; }
        if (shouldDedupObservedSeed(memory, seedUrl, config, nowMs())) {
          dedupSkips++;
          forgetPending(memory, seedUrl);
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
        if (item.kind === 'search') {
          coverage.searches.push({ url: seedUrl, catalog_product_id: item.product_id, category: item.category, term: item.term });
        } else if (isPangpangListingUrl(seedUrl)) {
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
            const checkPolicy = (url: string, stage: RequestStage = 'page') => {
              if (stage === 'page' && pangpangPost(seedUrl) && new URL(url).pathname !== '/robots.txt' && !pangpangIdentityAllowed(seedUrl, url)) throw new Error('source_response_invalid');
              if (options.store) assertDomainPolicyReadable(options.store);
              const policy = evaluateUrlDomainPolicy(options.store, url, config);
              if (policy.blocked) throw new Error(policy.reason!);
            };
            const getPage = (condition?: ConditionalRequest) => {
              checkPolicy(pageUrl);
              return options.fetchPage ? options.fetchPage(pageUrl, condition) : fetchPublicText(fetcher, pageUrl, { conditional: condition, beforeRequest: checkPolicy, signal: options.signal });
            };
            let page = await getPage(conditional);
            if (page.ok && page.status === 304) {
              if (prior && conditional && page.finalUrl === prior.representation.fetch_url && canonicalUrl(page.finalUrl) === pageUrl) reused = prior.entry;
              else {
                page = await getPage(); // Exactly one unconditional fallback.
                if (page.ok && page.status === 304) throw new Error('source_response_invalid');
              }
            }
            if (!page.ok && page.failure) {
              const detail = recordFetchFailure(seedUrl, page.failure);
              await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: seedUrl, outcome: 'fetch_failed', detail });
              await progress();
              continue;
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
            try {
              plan = planPangpangPage(text, pageUrl, new Date(nowMs()), config, {
                categoryCursor: memory.rotation.category_cursor,
                categoryOrder: categories,
                isGone,
              });
            }
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
              forgetPending(memory, seedUrl);
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
            forgetPending(memory, seedUrl);
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
            if (!delivered.deferred) {
              forgetPending(memory, seedUrl);
              forgetPending(memory, pageUrl);
            } else mergePending(memory, [pageUrl]);
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
      queueLen: new Set([...memory.pending_urls, ...explicit.filter(url => !isGone(url))]).size,
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
