import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createPriceVerifier, productText, type PriceCompletion } from '../crawler/src/deal-prices/verify';
import { backfillApi, runPriceBackfill, type BackfillApi } from '../crawler/src/deal-prices/backfill';
import { collectThreadsPost, fetchThreadsPost } from '../crawler/src/deal-prices/threads';
import { assessPriceEvidence, parsePriceEvidence, PRICE_MODELS, type Reading } from '../shared/deal-price-evidence';
import { checkedAt, endsAt, exampleEvidence, mockReading, offerHtml, officialHtml, officialUrl, officialScope } from './helpers/verified-deal-prices';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
import { checkExtraction, validateExtraction } from '../crawler/src/deepseek-web/extract';
import { readQueuePrices } from '../crawler/src/deal-prices/review-sidecar';
import type { ReviewQueueItem } from '../crawler/src/deepseek-web/types';

const offer = 'https://fixture.example/deepseek-web-sample';
const at = checkedAt;
const usage = { prompt_tokens: 14, completion_tokens: 16, total_tokens: 30 };
const sourceText = (input: string) => (JSON.parse(input.split('\n').at(-1)!) as { untrusted_source_data: string }).untrusted_source_data;

function setup({
  change,
  comparison = officialHtml,
  allowed = (): boolean => true,
}: { change?: (reading: Reading, index: number, official: boolean) => void; comparison?: string; allowed?: () => boolean } = {}) {
  const complete = vi.fn<PriceCompletion>(async (index, input) => {
    const official = input.user.startsWith('Read the manufacturer');
    const reading = mockReading(sourceText(input.user), official);
    change?.(reading, index, official);
    return { content: JSON.stringify(reading), model: PRICE_MODELS[index], usage };
  });
  const official = vi.fn(async () => allowed() ? {
    url: officialUrl, text: productText(comparison, officialUrl), observedAt: at,
    approval: { id: officialScope.id, revision: officialScope.revision }, approvedAt: officialScope.approved_at,
  } : null);
  const verify = createPriceVerifier({ complete, official });
  return { verify, complete, official };
}

test('both blind providers receive byte-identical privacy-filtered HTML captures for each of the two sources', async () => {
  const { verify, complete, official } = setup();
  const source = productText(offerHtml.replace('<p>배송비', '<p>우리 아기 이름: Fixture</p><p>배송비'), offer);
  const evidence = await verify(offer, source, at);
  expect(await parsePriceEvidence(evidence)).toEqual(evidence);
  expect(assessPriceEvidence(evidence)).toMatchObject({ outcome: 'verified', facts: { deal_price_krw: 390000, list_price_krw: 430000, ends_at: endsAt } });
  expect(complete.mock.calls.map(call => call[0])).toEqual([0, 1, 0, 1]);
  const inputs = complete.mock.calls.map(call => call[1]);
  expect(inputs[0]).toEqual(inputs[1]);
  expect(inputs[2]).toEqual(inputs[3]);
  expect(inputs[0].user).not.toContain('우리 아기 이름');
  expect(sourceText(inputs[2].user)).not.toContain('700,000');
  expect(evidence.offer?.source.text).toBe(sourceText(inputs[0].user));
  expect(evidence.official?.source.text).toBe(sourceText(inputs[2].user));
  expect(await verify(offer, source, at, evidence)).toEqual(evidence);
  expect(complete).toHaveBeenCalledTimes(4);
  expect(official).toHaveBeenCalledTimes(2);
});

test.each([
  ['offer_price_disagreement', (reading: Reading, index: number, official: boolean) => { if (!official && index) reading.amount = 390001; }],
  ['deadline_disagreement', (reading: Reading, index: number, official: boolean) => {
    if (!official && index) reading.deadline!.quote += ' 23:59:59';
  }],
  ['unsupported_offer_price', (reading: Reading, _index: number, official: boolean) => { if (!official) reading.amount = 3000; }],
  ['unsupported_deadline', (reading: Reading, _index: number, official: boolean) => {
    if (!official) reading.deadline!.quote = '마감일: 2027년 11월 24일';
  }],
  ['list_price_disagreement', (reading: Reading, index: number, official: boolean) => { if (official && index) reading.amount = 430001; }],
] as const)('%s remains private', async (outcome, change) => {
  const { verify } = setup({ change });
  expect(assessPriceEvidence(await verify(offer, productText(offerHtml, offer), at))).toEqual({ outcome });
});

