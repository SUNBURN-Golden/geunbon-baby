import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDeepSeekWebConfig, stateDir } from './config';
import { admitCall, holdCall, releaseCall, settleCall } from './guards';
import { assertDomainPolicyReadable, evaluateUrlDomainPolicy, isGlobalEmergencyStop } from './domain-policy';
import { createDeepSeekClient } from './client';
import { buildExtractionPrompt, normalizeExtraction, parseModelJson } from './extract';
import { createPublicFetcher, fetchPublicText } from './public-fetch';
import { loadMemory, newRunId, saveMemory } from './memory';
import { maybeProposeParserFix } from './proposals';
import { enqueueReview, countPending } from './review-queue';
import { writeHeartbeat } from './heartbeat';
import type { RunReport } from './types';
import type { CollectorStore } from '../store';
export type FetchPageResult = { ok: true; text: string; finalUrl: string } | { ok: false; reason: string };
export type RunnerOptions = {
  mode: 'once' | 'dry_run';
  urls?: string[];
  stateDir?: string;
  store?: CollectorStore;
  client?: ReturnType<typeof createDeepSeekClient>;
  fetchImpl?: typeof fetch;
  /** Test hook only: bypass PoliteFetcher when supplied. */
  fetchPage?: (url: string) => Promise<FetchPageResult>;
};
export async function runDeepSeekWeb(options: RunnerOptions): Promise<RunReport> {
  const config = loadDeepSeekWebConfig();
  const dir = options.stateDir ?? stateDir();
  const memory = await loadMemory(dir);
  const runId = newRunId();
  const model = process.env.DEEPSEEK_MODEL ?? config.model.default_model;
  if (options.mode === 'once') {
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
  const queue = [...(options.urls?.length ? options.urls : memory.pending_urls.length ? memory.pending_urls : config.seed_urls)];
  if (!queue.length && options.mode === 'dry_run') {
    queue.push('https://fixture.example/deepseek-web-sample');
  }
  let extractions = 0; let proposals = 0; let blocked = 0;
  memory.plan_notes.push(`${runId}: plan ${queue.length} url(s), mode=${options.mode}`);
  for (const seedUrl of queue.slice(0, config.memory.max_queue_urls)) {
    let pageUrl = seedUrl;
    const initialPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
    if (initialPolicy.blocked) {
      blocked++; memory.plan_notes.push(`block ${pageUrl}: ${initialPolicy.reason}`); continue;
    }
    const host = new URL(pageUrl).hostname;
    const admission = admitCall(memory, config);
    if (!admission.ok) { memory.plan_notes.push(`halt: ${admission.reason}`); break; }
    holdCall(memory, admission.reserve);
    let settled = false;
    try {
      let text = '';
      if (host === 'fixture.example') {
        const { readFile } = await import('node:fs/promises');
        text = await readFile(join(process.cwd(), 'tests/fixtures/deepseek-web/sample-page.txt'), 'utf8');
      } else if (options.mode === 'dry_run') {
        blocked++; memory.plan_notes.push(`skip_live_fetch ${pageUrl}: dry_run`);
        releaseCall(memory, admission.reserve);
        continue;
      } else {
        const page = options.fetchPage ? await options.fetchPage(pageUrl) : await fetchPublicText(fetcher, pageUrl);
        if (!page.ok) {
          blocked++; memory.plan_notes.push(`fetch_block ${pageUrl}: ${page.reason}`);
          releaseCall(memory, admission.reserve);
          continue;
        }
        text = page.text;
        pageUrl = page.finalUrl;
        const redirectPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
        if (redirectPolicy.blocked) {
          blocked++; memory.plan_notes.push(`block_redirect ${pageUrl}: ${redirectPolicy.reason}`);
          releaseCall(memory, admission.reserve);
          continue;
        }
      }
      if (options.store) assertDomainPolicyReadable(options.store);
      const preModelPolicy = evaluateUrlDomainPolicy(options.store, pageUrl, config);
      if (preModelPolicy.blocked) {
        blocked++; memory.plan_notes.push(`block_pre_model ${pageUrl}: ${preModelPolicy.reason}`);
        releaseCall(memory, admission.reserve);
        continue;
      }
      const checked = new Date().toISOString().slice(0, 10);
      const completion = await client.complete({ system: '당신은 가격을 발명하지 않는 공개 웹 추출기다. JSON만 출력한다.', user: buildExtractionPrompt(text, pageUrl) });
      settleCall(memory, admission.reserve, completion.usage.total_tokens);
      settled = true;
      const extraction = normalizeExtraction(parseModelJson(completion.content), pageUrl, checked);
      if (extraction.in_scope) {
        await enqueueReview(dir, extraction);
        extractions++;
      }
      const proposal = await maybeProposeParserFix(dir, pageUrl, text, extraction);
      if (proposal) proposals++;
      if (!memory.observed_urls.includes(seedUrl)) memory.observed_urls.push(seedUrl);
      memory.pending_urls = memory.pending_urls.filter(u => u !== seedUrl);
    } catch (error) {
      if (!settled) releaseCall(memory, admission.reserve);
      throw error;
    }
  }
  memory.last_run_id = runId;
  memory.output_counts = { extractions, proposals, blocked, review_pending: await countPending(dir) };
  await saveMemory(dir, memory);
  const report: RunReport = {
    run_id: runId,
    at: new Date().toISOString(),
    model,
    mode: options.mode,
    token_spent: memory.token_spent,
    requests_spent: memory.requests_spent,
    extractions,
    proposals,
    blocked,
    review_pending: memory.output_counts.review_pending,
    heartbeat_fresh: false,
    pid: process.pid,
  };
  const fresh = await writeHeartbeat(dir, report, config.memory.heartbeat_max_age_ms);
  report.heartbeat_fresh = fresh;
  memory.last_heartbeat_at = new Date().toISOString();
  await saveMemory(dir, memory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'validation-artifact.json'), `${JSON.stringify({ ...report, validated_at: new Date().toISOString(), profile: config.profile_id }, null, 2)}\n`);
  return report;
}
