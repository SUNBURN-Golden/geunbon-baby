import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './helpers/collector';
import { runDeepSeekWeb, type FetchPageResult } from '../crawler/src/deepseek-web/runner';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
import { candidateDecision } from '../crawler/src/deepseek-web/candidate-filter';
import { classifyCatalogScope, loadGeunbonCatalog, matchCatalogProduct, type CatalogMatch } from '../crawler/src/deepseek-web/catalog';
import { checkExtraction, validateExtraction } from '../crawler/src/deepseek-web/extract';
import { enqueueReviewIfNew, readQueue } from '../crawler/src/deepseek-web/review-queue';
import { cacheKey } from '../crawler/src/deepseek-web/cache-identity';
import { matchItemModel } from '../crawler/src/deepseek-web/bundle';
import { canonicalBrand } from '../crawler/lib/extract';
import type { CacheEntry } from '../crawler/src/deepseek-web/extraction-cache';
import type { CheckedGongguExtraction, DeepSeekUsage, RawBundleItem } from '../crawler/src/deepseek-web/types';

const catalog = loadGeunbonCatalog();
const config = loadDeepSeekWebConfig();
const endedUrl = 'https://09pangpang.com/post/810498';
const endedHtml = () => readFileSync(new URL('./fixtures/deepseek-web/ended-page.html', import.meta.url), 'utf8');
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a source page showing 종료 prepares as ended and is rejected before matching or evidence', () => {
  const page = preparePage(endedHtml(), endedUrl);
  expect(page.failure).toBeNull();
  expect(page.deal_status).toBe('ended');
  // The status badge is volatile run-state wording: it never enters prepared
  // text, so it cannot reach the model prompt or the content hash.
  expect(page.text).not.toContain('종료');
  expect(candidateDecision(page, catalog, config)).toEqual({ accepted: false, code: 'candidate_ended', match: null });
  // The same page with a live badge stays eligible: only 종료 closes the deal.
  const open = preparePage(endedHtml().replace('text-status-ended">종료', 'text-status-active">오늘 오픈'), endedUrl);
  expect(open.deal_status).toBe('open');
  expect(candidateDecision(open, catalog, config)).toMatchObject({ accepted: true, code: 'candidate_pangpang_deal' });
  const scheduled = preparePage(endedHtml().replace('text-status-ended">종료', 'text-status-scheduled">내일 오픈 예정'), endedUrl);
  expect(scheduled.deal_status).toBe('scheduled');
  // 마감 wording outside the status badge (a date label) is not an ended signal.
  const deadlineLabel = preparePage(endedHtml().replace('text-status-ended">종료', 'text-status-active">오늘 오픈').replace('정식수입 ·', '마감 2026-10-31 ·'), endedUrl);
  expect(deadlineLabel.deal_status).toBe('open');
});

test('ended pages never invoke Flash or append to the review queue; the open variant is queued', async () => {
  const dir = tempDir('flash-ended-'), f = fixture();
  cleanup.push(() => f.close());
  const extraction = { brand: 'Stokke', model: 'Tripp Trapp', category: 'high_chair', gonggu_price: '390,000원', regular_price: '정보 없음', period: '10/28 ~ 10/31', gifts: '정보 없음', conditions: '정식수입', seller: '@somda.park', url: endedUrl, checked_date: '2000-01-01', in_scope: true };
  const complete = vi.fn(async () => ({ content: JSON.stringify(extraction), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } as DeepSeekUsage, model: 'deepseek-flash', finish_reason: 'stop' }));
  let body = endedHtml();
  const fetchPage = vi.fn(async (target: string): Promise<FetchPageResult> => ({ ok: true, text: body, finalUrl: target, status: 200, etag: '"one"' }));
  const run = () => runDeepSeekWeb({ mode: 'once', stateDir: dir, store: f.store, urls: [endedUrl], client: { complete }, fetchPage });
  const rejected = await run();
  expect(rejected.candidate_pages_rejected).toBe(1);
  expect(complete).not.toHaveBeenCalled();
  expect(await readQueue(dir)).toEqual([]);
  expect(readFileSync(join(dir, 'outcomes.jsonl'), 'utf8')).toContain('candidate_ended');
  // Flipping the badge to a live status on the same page makes it queueable again.
  body = endedHtml().replace('text-status-ended">종료', 'text-status-active">오늘 오픈');
  const accepted = await run();
  expect(accepted.candidate_pages_accepted).toBe(1);
  expect(complete).toHaveBeenCalledTimes(1);
  const rows = await readQueue(dir);
  expect(rows).toHaveLength(1);
  expect(rows[0].extraction.url).toBe(endedUrl);
});

