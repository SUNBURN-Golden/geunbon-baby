import { migrationStatements } from './helpers/migrations';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DealDetail } from '../app/deals/_components';
import { promoteExternalCandidate } from '../lib/promote-external';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { loadGeunbonCatalog } from '../crawler/src/deepseek-web/catalog';
import { candidateDecision } from '../crawler/src/deepseek-web/candidate-filter';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
import { checkExtraction, isCheckedExtraction, projectExtraction, validateCheckedExtraction, validateExtraction } from '../crawler/src/deepseek-web/extract';
import { validEntry } from '../crawler/src/deepseek-web/extraction-cache';
import { cacheKey } from '../crawler/src/deepseek-web/cache-identity';
import { enqueueReviewIfNew, readQueue } from '../crawler/src/deepseek-web/review-queue';
import { formatWeeklyReview, weeklyReview } from '../crawler/src/deepseek-web/weekly-review';
import { checkItemPrice, ITEM_FACT_VERSION } from '../crawler/lib/deal-fact-check';
import { canonicalBrand, modelCategory, modelRefiners } from '../crawler/lib/extract';
import { matchItemModel } from '../crawler/src/deepseek-web/bundle';
import { reviewBundleItems, reviewBundleLabels, reviewBundleTitle } from '../scripts/review-facts';
import { memoryD1 } from './helpers/sqlite';
import type { CheckedGongguExtraction, RawBundleItem } from '../crawler/src/deepseek-web/types';
import type { DealWithContext } from '../lib/deals';

const at = '2026-11-10T12:00:00+09:00';
const url = 'https://09pangpang.com/post/1';
const otherUrl = 'https://09pangpang.com/post/2';
const catalog = loadGeunbonCatalog();
const config = loadDeepSeekWebConfig();
const fixture = (name: string) => readFileSync(new URL(`./fixtures/deepseek-web/${name}`, import.meta.url), 'utf8');
const completion = (name: string) => JSON.parse(fixture(name)) as { content: string };
type RawModel = Record<string, unknown> & { bundle_items: Record<string, unknown>[] };
const rawModel = (name = 'bundle-completion.json') => JSON.parse(completion(name).content) as RawModel;
const prepare = (html: string, target = url) => preparePage(html, target);
const decide = (html: string, target = url) => candidateDecision(prepare(html, target), catalog, config);
function checkFixture(htmlName = 'bundle-page.html', jsonName = 'bundle-completion.json', target = url) {
  const page = prepare(fixture(htmlName), target);
  const raw = validateExtraction(completion(jsonName).content, target, '2026-11-10');
  return { page, raw, checked: checkExtraction(raw, page, at) };
}