test('a separately fetched wrong configuration, inaccessible body, or denied official path each stays private', async () => {
  const source = productText(offerHtml, offer);
  const mismatch = setup({ comparison: officialHtml.replace('Natural', 'White') });
  expect(assessPriceEvidence(await mismatch.verify(offer, source, at))).toEqual({ outcome: 'configuration_mismatch' });
  let allowed = true;
  const denied = setup({ allowed: () => allowed });
  const first = await denied.verify(offer, source, at);
  expect(assessPriceEvidence(first).outcome).toBe('verified');
  allowed = false;
  expect(assessPriceEvidence(await denied.verify(offer, source, at, first)).outcome).toBe('missing_official_coverage');
  expect(denied.complete.mock.calls).toHaveLength(4);
  const noBody = setup({ comparison: '<main>Please sign in</main>' });
  expect(assessPriceEvidence(await noBody.verify(offer, source, at)).outcome).toBe('source_inaccessible');
});

test('zero requires an explicit whole-configuration price and successful unusable responses stay retryable', async () => {
  const whole = productText(offerHtml.replace('공구가: 390,000원', '전체 공구가: 0원'), offer);
  const { verify } = setup();
  expect(assessPriceEvidence(await verify(offer, whole, at)).facts?.deal_price_krw).toBe(0);
  expect(assessPriceEvidence(await verify(offer, whole.replace('전체 ', ''), at)).outcome).toBe('unsupported_offer_price');
  const complete = vi.fn<PriceCompletion>(async index => {
    if (!index) throw new Error('fixture provider failure');
    return { content: '', model: PRICE_MODELS[index], usage };
  });
  const retry = createPriceVerifier({ complete, official: async () => null });
  expect(assessPriceEvidence(await retry(offer, whole, at)).outcome).toBe('provider_retryable');
  expect(complete.mock.calls.map(call => call[0])).toEqual([0, 1]);
});

test('a fully dated range verifies its inclusive KST end, while partial and conflicting ranges fail', async () => {
  const { verify } = setup();
  const source = productText(offerHtml, offer);
  const range = source.replace('마감일: 2026년 11월 24일', '공구기간: 2026년 11월 22일 ~ 2026년 11월 24일');
  expect(assessPriceEvidence(await verify(offer, range, at)).facts?.ends_at).toBe(endsAt);
  expect(assessPriceEvidence(await verify(offer, range.replace('공구기간:', '기간:'), at)).facts?.ends_at).toBe(endsAt);
  for (const closure of ['공구 마감됨', '안내: 공구 마감됨', '공구 종료']) {
    expect(assessPriceEvidence(await verify(offer, range + '\n' + closure, at)).facts?.ends_at).toBe(endsAt);
  }
  expect(assessPriceEvidence(await verify(offer, range.replace('~ 2026년', '~'), at)).outcome).toBe('unsupported_deadline');
  expect(assessPriceEvidence(await verify(offer, range + '\n마감일: 2026년 11월 25일', at)).outcome).toBe('unsupported_deadline');
});