test('the 하베브릭스 triplet (838368/845247/839301) collapses to one review row', async () => {
  const dir = tempDir('flash-dedup-');
  const at = '2026-11-10T12:00:00+09:00';
  const pageHtml = (schedule: string) => `<article><h1>하베브릭스 모빌 아기체육관 공구</h1><span class="text-category">키즈 > 유아용품</span><a href="/account/77"><p>@somda.park</p></a><div class="schedule">${schedule}</div><div class="offer">공구가 189,000원</div></article>`;
  // Same offer, three different phrasings: model punctuation, period spacing and
  // a decorated seller suffix (2026-11-11 manual-review evidence).
  const checked = (post: number, model: string, period: string, seller: string, schedule = '2026-10-28 ~ 2026-10-31'): CheckedGongguExtraction => {
    const url = `https://09pangpang.com/post/${post}`;
    const page = preparePage(pageHtml(schedule), url);
    const content = JSON.stringify({ brand: '하베브릭스', model, category: 'play_gym', gonggu_price: '189,000원', regular_price: '정보 없음', period, gifts: '정보 없음', conditions: '정보 없음', seller, url, checked_date: '2026-11-10', in_scope: true });
    // The runner attaches the catalog mapping after checking (runner.ts does the same).
    const extraction = checkExtraction(validateExtraction(content, url, '2026-11-10'), page, at);
    extraction.catalog_product_id = 'habebrix-mobile';
    return extraction;
  };
  const first = checked(838368, '모빌 & 아기체육관 세트', '2026-10-28 ~ 2026-10-31', '@somda.park');
  const second = checked(845247, '모빌 아기체육관 세트', '2026-10-28~2026-10-31', '@somda.park');
  const third = checked(839301, '모빌, 아기체육관', '2026-10-28 ~ 2026-10-31', '@somda.park (인스타그램)');
  for (const e of [first, second, third]) {
    expect(e.catalog_product_id).toBe('habebrix-mobile');
    expect(e.gonggu_price).toBe(189000);
  }
  const match: CatalogMatch = { product_id: 'habebrix-mobile', category: 'play_gym', brand: 'Habebrix', product_line: 'Mobile', score: 9 };
  const entry = (e: CheckedGongguExtraction): CacheEntry => {
    const contract = 'a'.repeat(64);
    return { version: 2 as const, cache_key: cacheKey(e.url, e.fact_check.source_hash, contract), canonical_url: e.url, content_hash: e.fact_check.source_hash, contract_hash: contract, candidate: { accepted: true, code: 'candidate_pangpang_deal', match }, result: e, extracted_at: e.fact_check.observed_at, proposal: null, pending_delivery: true };
  };
  expect(await enqueueReviewIfNew(dir, first, entry(first))).toEqual({ enqueued: true });
  expect(await enqueueReviewIfNew(dir, second, entry(second))).toEqual({ enqueued: false, reason: 'duplicate_offer' });
  expect(await enqueueReviewIfNew(dir, third, entry(third))).toEqual({ enqueued: false, reason: 'duplicate_offer' });
  const rows = await readQueue(dir);
  expect(rows).toHaveLength(1);
  expect(rows[0].extraction.url).toBe('https://09pangpang.com/post/838368');
  // A different seller or a different window is a different offer, not a duplicate.
  const otherSeller = checked(854154, '모빌 아기체육관 세트', '2026-10-28 ~ 2026-10-31', '@jw__mini (인스타그램 공동구매)');
  const otherWindow = checked(830990, '모빌 아기체육관 세트', '2026-11-04 ~ 2026-11-07', '@somda.park', '2026-11-04 ~ 2026-11-07');
  expect(await enqueueReviewIfNew(dir, otherSeller, entry(otherSeller))).toEqual({ enqueued: true });
  expect(await enqueueReviewIfNew(dir, otherWindow, entry(otherWindow))).toEqual({ enqueued: true });
  expect(await readQueue(dir)).toHaveLength(3);
});