describe('bundle preparation and candidate decisions', () => {
  test('multi-product pages become exact marker-delimited regions and are accepted as bundles', () => {
    const page = checkFixture().page;
    expect(page.failure).toBeNull();
    expect(page.truncated).toBe(false);
    expect(page.bundle?.title).toBe('브라이택스 듀얼픽스 카시트 3종 모음전');
    expect(page.bundle?.regions).toHaveLength(3);
    for (const region of page.bundle!.regions) {
      expect(page.text.slice(region.start - '[[상품 1]]\n'.length, region.start)).toMatch(/^\[\[상품 \d\]\]\n$/);
      expect(page.text.slice(region.start, region.end)).toBeTruthy();
      expect(page.text.slice(region.start, region.end)).not.toContain('[[상품');
    }
    expect(candidateDecision(page, catalog, config)).toMatchObject({ accepted: true, code: 'candidate_bundle_deal' });
  });

  test('a single product region with a bundle title and item headings splits deterministically', () => {
    const page = checkFixture('bundle-page-single-region.html').page;
    expect(page.bundle?.regions).toHaveLength(3);
    expect(page.bundle?.title).toBe('브라이택스 듀얼픽스 카시트 모음전');
    expect(candidateDecision(page, catalog, config)).toMatchObject({ accepted: true, code: 'candidate_bundle_deal' });
  });

  test('a head <title> supplies the bundle hint without entering prepared text', () => {
    const title = '<title>브라이택스 듀얼픽스 카시트 2종 모음전</title>';
    const items = `<article><h2>듀얼픽스 프로 LUX 카시트</h2><p>공구가 520,000원</p></article><article><h2>듀얼픽스 프로 STYLE 카시트</h2><p>공구가 480,000원</p></article>`;
    const page = prepare(`<html><head>${title}</head><body><main>${items}</main></body></html>`);
    expect(page.failure).toBeNull();
    expect(page.bundle?.title).toBe('브라이택스 듀얼픽스 카시트 2종 모음전');
    expect(page.text).not.toContain('2종 모음전');
    expect(page.bundle?.regions).toHaveLength(2);
  });

  test('a differing <title> hint does not demote the in-region bundle title to an item', () => {
    const html = `<html><head><title>브라이택스 듀얼픽스 카시트 모음전 | 09팡팡</title></head><body>${fixture('bundle-page-single-region.html')}</body></html>`;
    const page = prepare(html);
    expect(page.failure).toBeNull();
    expect(page.bundle?.title).toBe('브라이택스 듀얼픽스 카시트 모음전');
    expect(page.bundle?.regions).toHaveLength(3);
    expect(page.bundle?.regions.map(region => region.title)).toEqual([
      '듀얼픽스 프로 LUX 카시트', '듀얼픽스 프로 STYLE 카시트', '듀얼픽스 프로 CLASSIC 카시트',
    ]);
    expect(candidateDecision(page, catalog, config)).toMatchObject({ accepted: true, code: 'candidate_bundle_deal' });
  });

  test('single-product pages remain on the existing path with no bundle fields', () => {
    const page = prepare(fixture('sample-page.txt'), 'https://fixture.example/deepseek-web-sample');
    expect(page.bundle).toBeNull();
    expect(page.failure).toBeNull();
    expect(page.truncated).toBe(false);
    expect(page.title).toBe('스토케 트립트랩 공구 안내 (샘플 픽스처, 실제 거래 아님)');
    expect(page.text.startsWith('스토케 트립트랩 공구 안내 (샘플 픽스처, 실제 거래 아님) 스토케 트립트랩')).toBe(true);
    expect(candidateDecision(page, catalog, config)).toMatchObject({ accepted: true, code: 'candidate_text_deal' });
  });

  test('Joie bundle pages are rejected at the catalog gate even though Joie models exist', () => {
    const page = prepare(fixture('bundle-joie.html'));
    expect(page.bundle?.regions).toHaveLength(2);
    expect(candidateDecision(page, catalog, config)).toMatchObject({ accepted: false, code: 'candidate_no_catalog_match', match: null });
  });

  test('bundle failures fail closed: no hint, too many regions, extra headings, marker collision, caps, empty body', () => {
    const hint = '<h1>브라이택스 듀얼픽스 카시트 모음전</h1>';
    const article = (name: string, body = '공구가 520,000원') => `<article><h2>${name}</h2><p>${body}</p></article>`;
    const noHint = prepare(`<main>${article('듀얼픽스 프로 LUX')}${article('듀얼픽스 프로 STYLE')}</main>`);
    expect(noHint.failure).toBe('candidate_ambiguous_product');
    expect(decide(`<main>${article('듀얼픽스 프로 LUX')}${article('듀얼픽스 프로 STYLE')}</main>`).code).toBe('candidate_ambiguous_product');

    const nine = prepare(`<main>${hint}${Array.from({ length: 9 }, (_, i) => article(`듀얼픽스 프로 LUX ${i}`)).join('')}</main>`);
    expect(nine.failure).toBe('candidate_bundle_unsupported');

    const doubleHeading = prepare(`<main>${hint}${article('듀얼픽스 프로 LUX')}<article><h2>듀얼픽스 프로 STYLE</h2><h2>다른 상품</h2><p>공구가 480,000원</p></article></main>`);
    expect(doubleHeading.failure).toBe('candidate_bundle_unsupported');

    const marker = prepare(`<main>${hint}${article('듀얼픽스 프로 LUX')}${article('듀얼픽스 프로 STYLE', '[[상품 9]] 공구가 480,000원')}</main>`);
    expect(marker.failure).toBe('candidate_bundle_unsupported');

    const longPreamble = prepare(`<main><h1>브라이택스 듀얼픽스 카시트 모음전 ${'가'.repeat(2100)}</h1>${article('듀얼픽스 프로 LUX')}${article('듀얼픽스 프로 STYLE')}</main>`);
    expect(longPreamble.failure).toBe('candidate_preparation_limit');
    expect(longPreamble.truncated).toBe(false);

    const longBody = prepare(`<main>${hint}${article('듀얼픽스 프로 LUX', `공구가 520,000원 ${'가'.repeat(1300)}`)}${article('듀얼픽스 프로 STYLE')}</main>`);
    expect(longBody.failure).toBe('candidate_preparation_limit');
    expect(longBody.truncated).toBe(false);

    const emptyBody = prepare(`<main>${hint}<article><h2></h2></article><article><h2></h2></article></main>`);
    expect(emptyBody.failure).toBe('candidate_evidence_unavailable');
  });

  test('bundle acceptance also works from a literal price or textual wording without pangpang structure', () => {
    const priced = `<main><h1>브라이택스 듀얼픽스 카시트 모음전</h1><article><h2>듀얼픽스 프로 LUX</h2><p>판매가 520,000원</p></article><article><h2>듀얼픽스 프로 STYLE</h2><p>판매가 480,000원</p></article></main>`;
    expect(decide(priced, 'https://shop.example/bundle')).toMatchObject({ accepted: true, code: 'candidate_bundle_deal' });
    const textual = `<main><h1>브라이택스 듀얼픽스 카시트 모음전</h1><article><h2>듀얼픽스 프로 LUX</h2><p>공동 구매 진행</p></article><article><h2>듀얼픽스 프로 STYLE</h2><p>옵션 확인</p></article></main>`;
    expect(decide(textual, 'https://shop.example/bundle')).toMatchObject({ accepted: true, code: 'candidate_bundle_deal' });
    const denied = `<main><h1>브라이택스 듀얼픽스 카시트 모음전</h1><article><h2>듀얼픽스 프로 LUX</h2><p>공구 아님</p></article><article><h2>듀얼픽스 프로 STYLE</h2><p>공구가 480,000원</p></article></main>`;
    expect(decide(denied, 'https://shop.example/bundle')).toMatchObject({ accepted: false, code: 'candidate_no_deal_evidence' });
  });
});

