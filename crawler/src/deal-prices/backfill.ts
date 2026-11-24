import { join } from 'node:path';
import { assessPriceEvidence, digest, displayExclusion, httpsSource, PRICE_VERIFIER, type PriceEvidence } from '../../../shared/deal-price-evidence';
import { threadsPost } from '../../../shared/threads-url';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { atomicState, readState } from '../deepseek-web/atomic-state';
import { readQueue } from '../deepseek-web/review-queue';
import { acquireWriter } from '../deepseek-web/writer-ownership';
import { queueCaptureHash, queuePriceRevision, writeQueueObservation, writeQueuePrices } from './review-sidecar';
import { captureText, unavailablePriceEvidence, type PriceVerifier } from './verify';

export const backfillKinds = ['deal', 'ingest', 'candidate'] as const;
type SiteKind = typeof backfillKinds[number];
type Original = { kind: 'post' | 'story'; captured_at: string; text: string };
type CaptureFormat = 'verified-offer-text@2' | 'deepseek-web-prepared@3';
export type BackfillTarget = {
  kind: SiteKind | 'queue'; id: string; revision: string; source_url: string; original?: Original | null; captureHash?: string | null; captureFormat?: CaptureFormat;
};
type Manifest = { version: 3; site: string; queue: string; targets: BackfillTarget[] };
type Observation = { evidence: PriceEvidence; contentHash: string | null };
export type BackfillCaptureReason = 'capture_changed' | 'legacy_hash_missing';
type Progress = { observation: Observation | null; key?: string; captureReason?: BackfillCaptureReason; outcome?: string };
type FetchedOffer = { text: string; contentHash: string | null };
type ManifestRow = Omit<BackfillTarget, 'kind' | 'original'> & { original?: string | null };
export type BackfillApi = {
  origin: string;
  page(kind: SiteKind, cursor: string | null): Promise<{ data: ManifestRow[]; next_cursor: string | null }>;
  submit(target: BackfillTarget, key: string, evidence: PriceEvidence, captureReason?: BackfillCaptureReason): Promise<string>;
  counts(): Promise<{ active: number; ended: number }>;
};
const submissionErrors = ['superseded', 'official_source_not_approved', 'capture_mismatch', 'invalid_evidence'] as const;
type SubmissionError = typeof submissionErrors[number];

export function backfillApi(endpoint: string, token: string, fetchImpl = fetch): BackfillApi {
  const origin = new URL(endpoint).origin;
  const parsed = new URL(endpoint);
  if (parsed.username || parsed.password || parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('backfill_site_endpoint');
  }
  const call = async <T>(params: URLSearchParams, body?: unknown): Promise<T> => {
    const url = new URL('/api/v1/admin/price-backfill', origin);
    url.search = params.toString();
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.redirected) throw new Error('backfill_site_redirect');
    if (body && response.status === 404) return { error: 'superseded' } as T;
    if (body && (response.status === 409 || response.status === 400)) {
      const conflict = await response.json() as { error?: SubmissionError };
      if (conflict.error && submissionErrors.includes(conflict.error)) return conflict as T;
    }
    if (!response.ok) throw new Error('backfill_site_failed');
    return response.json() as Promise<T>;
  };
  return {
    origin,
    page: (kind, cursor) => call(new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) })),
    async submit(target, key, evidence, captureReason) {
      const result = await call<{ error: SubmissionError; data?: never } | { error?: never; data: { outcome: string } }>(new URLSearchParams(), {
        kind: target.kind, id: target.id, expected_revision: target.revision, request_id: key, price_evidence: evidence, capture_reason: captureReason,
      });
      return result.error ?? result.data.outcome;
    },
    async counts() { return (await call<{ data: { active: number; ended: number } }>(new URLSearchParams({ kind: 'counts' }))).data; },
  };
}

function existing<T>(path: string): T | null {
  try { return JSON.parse(readState(path)) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('backfill_state_invalid');
  }
}

async function buildManifest(api: BackfillApi, queue: string, rows: Awaited<ReturnType<typeof readQueue>>): Promise<Manifest> {
  const targets: BackfillTarget[] = [];
  for (const kind of backfillKinds) {
    let cursor: string | null = null;
    do {
      const page = await api.page(kind, cursor);
      for (const row of page.data) {
        const original = row.original ? JSON.parse(row.original) as Original : null;
        targets.push({ kind, id: row.id, revision: row.revision, source_url: row.source_url, captureHash: row.captureHash ?? null, captureFormat: row.captureFormat ?? 'verified-offer-text@2',
          ...(original ? { original: { ...original, text: captureText(original.text) } } : {}) });
      }
      if (page.next_cursor && page.next_cursor === cursor) throw new Error('backfill_cursor_loop');
      cursor = page.next_cursor;
    } while (cursor);
  }
  for (const item of rows) {
    targets.push({ kind: 'queue', id: item.id, revision: await queuePriceRevision(item), source_url: item.extraction.url,
      captureHash: queueCaptureHash(item), captureFormat: 'deepseek-web-prepared@3' });
  }
  return { version: 3, site: api.origin, queue, targets };
}

const classify = (outcome: string) => {
  if (outcome === 'capture_changed' || outcome === 'legacy_hash_missing') return 'review_observation';
  if (outcome === 'verified') return 'verified';
  if (['equal_price', 'above_list', 'discount_below_one_percent'].includes(outcome)) return 'display_excluded';
  if (outcome.startsWith('missing_')) return 'missing';
  if (outcome === 'source_inaccessible' || outcome === 'expired_story') return 'inaccessible';
  if (outcome === 'superseded' || outcome === 'capture_mismatch') return 'superseded';
  if (retryable(outcome)) return 'retryable';
  return 'disputed';
};
const retryable = (outcome: string | undefined) => outcome === 'provider_retryable' || outcome === 'official_source_not_approved' || outcome === 'source_inaccessible';