test('seller handles and blocked source categories cannot carry an off-scope product into review', () => {
  // A brand word inside the seller handle is not brand evidence for the listing…
  const slime = classifyCatalogScope({ title: '박사퍼티 에르고 슬라임 세트', category_text: '키즈 > 장난감/완구', text: '@the_ergo_official 슬라임 만들기 공구 세트' }, catalog);
  expect(slime).toEqual({ kind: 'outside_scope' });
  // …nor for the catalog matcher, even with a clean in-scope category.
  expect(matchCatalogProduct({ title: '공구 세트', category_text: '키즈 > 유아용품', text: '@the_ergo_official' }, catalog)).toBeNull();
  expect(matchCatalogProduct({ title: '에르고 슬라임 세트', category_text: '키즈 > 유아용품', text: '' }, catalog)).toBeNull();
  // A real brand in the title still matches with the body dropped.
  expect(classifyCatalogScope({ title: '에르고베이비 옴니 360 아기띠', category_text: '키즈 > 유아용품', text: '@the_ergo_official' }, catalog)).toMatchObject({ kind: 'catalog_match', match: { product_id: 'ergobaby-omni' } });
  // Detail pages from blocked source categories are rejected before any model call.
  const decide = (title: string, category: string) => candidateDecision(preparePage(`<main><h1>${title}</h1><span class="text-category">${category}</span><div class="offer">공구가 89,000원</div></main>`, 'https://shop.example/x'), catalog, config);
  expect(decide('에르고 3 IN 1 가습온풍기 공구', '생활가전')).toMatchObject({ accepted: false, code: 'candidate_excluded_category' });
  expect(decide('에르고 초콜릿 별미 공구', '식품 > 간식/베이커리')).toMatchObject({ accepted: false, code: 'candidate_excluded_category' });
  expect(decide('박사퍼티 에르고 슬라임 세트 공구', '키즈 > 장난감/완구')).toMatchObject({ accepted: false, code: 'candidate_excluded_category' });
  // A blocked leaf anywhere under the 키즈 subtree, not just the last segment.
  expect(decide('에르고 슬라임 만들기 공구', '키즈 > 장난감/완구 > 슬라임')).toMatchObject({ accepted: false, code: 'candidate_excluded_category' });
});

test('catalog matching requires the brand itself; unmatched products stay null', () => {
  expect(matchCatalogProduct({ title: '아베크 플레이짐', category_text: '키즈 > 육아용품', text: '' }, catalog)).toBeNull();
  expect(matchCatalogProduct({ title: '익싸 스위브', category_text: '키즈 > 유모차/카시트', text: '' }, catalog)).toBeNull();
  expect(matchCatalogProduct({ title: '러브에버리 플레이짐', category_text: '키즈 > 육아용품', text: '' }, catalog)).toMatchObject({ product_id: 'lovevery-play-gym' });
  expect(matchCatalogProduct({ title: '뉴나 믹스 유모차', category_text: '키즈 > 유모차', text: '' }, catalog)).toMatchObject({ product_id: 'nuna-mixx' });
  // Neutral parenting categories never block a real brand match.
  for (const category of ['유아용품', '유모차', '카시트', '육아용품', '유모차/카시트', '']) {
    expect(matchCatalogProduct({ title: '스토케 트립트랩 공구', category_text: category, text: '' }, catalog)).toMatchObject({ product_id: 'stokke-tripp-trapp' });
  }
  // Bundle item matching is brand-guarded the same way: an explicitly unknown
  // brand is never silently mapped onto a catalog model.
  const item = (product_name: string, source_brand: string | null): RawBundleItem => ({ region_index: 1, source_brand, product_name, option_text: null, category: 'play_gym', gonggu_price: null, source_quote: product_name });
  expect(canonicalBrand('아베크')).toBeNull();
  expect(matchItemModel(item('플레이짐', '아베크'))).toEqual({ brand: null, model_match: null, model_status: 'no_match' });
  expect(matchItemModel(item('플레이짐', null))).toEqual({ brand: null, model_match: null, model_status: 'no_match' });
});
