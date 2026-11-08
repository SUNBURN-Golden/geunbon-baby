import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDeepSeekWebConfig, stateDir } from './config';
import { evaluateUrlDomainPolicy, assertDomainPolicyReadable, isGlobalEmergencyStop } from './domain-policy';
import { createDeepSeekClient } from './client';
import { buildExtractionPrompt, normalizeExtraction, parseModelJson } from './extract';
import { createPublicFetcher, fetchPublicText } from './public-fetch';
import { loadMemory, newRunId, saveMemory } from './memory';
import { maybeProposeParserFix } from './proposals';
import { enqueueReview, countPending } from './review-queue';
import { writeHeartbeat } from './heartbeat';
import { beginCycle, cycleAdmit, cycleHold, cycleRelease, cycleSettle, finalizeCycle } from './budget-cycle';
import { logOutcome } from './outcomes';
import { isPangpangHost, planPangpangPage } from './source-select';
import { isPangpangListingUrl, listingDiscoveryDue, recordListingDiscovery, shouldDedupObservedSeed } from './listing-discovery';
import type { CollectionStatus, RunReport } from './types';
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

export async function runDeepSeekWeb(options: RunnerOptions): Promise<RunReport> {
  const config = loadDeepSeekWebConfig();
  const dir = options.stateDir ?? stateDir();
  const runId = newRunId();
  const cycleId = runId;
  const nowMs = options.now ?? (() => Date.now());
  let memory = beginCycle(await loadMemory(dir), cycleId);
  const model = process.env.DEEPSEEK_MODEL ?? config.model.default_model;
  if (options.mode === 'once' || options.mode === 'daemon_tick') {
    if (!options.store) throw new Error('collector_db_required');
    assertDomainPolicyReadable(options.store);
    if (isGlobalEmergencyStop(options.store)) throw new Error('emergency_stop');
  }
  const client = options.client ?? createDeepSeekClient({
    apiKey: options.mode === 'dry_run' ? 'mock' : (process.env.DEEPSEEK_API_KEY ?? ''),
    model,
    maxCompletionTokens: config.budget.max_completion_tokens,
    fetchImpl: options.fetchImpl,
    fixturePath: process.env.DEEPSEEK_WEB_FIXTURE,
  });
  const fetcher = createPublicFetcher(config, { fetch: options.fetchImpl });
  const queue: string[] = [...memory.pending_urls];
  const explicit = options.urls?.length ? [...options.urls] : [];
  if (explicit.length) queue.push(...explicit);
  else if (!memory.pending_urls.length) {
    queue.push(...config.seed_urls);
    for (const url of memory.observed_urls) {
      if (isPangpangListingUrl(url) && listingDiscoveryDue(memory, url, config, nowMs()) && !queue.includes(url)) {
        queue.push(url);
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
  memory.plan_notes.push(`${runId}: plan ${queue.length} url(s), mode=${options.mode}`);
  const cycleTouched = new Set<string>();
  if (reserve.ok) {
    for (const seedUrl of queue.slice(0, config.memory.max_queue_urls)) {
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
          const plan = planPangpangPage(text, pageUrl, new Date(nowMs()), config.selection.max_pangpang_detail_per_cycle);
          if (plan.kind === 'listing') {
            const enqueueCount = plan.enqueue.length;
            recordListingDiscovery(memory, seedUrl, config, enqueueCount, new Date(nowMs()));
            if (enqueueCount) {
              mergePending(memory, plan.enqueue);
              listingEnqueued += enqueueCount;
              await logOutcome(dir, {
                run_id: runId,
                cycle_id: cycleId,
                url: pageUrl,
                outcome: 'listing_enqueued',
                detail: { enqueue: plan.enqueue, premiumCandidates: plan.premiumCandidates, migration_refresh: listingRefresh },
              });
            } else {
              listingNoCandidates++;
              await logOutcome(dir, {
                run_id: runId,
                cycle_id: cycleId,
                url: pageUrl,
                outcome: 'listing_no_premium_targets',
                detail: { productCount: plan.productCount, migration_refresh: listingRefresh },
              });
            }
            if (!memory.observed_urls.includes(seedUrl)) memory.observed_urls.push(seedUrl);
            memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
            cycleTouched.add(seedUrl);
            continue;
          }
        }
        if (!fetched || !text) continue;
        const admission = cycleAdmit(memory, config);
        if (!admission.ok) {
          haltReason = admission.reason;
          memory.plan_notes.push(`halt: ${admission.reason}`);
          break;
        }
        cycleHold(memory, admission.reserve);
        let settled = false;
        try {
          if (options.store) assertDomainPolicyReadable(options.store);
          const preModelPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
          if (preModelPolicy.blocked) {
            blocked++;
            policyBlocked++;
            memory.plan_notes.push(`block_pre_model ${pageUrl}: ${preModelPolicy.reason}`);
            haltReason = haltReason ?? preModelPolicy.reason;
            cycleRelease(memory, admission.reserve);
            continue;
          }
          const checked = new Date(nowMs()).toISOString().slice(0, 10);
          const completion = await client.complete({
            system: '당신은 가격을 발명하지 않는 공개 웹 추출기다. JSON만 출력한다.',
            user: buildExtractionPrompt(text, pageUrl),
          });
          cycleSettle(memory, admission.reserve, completion.usage.total_tokens);
          settled = true;
          cycleTouched.add(seedUrl);
          const extraction = normalizeExtraction(parseModelJson(completion.content), pageUrl, checked);
          if (extraction.in_scope) {
            await enqueueReview(dir, extraction);
            extractions++;
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'extracted' });
          } else {
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'out_of_scope' });
          }
          const proposal = await maybeProposeParserFix(dir, pageUrl, text, extraction);
          if (proposal) proposals++;
          if (!memory.observed_urls.includes(seedUrl)) memory.observed_urls.push(seedUrl);
          memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
        } catch (error) {
          if (!settled) cycleRelease(memory, admission.reserve);
          await logOutcome(dir, {
            run_id: runId,
            cycle_id: cycleId,
            url: pageUrl,
            outcome: 'model_failed',
            detail: { message: error instanceof Error ? error.message : String(error) },
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
  const cycleTokenSpent = memory.cycle.token_spent;
  const cycleRequestsSpent = memory.cycle.requests_spent;
  const lifetimeTokenSpent = memory.lifetime.token_spent;
  const lifetimeCycles = memory.lifetime.cycles;
  await finalizeCycle(dir, memory, {
    run_id: runId,
    collection_status: collectionStatus,
    halt_reason: haltReason,
    listing_enqueued: listingEnqueued,
    listing_refresh_attempts: listingRefreshAttempts,
    dedup_skips: dedupSkips,
  });
  const heartbeatAt = new Date(nowMs()).toISOString();
  const report: RunReport = {
    run_id: runId,
    at: heartbeatAt,
    model,
    mode: options.mode,
    cycle_token_spent: cycleTokenSpent,
    cycle_requests_spent: cycleRequestsSpent,
    lifetime_token_spent: lifetimeTokenSpent + cycleTokenSpent,
    lifetime_cycles: lifetimeCycles + 1,
    token_spent: cycleTokenSpent,
    requests_spent: cycleRequestsSpent,
    extractions,
    proposals,
    blocked,
    review_pending: memory.output_counts.review_pending,
    listing_enqueued: listingEnqueued,
    listing_refresh_attempts: listingRefreshAttempts,
    dedup_skips: dedupSkips,
    collection_status: collectionStatus,
    halt_reason: haltReason,
    heartbeat_fresh: false,
    heartbeat_at: heartbeatAt,
    pid: process.pid,
  };
  const fresh = await writeHeartbeat(dir, report, config.memory.heartbeat_max_age_ms, nowMs());
  report.heartbeat_fresh = fresh;
  memory.last_heartbeat_at = heartbeatAt;
  await saveMemory(dir, memory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'validation-artifact.json'),
    `${JSON.stringify(
      {
        ...report,
        validated_at: new Date(nowMs()).toISOString(),
        profile: config.profile_id,
        heartbeat_stale_warning: 'heartbeat_fresh reflects write-time only; re-check age before treating as live health',
      },
      null,
      2,
    )}\n`,
  );
  return report;
}
