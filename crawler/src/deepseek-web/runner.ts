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
};

function shouldSkipDuplicate(memory: { pending_urls: string[]; observed_urls: string[] }, url: string) {
  return memory.pending_urls.length === 0 && memory.observed_urls.includes(url);
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

export async function runDeepSeekWeb(options: RunnerOptions): Promise<RunReport> {
  const config = loadDeepSeekWebConfig();
  const dir = options.stateDir ?? stateDir();
  const runId = newRunId();
  const cycleId = runId;
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
  const queue = [
    ...memory.pending_urls,
    ...(options.urls?.length ? options.urls : []),
    ...(options.urls?.length || memory.pending_urls.length ? [] : config.seed_urls),
  ];
  if (!queue.length && options.mode === 'dry_run') {
    queue.push('https://fixture.example/deepseek-web-sample');
  }
  const reserve = cycleAdmit(memory, config);
  let collectionStatus: CollectionStatus = queue.length ? 'active' : 'idle';
  let haltReason: string | null = null;
  if (!reserve.ok && queue.length) {
    collectionStatus = 'budget_saturated';
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
  memory.plan_notes.push(`${runId}: plan ${queue.length} url(s), mode=${options.mode}`);
  const cycleTouched = new Set<string>();
  if (reserve.ok) {
    for (const seedUrl of queue.slice(0, config.memory.max_queue_urls)) {
      if (shouldSkipDuplicate(memory, seedUrl)) {
        blocked++;
        memory.plan_notes.push(`duplicate_skip ${seedUrl}`);
        await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: seedUrl, outcome: 'duplicate_skip' });
        continue;
      }
      if (cycleTouched.has(seedUrl)) {
        blocked++;
        await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: seedUrl, outcome: 'duplicate_skip', detail: { within_cycle: true } });
        continue;
      }
      let pageUrl = seedUrl;
      const initialPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
      if (initialPolicy.blocked) {
        blocked++;
        memory.plan_notes.push(`block ${pageUrl}: ${initialPolicy.reason}`);
        await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'fetch_blocked', detail: { stage: 'policy', reason: initialPolicy.reason } });
        continue;
      }
      const host = new URL(pageUrl).hostname;
      const admission = cycleAdmit(memory, config);
      if (!admission.ok) {
        collectionStatus = 'budget_saturated';
        haltReason = admission.reason;
        memory.plan_notes.push(`halt: ${admission.reason}`);
        break;
      }
      cycleHold(memory, admission.reserve);
      let settled = false;
      try {
        let text = '';
        if (host === 'fixture.example') {
          const { readFile } = await import('node:fs/promises');
          text = await readFile(join(process.cwd(), 'tests/fixtures/deepseek-web/sample-page.txt'), 'utf8');
        } else if (options.mode === 'dry_run') {
          blocked++;
          memory.plan_notes.push(`skip_live_fetch ${pageUrl}: dry_run`);
          cycleRelease(memory, admission.reserve);
          continue;
        } else {
          const page = options.fetchPage ? await options.fetchPage(pageUrl) : await fetchPublicText(fetcher, pageUrl);
          if (!page.ok) {
            blocked++;
            memory.plan_notes.push(`fetch_block ${pageUrl}: ${page.reason}`);
            cycleRelease(memory, admission.reserve);
            await logOutcome(dir, { run_id: runId, cycle_id: cycleId, url: pageUrl, outcome: 'fetch_blocked', detail: { stage: 'fetch', reason: page.reason } });
            continue;
          }
          text = page.text;
          pageUrl = page.finalUrl;
          const redirectPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
          if (redirectPolicy.blocked) {
            blocked++;
            memory.plan_notes.push(`block_redirect ${pageUrl}: ${redirectPolicy.reason}`);
            cycleRelease(memory, admission.reserve);
            continue;
          }
        }
        if (isPangpangHost(host) && text) {
          const plan = planPangpangPage(text, pageUrl, new Date(), config.selection.max_pangpang_detail_per_cycle);
          if (plan.kind === 'listing') {
            if (plan.enqueue.length) {
              mergePending(memory, plan.enqueue);
              await logOutcome(dir, {
                run_id: runId,
                cycle_id: cycleId,
                url: pageUrl,
                outcome: 'listing_enqueued',
                detail: { enqueue: plan.enqueue, premiumCandidates: plan.premiumCandidates },
              });
            } else {
              await logOutcome(dir, {
                run_id: runId,
                cycle_id: cycleId,
                url: pageUrl,
                outcome: 'listing_no_premium_targets',
                detail: { productCount: plan.productCount },
              });
            }
            if (!memory.observed_urls.includes(seedUrl)) memory.observed_urls.push(seedUrl);
            memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
            cycleRelease(memory, admission.reserve);
            cycleTouched.add(seedUrl);
            continue;
          }
        }
        if (options.store) assertDomainPolicyReadable(options.store);
        const preModelPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
        if (preModelPolicy.blocked) {
          blocked++;
          memory.plan_notes.push(`block_pre_model ${pageUrl}: ${preModelPolicy.reason}`);
          cycleRelease(memory, admission.reserve);
          continue;
        }
        const checked = new Date().toISOString().slice(0, 10);
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
    }
  }
  if (collectionStatus === 'active' && blocked && extractions === 0 && !haltReason) {
    collectionStatus = blocked >= queue.length ? 'blocked' : 'active';
  }
  memory.last_run_id = runId;
  memory.last_collection_status = collectionStatus;
  memory.output_counts = { extractions, proposals, blocked, review_pending: await countPending(dir) };
  const cycleTokenSpent = memory.cycle.token_spent;
  const cycleRequestsSpent = memory.cycle.requests_spent;
  const lifetimeTokenSpent = memory.lifetime.token_spent;
  const lifetimeCycles = memory.lifetime.cycles;
  await finalizeCycle(dir, memory, { run_id: runId, collection_status: collectionStatus, halt_reason: haltReason });
  const heartbeatAt = new Date().toISOString();
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
    collection_status: collectionStatus,
    halt_reason: haltReason,
    heartbeat_fresh: false,
    heartbeat_at: heartbeatAt,
    pid: process.pid,
  };
  const fresh = await writeHeartbeat(dir, report, config.memory.heartbeat_max_age_ms);
  report.heartbeat_fresh = fresh;
  memory.last_heartbeat_at = heartbeatAt;
  await saveMemory(dir, memory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'validation-artifact.json'),
    `${JSON.stringify(
      {
        ...report,
        validated_at: new Date().toISOString(),
        profile: config.profile_id,
        heartbeat_stale_warning: 'heartbeat_fresh reflects write-time only; re-check age before treating as live health',
      },
      null,
      2,
    )}\n`,
  );
  return report;
}