describe('bundle raw validation and source verification', () => {
  test('checked extraction verifies every item independently and keeps the top level price null', () => {
    const { page, raw, checked } = checkFixture();
    expect(raw.gonggu_price).toBe('정보 없음');
    expect(checked.gonggu_price).toBeNull();
    expect(checked.regular_price).toBeNull();
    expect(checked.bundle_title).toBe('브라이택스 듀얼픽스 카시트 3종 모음전');
    expect(checked.bundle_check).toEqual({ version: 'bundle-items@1', item_price_version: ITEM_FACT_VERSION, status: 'verified', region_count: 3, item_count: 3 });
    expect(checked.bundle_items?.map(item => [item.position, item.region_index, item.brand, item.model_match?.model_id, item.price_fact.value])).toEqual([
      [0, 1, 'Britax', 'model-33', 520000],
      [1, 2, 'Britax', 'model-34', 480000],
      [2, 3, 'Britax', 'model-35', 450000],
    ]);
    for (const item of checked.bundle_items!) {
      expect(page.text.slice(item.source_span.start, item.source_span.end)).toBe(item.source_quote);
      const evidence = item.price_fact.evidence;
      if (evidence) expect(page.text.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    }
    expect(isCheckedExtraction(checked)).toBe(true);
    validateCheckedExtraction(checked);
  });

  test('eight items are supported and nine are rejected before verification', () => {
    const { checked } = checkFixture('bundle-page-max.html', 'bundle-completion-max.json');
    expect(checked.bundle_items).toHaveLength(8);
    expect(checked.bundle_check).toMatchObject({ status: 'verified', region_count: 8, item_count: 8 });
    const raw = rawModel('bundle-completion-max.json');
    raw.bundle_items = [...raw.bundle_items, { ...raw.bundle_items[0], region_index: 9 }];
    expect(() => validateExtraction(JSON.stringify(raw), url, '2026-11-10')).toThrow('extraction_result_invalid');
  });

  test('raw items reject extra/missing keys, duplicate regions, marker or newline quotes, privacy text and oversized fields', () => {
    const rejects = (mutate: (raw: RawModel) => void) => {
      const raw = rawModel();
      mutate(raw);
      expect(() => validateExtraction(JSON.stringify(raw), url, '2026-11-10')).toThrow('extraction_result_invalid');
    };
    rejects(raw => { raw.bundle_items[0].extra = 'x'; });
    rejects(raw => { delete raw.bundle_items[0].option_text; });
    rejects(raw => { raw.bundle_items[1].region_index = 1; });
    rejects(raw => { raw.bundle_items[0].source_quote = '듀얼픽스\n프로'; });
    rejects(raw => { raw.bundle_items[0].source_quote = '[[상품 1]] 듀얼픽스 프로 LUX'; });
    rejects(raw => { raw.bundle_items[0].source_quote = '듀얼픽스]] 프로 LUX'; });
    rejects(raw => { raw.bundle_items[0].source_quote = '문의 private@example.org'; });
    rejects(raw => { raw.bundle_items[0].product_name = '가'.repeat(121); });
    rejects(raw => { raw.bundle_items[0].option_text = '가'.repeat(61); });
    rejects(raw => { raw.bundle_items[0].category = 'diaper'; });
    rejects(raw => { raw.bundle_title = '가'.repeat(121); });
    const empty = rawModel();
    empty.bundle_items = [];
    expect(validateExtraction(JSON.stringify(empty), url, '2026-11-10').bundle_items).toBeUndefined();
  });

  test('source quotes must be unique in their own region and item prices never borrow another region', () => {
    const { page } = checkFixture();
    const raw = validateExtraction(completion('bundle-completion.json').content, url, '2026-11-10');
    const items = raw.bundle_items as RawBundleItem[];
    const crossRegion = structuredClone(raw);
    (crossRegion.bundle_items as RawBundleItem[])[0].source_quote = items[1].source_quote;
    expect(() => checkExtraction(crossRegion, page, at)).toThrow('extraction_result_invalid');

    const ambiguousQuote = structuredClone(raw);
    (ambiguousQuote.bundle_items as RawBundleItem[])[0].source_quote = '듀얼픽스';
    expect(() => checkExtraction(ambiguousQuote, page, at)).toThrow('extraction_result_invalid');

    const wrongPrice = structuredClone(raw);
    (wrongPrice.bundle_items as RawBundleItem[])[0].gonggu_price = '999,000원';
    const checked = checkExtraction(wrongPrice, page, at);
    expect(checked.bundle_items?.[0].price_fact).toMatchObject({ value: null, reason: 'not_found' });
    expect(checked.bundle_items?.[1].price_fact.value).toBe(480000);
  });

  test('item price verification treats regular prices as ineligible, detects ambiguity and never reads the page', () => {
    const quote = '듀얼픽스 프로 LUX · 공구가 520,000원 · 정가 690,000원';
    expect(checkItemPrice('520,000원', quote, 100, url)).toMatchObject({ value: 520000, reason: null });
    expect(checkItemPrice('690,000원', quote, 100, url)).toMatchObject({ value: null, reason: 'not_found' });
    expect(checkItemPrice('520,000원', '공구가 520,000원 · 530,000원', 0, url)).toMatchObject({ value: null, reason: 'ambiguous' });
    expect(checkItemPrice('520,000원', '배송비 520,000원', 0, url)).toMatchObject({ value: null, reason: 'not_found' });
    expect(checkItemPrice(null, '공구가 520,000원', 0, url)).toMatchObject({ value: null, reason: 'not_found' });
    const ok = checkItemPrice('520,000원', quote, 100, url);
    expect(ok.value === 520000 && ok.evidence).toMatchObject({ start: 100 + quote.indexOf('520,000원'), source: url });
  });

  test('item count, region indexes and required bundle metadata are structural failures', () => {
    const { page } = checkFixture();
    const raw = validateExtraction(completion('bundle-completion.json').content, url, '2026-11-10');
    const mutate = (fn: (raw: ReturnType<typeof validateExtraction>) => void) => {
      const copy = structuredClone(raw);
      fn(copy);
      expect(() => checkExtraction(copy, page, at)).toThrow('extraction_result_invalid');
    };
    mutate(copy => { copy.bundle_items = (copy.bundle_items as RawBundleItem[]).slice(0, 2); });
    mutate(copy => { (copy.bundle_items as RawBundleItem[])[0].region_index = 4; });
    mutate(copy => { delete copy.bundle_title; (copy.bundle_items as RawBundleItem[])[0].product_name = '가'.repeat(121); });
  });

  test('out-of-scope and non-bundle emissions are dropped with explicit bundle checks', () => {
    const { page, raw } = checkFixture();
    const out = structuredClone(raw);
    out.in_scope = false;
    const outChecked = checkExtraction(out, page, at);
    expect(outChecked.bundle_items).toBeUndefined();
    expect(outChecked.bundle_check).toEqual({ version: 'bundle-items@1', item_price_version: ITEM_FACT_VERSION, status: 'dropped_out_of_scope', region_count: 0, item_count: 0, dropped_count: 3 });
    expect(isCheckedExtraction(outChecked)).toBe(true);

    const single = prepare(fixture('sample-page.txt'), 'https://fixture.example/deepseek-web-sample');
    const nonBundle = structuredClone(raw);
    nonBundle.url = single.url;
    const dropped = checkExtraction(nonBundle, single, at);
    expect(dropped.bundle_items).toBeUndefined();
    expect(dropped.bundle_check).toEqual({ version: 'bundle-items@1', item_price_version: ITEM_FACT_VERSION, status: 'dropped_not_bundle_page', region_count: 0, item_count: 0, dropped_count: 3 });
    expect(isCheckedExtraction(dropped)).toBe(true);
  });

  test('durable checked rows reject tampered spans, brands, models and prices', () => {
    const { checked } = checkFixture();
    const tamper = (fn: (copy: CheckedGongguExtraction) => void) => {
      const copy = structuredClone(checked);
      fn(copy);
      expect(() => validateCheckedExtraction(copy)).toThrow('extraction_result_invalid');
      expect(isCheckedExtraction(copy)).toBe(false);
    };
    tamper(copy => { const item = copy.bundle_items![0]; item.source_span.end += 1; });
    tamper(copy => { copy.bundle_items![0].brand = 'Joie'; });
    tamper(copy => { copy.bundle_items![0].model_status = 'no_match'; });
    tamper(copy => { (copy.bundle_items![0].price_fact as { value: number | null }).value = 1; });
    tamper(copy => { copy.bundle_items![0].source_quote = '바뀐 인용'; });
    tamper(copy => { delete copy.bundle_items; });
  });

  test('durable dropped checks require a count for non-bundle drops only', () => {
    const { checked } = checkFixture();
    const dropped = structuredClone(checked);
    delete dropped.bundle_items;
    dropped.bundle_check = { version: 'bundle-items@1', item_price_version: ITEM_FACT_VERSION, status: 'dropped_not_bundle_page', region_count: 0, item_count: 0 };
    expect(() => validateCheckedExtraction(dropped)).toThrow('extraction_result_invalid');
    expect(isCheckedExtraction(dropped)).toBe(false);
    dropped.bundle_check = { ...dropped.bundle_check, dropped_count: 3 };
    expect(isCheckedExtraction(dropped)).toBe(true);

    const outOfScope = structuredClone(checked);
    delete outOfScope.bundle_items;
    outOfScope.in_scope = false;
    outOfScope.bundle_check = { version: 'bundle-items@1', item_price_version: ITEM_FACT_VERSION, status: 'dropped_out_of_scope', region_count: 0, item_count: 0 };
    expect(isCheckedExtraction(outOfScope)).toBe(true);
  });

  test('model matching is deterministic for variants and ambiguous Joie refiners', () => {
    const item = (product_name: string, source_brand: string | null = 'Britax'): RawBundleItem => ({ region_index: 1, source_brand, product_name, option_text: null, category: 'car_seat', gonggu_price: null, source_quote: product_name });
    expect(matchItemModel(item('듀얼픽스 프로 LUX 카시트'))).toMatchObject({ brand: 'Britax', model_status: 'matched', model_match: { model_id: 'model-33' } });
    expect(matchItemModel(item('듀얼픽스 프로 STYLE 카시트'))).toMatchObject({ model_match: { model_id: 'model-34' } });
    expect(matchItemModel(item('듀얼픽스 프로 CLASSIC 카시트'))).toMatchObject({ model_match: { model_id: 'model-35' } });
    expect(matchItemModel(item('조이 아이스핀 360 카시트', 'Joie'))).toMatchObject({ brand: 'Joie', model_status: 'matched', model_match: { model_id: 'model-23' } });
    expect(matchItemModel(item('Joie 아이스핀 360 메쉬 카시트', 'Joie'))).toMatchObject({ model_match: { model_id: 'model-24' } });
    expect(matchItemModel(item('듀얼픽스 프로 LUX', 'UnknownBrand'))).toEqual({ brand: null, model_match: null, model_status: 'no_match' });
    expect(matchItemModel({ ...item('듀얼픽스 프로 LUX'), category: 'stroller' })).toMatchObject({ model_status: 'no_match' });
    expect(canonicalBrand('브리탁스')).toBe('Britax');
    expect(canonicalBrand('Britax')).toBe('Britax');
    expect(canonicalBrand('듀얼픽스')).toBeNull();
    expect(modelCategory('model-33')).toBe('car_seat');
    expect(modelRefiners('model-33')).toEqual(['프로', 'LUX']);
  });

  test('projected raw bundle rows never claim verified prices', () => {
    const raw = validateExtraction(completion('bundle-completion.json').content, url, '2026-11-10');
    const projected = projectExtraction(raw);
    expect(projected).toMatchObject({ gonggu_price: null, regular_price: null, start_date: null, end_date: null, needs_fact_check: true });
    const first = projected.bundle_items![0];
    expect('gonggu_price' in first && first.gonggu_price).toBeNull();
    const { checked } = checkFixture();
    expect(projectExtraction(checked)).toBe(checked);
  });
});

describe('bundle durability, queue and weekly review', () => {
  test('cache entry validation accepts a verified bundle result and contract includes both versions', () => {
    const page = checkFixture().page;
    const raw = validateExtraction(completion('bundle-completion.json').content, url, '2026-11-10');
    raw.catalog_product_id = 'britax-dualfix';
    const withCatalog = checkExtraction(raw, page, at);
    const contract = 'a'.repeat(64);
    const entry = { version: 2 as const, cache_key: cacheKey(url, withCatalog.fact_check.source_hash, contract), canonical_url: url, content_hash: withCatalog.fact_check.source_hash, contract_hash: contract, candidate: candidateDecision(page, catalog, config), result: withCatalog, extracted_at: withCatalog.fact_check.observed_at, proposal: null, pending_delivery: true };
    expect(validEntry(entry)).toBe(true);
    expect(entry.result.bundle_items).toHaveLength(3);
    const broken = structuredClone(entry);
    broken.result.bundle_items![0].source_span.end += 1;
    expect(validEntry(broken)).toBe(false);
  });

  test('queue delivery treats item-level price or option changes as substantive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-queue-'));
    try {
      const first = checkFixture().checked;
      expect(await enqueueReviewIfNew(dir, first)).toEqual({ enqueued: true });
      const same = checkFixture('bundle-page.html', 'bundle-completion.json', otherUrl).checked;
      expect(await enqueueReviewIfNew(dir, same)).toEqual({ enqueued: false, reason: 'duplicate_offer' });

      const changedHtml = fixture('bundle-page.html').replaceAll('520,000원', '521,000원');
      const changedCompletion = completion('bundle-completion.json').content.replaceAll('520,000원', '521,000원');
      const changedPage = prepare(changedHtml, 'https://09pangpang.com/post/3');
      const changed = checkExtraction(validateExtraction(changedCompletion, 'https://09pangpang.com/post/3', '2026-11-10'), changedPage, at);
      expect(await enqueueReviewIfNew(dir, changed)).toEqual({ enqueued: true });
      const rows = await readQueue(dir);
      expect(rows).toHaveLength(2);
      expect(rows.every(row => isCheckedExtraction(row.extraction))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('weekly review shows verified item prices and models, and warns for unverified items', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-weekly-'));
    try {
      const { checked } = checkFixture();
      const unchecked = validateExtraction(completion('bundle-completion.json').content, otherUrl, '2026-11-10');
      const row = (id: string, extraction: unknown, target: string) => ({ id, status: 'pending', created_at: at, source_kind: 'public_web', verify_level: 'model_extract', extraction: { ...(extraction as object), url: target } });
      writeFileSync(join(dir, 'review-queue.jsonl'), [row('verified', checked, url), row('unverified', unchecked, otherUrl)].map(r => JSON.stringify(r) + '\n').join(''));
      const packet = await weeklyReview(dir, Date.parse(at));
      const verified = packet.deals.find(deal => deal.id === 'verified')!;
      expect(verified.title).toBe('브라이택스 듀얼픽스 카시트 3종 모음전');
      expect(verified.facts.gonggu_price).toBeNull();
      expect(verified.missing_fields).toEqual([]);
      expect(verified.warnings).toEqual([]);
      expect(verified.bundle?.items).toEqual([
        { product_name: '듀얼픽스 프로 LUX 카시트', option_text: '리버티 블랙', brand: 'Britax', category: 'car_seat', model_id: 'model-33', price: 520000, price_reason: null },
        { product_name: '듀얼픽스 프로 STYLE 카시트', option_text: '스톤 그레이', brand: 'Britax', category: 'car_seat', model_id: 'model-34', price: 480000, price_reason: null },
        { product_name: '듀얼픽스 프로 CLASSIC 카시트', option_text: '미드나잇 블루', brand: 'Britax', category: 'car_seat', model_id: 'model-35', price: 450000, price_reason: null },
      ]);
      const unverified = packet.deals.find(deal => deal.id === 'unverified')!;
      expect(unverified.warnings).toEqual(expect.arrayContaining(['needs_fact_check', 'bundle_item_price_missing']));
      expect(unverified.bundle?.items.every(item => item.price === null && item.model_id === null)).toBe(true);
      const text = formatWeeklyReview(packet);
      expect(text).toContain('- Britax 듀얼픽스 프로 LUX 카시트 / 리버티 블랙 · 520,000원 · model-33');
      expect(text).toContain('가격 미확인');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('completion budget is raised to 8192 within the unchanged cap invariant', () => {
    expect(config.budget.max_completion_tokens).toBe(8192);
    expect(config.budget.estimated_prompt_tokens + config.budget.max_completion_tokens).toBe(20192);
    expect(config.budget.max_tokens_per_run).toBe(2000000);
    expect(config.model.profiles.every(profile => profile.max_completion_tokens === 8192)).toBe(true);
  });
});

describe('bundle promotion mapping, CLI forwarding and site rendering', () => {
  test('review mapping folds option text into the item name and keeps verified prices and model ids', () => {
    const { checked } = checkFixture();
    expect(reviewBundleItems(checked)).toEqual([
      { brand: 'Britax', product_name: '듀얼픽스 프로 LUX 카시트 · 리버티 블랙', model_id: 'model-33', price: 520000 },
      { brand: 'Britax', product_name: '듀얼픽스 프로 STYLE 카시트 · 스톤 그레이', model_id: 'model-34', price: 480000 },
      { brand: 'Britax', product_name: '듀얼픽스 프로 CLASSIC 카시트 · 미드나잇 블루', model_id: 'model-35', price: 450000 },
    ]);
    expect(reviewBundleTitle(checked)).toBe('브라이택스 듀얼픽스 카시트 3종 모음전');
    expect(reviewBundleLabels(checked)).toEqual({ brand_label: 'Britax', category_label: 'car_seat' });
    const raw = validateExtraction(completion('bundle-completion.json').content, url, '2026-11-10');
    expect(reviewBundleItems(raw)).toEqual([]);
    expect(reviewBundleTitle(raw)).toBeNull();
    expect(reviewBundleLabels(raw)).toEqual({});
  });

  test('from-review-queue forwards the bundle title, items and labels to ingest and promote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-cli-'));
    try {
      const queue = join(dir, 'review.jsonl'), calls = join(dir, 'calls.jsonl');
      const { checked } = checkFixture();
      writeFileSync(queue, JSON.stringify({ extraction: checked }) + '\n');
      const result = spawnSync(process.execPath, ['--import', './tests/helpers/promotion-child.mjs', 'scripts/promote-external.mjs', `--from-review-queue=${queue}`, '--line=0'], {
        cwd: process.cwd(), env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME, ADMIN_TOKEN: 'fixture-only-admin', INGEST_TOKEN: 'fixture-only-ingest', PROMOTE_API_ORIGIN: 'https://promotion.example', PROMOTION_TEST_CALLS: calls, TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 20000,
      });
      expect(result.status, result.stderr).toBe(0);
      const requests = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { url: string; body: Record<string, unknown> });
      expect(requests).toHaveLength(2);
      expect(requests[0].body).toMatchObject({ title: '브라이택스 듀얼픽스 카시트 3종 모음전', price_hint: null });
      expect(requests[1].body).toMatchObject({ title: '브라이택스 듀얼픽스 카시트 3종 모음전', brand_label: 'Britax', category_label: 'car_seat', model_id: null });
      expect(requests[1].body.bundle_items).toEqual([
        { brand: 'Britax', product_name: '듀얼픽스 프로 LUX 카시트 · 리버티 블랙', model_id: 'model-33', price: 520000 },
        { brand: 'Britax', product_name: '듀얼픽스 프로 STYLE 카시트 · 스톤 그레이', model_id: 'model-34', price: 480000 },
        { brand: 'Britax', product_name: '듀얼픽스 프로 CLASSIC 카시트 · 미드나잇 블루', model_id: 'model-35', price: 450000 },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe('promoteExternalCandidate', () => {
    let memory: ReturnType<typeof memoryD1>;
    beforeAll(async () => {
      memory = memoryD1();
      const dir = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
        for (const statement of migrationStatements(await readFile(new URL(file, dir), 'utf8'))) {
          await memory.db.prepare(statement).run();
        }
      }
      for (const [id, name] of [['model-33', '듀얼픽스 프로 LUX'], ['model-34', '듀얼픽스 프로 STYLE'], ['model-35', '듀얼픽스 프로 CLASSIC']] as const) {
        await memory.db.prepare("INSERT INTO models (id,brand,name,category,importer,official_price,source_url,checked,verify_level,note) VALUES (?, 'Britax', ?, 'car_seat','세피앙',NULL,'','2026-10-01','official_unpublished','')").bind(id, name).run();
      }
      await memory.db.prepare("INSERT INTO external_candidates (id,source,source_url,title,text,seller_handle,seller_name,price_hint,price_raw,captured_at,last_seen_at) VALUES ('bundle-cand','pangpang','https://09pangpang.com/post/1','브라이택스 듀얼픽스 카시트 3종 모음전','공구 모음전','pangpang_seller','샵',NULL,'정보 없음','2026-11-10T00:00:00.000Z','2026-11-10T00:00:00.000Z')").run();
    });
    afterAll(() => memory.close());

    test('creates one deal with per-product rows and renders the bundle list', async () => {
      const { checked } = checkFixture();
      const result = await promoteExternalCandidate(memory.db, {
        candidate_id: 'bundle-cand', promoted_by: 'test-admin', request_id: 'bundle-promote-1', reason: 'bundle promotion fixture',
        title: reviewBundleTitle(checked), ...reviewBundleLabels(checked), model_id: null, bundle_items: reviewBundleItems(checked),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const deal = await memory.db.prepare('SELECT title, price, model_id, brand_label, category_label FROM deals WHERE id = ?').bind(result.deal_id).first<{ title: string; price: number | null; model_id: string | null; brand_label: string | null; category_label: string | null }>();
      expect(deal).toEqual({ title: '브라이택스 듀얼픽스 카시트 3종 모음전', price: null, model_id: null, brand_label: 'Britax', category_label: 'car_seat' });
      const items = await memory.db.prepare('SELECT position, brand, product_name, model_id, price FROM deal_bundle_items WHERE deal_id = ? ORDER BY position').bind(result.deal_id).all<{ position: number; brand: string | null; product_name: string; model_id: string | null; price: number | null }>();
      expect(items.results).toEqual([
        { position: 0, brand: 'Britax', product_name: '듀얼픽스 프로 LUX 카시트 · 리버티 블랙', model_id: 'model-33', price: 520000 },
        { position: 1, brand: 'Britax', product_name: '듀얼픽스 프로 STYLE 카시트 · 스톤 그레이', model_id: 'model-34', price: 480000 },
        { position: 2, brand: 'Britax', product_name: '듀얼픽스 프로 CLASSIC 카시트 · 미드나잇 블루', model_id: 'model-35', price: 450000 },
      ]);
      const dealView = { id: result.deal_id, model_id: null, seller_id: 'seller-fixture', title: deal!.title, price: null, source_url: url, image_url: null, verify_level: 'manual', checked: at, starts_at: null, ends_at: null, origin: 'external_web', source_host: '09pangpang.com', source_ended: 0, brand_label: 'Britax', category_label: 'car_seat', model_joined_id: null, model_name: null, model_official_price: null, model_checked: null, model_verify_level: null, seller_joined_id: null, seller_name: null, seller_registration_source: null, seller_withdrawal_source: null, seller_official_import_source: null } satisfies DealWithContext;
      const html = renderToStaticMarkup(createElement(DealDetail, { deal: dealView, nowMs: Date.parse(at), bundleItems: items.results.map((item, index) => ({ id: `item-${index}`, deal_id: result.deal_id, ...item })) }));
      expect(html).toContain('듀얼픽스 프로 LUX 카시트 · 리버티 블랙');
      expect(html).toContain('520,000');
      expect(html).toContain('/models/model-33');
    });
  });
});