export async function runPriceBackfill(input: {
  dir: string; queue: string; api: BackfillApi; verify: PriceVerifier;
  fetchOffer: (url: string) => Promise<FetchedOffer | null>; now?: () => number; signal?: AbortSignal;
}) {
  const ownership = acquireWriter(input.dir);
  try {
    const manifestPath = join(ownership.dir, 'manifest.json');
    const rows = await readQueue(input.queue);
    const current = new Map(rows.map(item => [canonicalUrl(item.extraction.url), item]));
    let manifest = existing<Manifest>(manifestPath);
    if (manifest === null) {
      manifest = await buildManifest(input.api, input.queue, rows);
      atomicState(manifestPath, manifest);
    }
    if (manifest.version !== 3 || manifest.site !== input.api.origin || manifest.queue !== input.queue) throw new Error('backfill_manifest_mismatch');
    const counts = { verified: 0, display_excluded: 0, missing: 0, disputed: 0, review_observation: 0, inaccessible: 0, superseded: 0, retryable: 0 };
    const reasons: Record<string, number> = {};
    const observations = new Map<string, Observation>();
    const fetched = new Map<string, FetchedOffer | null>();
    const track = (outcome: string) => {
      counts[classify(outcome)]++;
      reasons[outcome] = (reasons[outcome] ?? 0) + 1;
    };
    for (const target of manifest.targets) {
      input.signal?.throwIfAborted();
      if (target.kind === 'queue') {
        const item = current.get(canonicalUrl(target.source_url));
        if (!item || item.status === 'rejected' || await queuePriceRevision(item) !== target.revision) {
          track('superseded');
          continue;
        }
      }
      const id = await digest(JSON.stringify([manifest.site, target.kind, target.id, target.revision]));
      const resultPath = join(ownership.dir, 'outcomes', id + '.json');
      let progress = existing<Progress>(resultPath);
      const now = (input.now ?? Date.now)();
      const original = target.original;
      const expired = original?.kind === 'story' && Date.parse(original.captured_at) + 86_400_000 <= now;
      const signature = JSON.stringify([target.source_url, original?.text ?? null, expired ?? false]);
      if (progress?.observation && !retryable(progress.outcome)) observations.set(signature, progress.observation);
      if (progress?.outcome && !retryable(progress.outcome)) {
        track(progress.outcome);
        continue;
      }
      let observation = progress?.observation && !progress.outcome ? progress.observation : observations.get(signature);
      if (!observation && !fetched.has(signature)) {
        const capture = expired || !httpsSource(target.source_url) ? null : original ? { text: original.text, contentHash: null } :
          await input.fetchOffer(target.source_url);
        fetched.set(signature, capture);
      }
      const capture = fetched.get(signature);
      const capturedText = observation?.evidence.offer?.source.text ?? captureText(capture?.text ?? '');
      const contentHash = observation ? observation.contentHash : capture?.contentHash ?? null;
      const captureFormat = target.captureFormat ?? (target.kind === 'queue' ? 'deepseek-web-prepared@3' : 'verified-offer-text@2');
      const observedHash = captureFormat === 'deepseek-web-prepared@3' ? contentHash : capturedText ? await digest(capturedText) : null;
      const captureReason = (progress && !progress.outcome ? progress.captureReason : undefined) ?? (capturedText ? !target.captureHash ? 'legacy_hash_missing' :
        observedHash !== target.captureHash ? 'capture_changed' : undefined : undefined);
      if (!observation) {
        const evidence = capturedText ? await input.verify(target.source_url, capturedText, original?.captured_at ?? new Date(now).toISOString()) :
          unavailablePriceEvidence(target.source_url, expired ? 'expired_story' : 'source_inaccessible');
        observation = { evidence, contentHash };
        observations.set(signature, observation);
      }
      const { evidence } = observation;
      const key = progress?.key && !progress.outcome ? progress.key :
        await digest(JSON.stringify([id, PRICE_VERIFIER, evidence, captureReason ?? null]));
      progress = { observation, key, captureReason };
      atomicState(resultPath, progress);
      if (target.kind === 'queue') {
        const result = assessPriceEvidence(evidence);
        if (captureReason) {
          await writeQueueObservation(input.queue, target.id, target.revision, evidence, captureReason);
        } else if (target.captureHash && evidence.offer) {
          writeQueuePrices(input.queue, target.revision, target.captureHash, evidence);
        }
        progress.outcome = result.outcome === 'provider_retryable' ? result.outcome : captureReason ??
          (result.facts ? displayExclusion(result.facts.deal_price_krw, result.facts.list_price_krw) ?? result.outcome : result.outcome);
      } else progress.outcome = await input.api.submit(target, key, evidence, captureReason);
      atomicState(resultPath, progress);
      track(progress.outcome);
    }
    return { totals: counts, reasons, public: await input.api.counts() };
  } finally { ownership.release(); }
}

export function sourceFetcher(web: (url: string) => Promise<FetchedOffer | null>, threads: (url: string) => Promise<string | null>) {
  return async (url: string) => {
    if (!threadsPost(url)) return web(url);
    const text = await threads(url);
    return text ? { text, contentHash: null } : null;
  };
}