test('Threads verifies exact author and post ID, rejects login walls, and checks authority before redirects', async () => {
  const url = 'https://www.threads.net/@fixture/post/abc';
  const html = `<main><article data-post-id="abc" data-author="@fixture"><div data-post-body>${offerHtml.replace(/<\/?(?:article|main)>/g, '')}</div></article></main>`;
  const respond = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
  const allow = vi.fn((source: string) => ({ allowed: source === 'social:www.threads.net', reason: 'approval_required', source_id: source, revision: 1 }) as const);
  const registry = { decide: allow };
  const fetchImpl = vi.fn(async () => respond(html));
  const send = vi.fn(async () => ({ id: 'queued', status: 'pending' }));
  const { verify } = setup();
  await expect(collectThreadsPost(url, { registry, verify, fetchImpl, send, api: new URL('https://site.test/api/v1/ingest'), token: 'fixture' }))
    .resolves.toMatchObject({ outcome: 'pending_review' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(expect.any(URL), 'fixture', expect.objectContaining({ platform: 'threads', kind: 'threads_post', source_url: url, account: 'fixture' }));
  for (const body of ['<main>Log in to continue</main>', html.replace('data-post-id="abc"', 'data-post-id="wrong"'), `<div data-login-wall>${html}</div>`]) {
    expect(await fetchThreadsPost(url, registry, async () => respond(body))).toEqual({ outcome: 'source_inaccessible' });
  }
  fetchImpl.mockClear().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://www.threads.com/@fixture/post/abc' } }));
  expect(await fetchThreadsPost(url, registry, fetchImpl)).toEqual({ outcome: 'source_inaccessible' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(allow.mock.calls.map(call => call[0]).at(-1)).toBe('social:www.threads.com');
});

test('backfill resumes a lost response, shares one observation across targets, and preserves review queue bytes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'price-backfill-'));
  const queue = join(scratch, 'queue'), dir = join(scratch, 'checkpoint');
  try {
    await mkdir(queue, { mode: 0o700 });
    const completion = JSON.parse(await readFile(new URL('./fixtures/deepseek-web/mock-completion.json', import.meta.url), 'utf8'));
    const raw = validateExtraction(completion.content, offer, at.slice(0, 10));
    const page = preparePage(offerHtml, offer);
    const older = preparePage(offerHtml.replace('390,000', '375,000'), offer);
    const item: ReviewQueueItem = { id: 'fixture-review', status: 'pending', source_kind: 'public_web', verify_level: 'model_extract',
      created_at: at, extraction: checkExtraction(raw, page, at) };
    const oldItem = { ...item, id: 'old-review', extraction: checkExtraction(raw, older, at) };
    const bytes = [oldItem, item].map(row => JSON.stringify(row)).join('\n') + '\n';
    const path = join(queue, 'review-queue.jsonl');
    await writeFile(path, bytes, { mode: 0o600 });
    const evidence = await exampleEvidence(offer);
    const submitted = new Map<string, string>();
    const api: BackfillApi = {
      origin: 'https://site.test',
      page: vi.fn(async kind => ({ data: kind === 'ingest' ? [] : [{ id: kind, revision: '1', source_url: offer,
        captureHash: evidence.offer!.source.hash }], next_cursor: null })),
      submit: vi.fn(async (target, key) => {
        if (target.kind === 'candidate') return 'superseded';
        if (submitted.has(key)) return submitted.get(key)!;
        submitted.set(key, 'verified');
        throw new Error('lost response');
      }),
      counts: async () => ({ active: 1, ended: 0 }),
    };
    const verify = vi.fn(async () => evidence);
    const fetchOffer = vi.fn(async () => ({ text: evidence.offer!.source.text, contentHash: page.content_hash }));
    const input = { dir, queue, api, verify, fetchOffer, now: () => Date.parse(at) };
    await expect(runPriceBackfill(input)).rejects.toThrow('lost response');
    const resumed = await runPriceBackfill(input);
    expect(resumed.totals).toMatchObject({ verified: 2, superseded: 2, retryable: 0 });
    expect(resumed.public).toEqual({ active: 1, ended: 0 });
    expect(await runPriceBackfill(input)).toEqual(resumed);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(fetchOffer).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledTimes(3);
    expect(submitted.size).toBe(1);
    expect(await readQueuePrices(queue, oldItem)).toBeNull();
    expect(await readQueuePrices(queue, item)).toEqual(evidence);
    const mismatched = await runPriceBackfill({ ...input, dir: join(scratch, 'changed'), api: { ...api,
      page: async () => ({ data: [], next_cursor: null }) },
      fetchOffer: async () => ({ text: evidence.offer!.source.text, contentHash: older.content_hash }) });
    expect(mismatched.totals).toMatchObject({ verified: 0, superseded: 1, review_observation: 1 });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('backfill submits a changed site capture and continues after a terminal legacy URL response', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'backfill-site-captures-'));
  try {
    const queue = join(scratch, 'queue'), dir = join(scratch, 'checkpoint');
    await mkdir(queue, { mode: 0o700 });
    const evidence = await exampleEvidence(offer);
    const changed = await exampleEvidence(offer, 400000);
    const legacy = 'https://09pangpang.com/post/8123?variant=natural';
    const posted: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(init.body as string);
        posted.push(payload.id);
        if (payload.id === 'legacy') {
          expect(payload.price_evidence).toMatchObject({ offer_url: legacy, failed: 'source_inaccessible', offer: null });
          return Response.json({ error: 'invalid_evidence' }, { status: 400 });
        }
        return Response.json({ data: { outcome: payload.capture_reason ?? 'verified' } });
      }
      const kind = new URL(String(url)).searchParams.get('kind');
      if (kind === 'counts') return Response.json({ data: { active: 0, ended: 0 } });
      return Response.json({ next_cursor: null, data: kind === 'candidate' ? [
        { id: 'legacy', revision: '1', source_url: legacy, captureHash: evidence.offer!.source.hash },
        { id: 'changed', revision: '1', source_url: offer, captureHash: changed.offer!.source.hash },
        { id: 'unchanged', revision: '1', source_url: offer, captureHash: evidence.offer!.source.hash },
      ] : [] });
    });
    const verify = vi.fn(async () => evidence);
    const fetchOffer = vi.fn(async () => ({ text: evidence.offer!.source.text, contentHash: null }));
    const api = backfillApi('https://site.test', 'offline-test-token', fetchImpl);
    const input = { dir, queue, api, verify, fetchOffer, now: () => Date.parse(at) };
    const result = await runPriceBackfill(input);
    expect(result.reasons).toEqual({ invalid_evidence: 1, capture_changed: 1, verified: 1 });
    expect(await runPriceBackfill(input)).toEqual(result);
    expect(posted).toEqual(['legacy', 'changed', 'unchanged']);
    expect(fetchOffer).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
