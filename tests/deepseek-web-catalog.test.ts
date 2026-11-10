import { describe, expect, test } from 'vitest';
import { loadGeunbonCatalog, matchCatalogProduct, nextCatalogSearch, rankListingCandidates, classifyCatalogScope } from '../crawler/src/deepseek-web/catalog';
import { planPangpangPage } from '../crawler/src/deepseek-web/source-select';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PangpangProduct } from '../crawler/lib/external/pangpang';

describe('geunbon catalog', () => {
  const catalog = loadGeunbonCatalog();
  test('seed includes bouncer and carrier iconic lines', () => {
    expect(catalog.products.some(p => p.id === 'babybjorn-bouncer-bliss')).toBe(true);
    expect(catalog.products.some(p => p.id === 'artipoppe-zeitgeist')).toBe(true);
    expect(catalog.products.length).toBeGreaterThanOrEqual(10);
  });
  test('round-robin search cursor advances across catalog terms', () => {
    const a = nextCatalogSearch(catalog, 0);
    const b = nextCatalogSearch(catalog, a!.next_cursor);
    expect(a!.url).not.toBe(b!.url);
    expect(a!.url).toMatch(/^https:\/\/09pangpang\.com\/search\/r\//);
  });
  test('listing detail rotation follows the configured category order and cursor', () => {
    const item = (title: string, index: number): PangpangProduct => ({
      source_url: `https://09pangpang.com/post/${920000 + index}`,
      title, text: '', category_text: '키즈 > 유아용품', price: null, dates: null,
      seller_handle: null, seller_url: null, seller_name: null, locator: '', link_index: null,
    });
    const products = [item('부가부 폭스 유모차', 0), item('아티포페 아기띠', 1)];
    const categoryOrder = ['carrier', 'stroller', 'high_chair', 'car_seat', 'play_gym', 'bouncer'] as const;
    const first = rankListingCandidates(products, catalog, 2, 'https://09pangpang.com/search/r/fixture', { categoryCursor: 0, categoryOrder: [...categoryOrder] });
    expect(first.enqueue.map(row => row.category)).toEqual(['carrier', 'stroller']);
    const second = rankListingCandidates(products, catalog, 2, 'https://09pangpang.com/search/r/fixture', { categoryCursor: 1, categoryOrder: [...categoryOrder] });
    expect(second.enqueue.map(row => row.category)).toEqual(['stroller', 'carrier']);
  });
  test('listing detail scheduling round-robins categories instead of draining strollers first', () => {
    const item = (title: string, index: number): PangpangProduct => ({
      source_url: `https://09pangpang.com/post/${900000 + index}`,
      title, text: '', category_text: '키즈 > 유아용품', price: null, dates: null,
      seller_handle: null, seller_url: null, seller_name: null, locator: '', link_index: null,
    });
    const products = [
      item('부가부 폭스 유모차', 0), item('부가부 폭스 유모차', 1), item('부가부 폭스 유모차', 2), item('부가부 폭스 유모차', 3),
      item('아티포페 아기띠', 4), item('아티포페 아기띠', 5), item('베이비뵨 블리스 바운서', 6),
    ];
    const plan = rankListingCandidates(products, catalog, 3, 'https://09pangpang.com/search/r/fixture');
    expect(plan.enqueue).toHaveLength(3);
    expect(new Set(plan.enqueue.map(row => row.category)).size).toBe(3);
    expect(plan.rollup.scoped).toBe(7);
    expect(plan.by_category.stroller).toBe(4);
  });
  test('matches Artipoppe carrier title; excludes accessory mock', () => {
    const carrier = matchCatalogProduct({ title: '아티포페 제이트가이스트 아기띠', category_text: '키즈 > 육아용품', text: '' }, catalog);
    expect(carrier?.product_id).toBe('artipoppe-zeitgeist');
    const accessory = classifyCatalogScope({ title: '미니두두 VER.2', category_text: '키즈 > 육아용품', text: '' }, catalog);
    expect(accessory.kind).toBe('accessory_or_broad');
  });
  test('육아템 search fixture: 30 raw, 0 catalog-scoped (real HTML)', () => {
    const html = readFileSync(join(process.cwd(), 'tests/fixtures/external/pangpang/search-yugatem.html'), 'utf8');
    const plan = planPangpangPage(html, 'https://09pangpang.com/search/r/%EC%9C%A1%EC%95%84%ED%85%9C', new Date(), loadDeepSeekWebConfig());
    if (plan.kind !== 'listing') throw new Error('expected listing');
    expect(plan.raw_product_count).toBe(30);
    expect(plan.scoped_candidate_count).toBe(0);
    expect(plan.zero_reason).toBe('scope_no_core');
  });
  test('synthetic core stroller card enqueues with catalog id', () => {
    const html = `<div><a data-feed-index="0" href="/post/900100"><p class="line-clamp-2">부가부 폭스 유모차</p></a><span class="text-category">키즈 &gt; 유모차</span></div>`;
    const plan = planPangpangPage(html, 'https://09pangpang.com/search/r/%EC%9C%A0%EB%AA%A8%EC%B0%A8', new Date(), loadDeepSeekWebConfig());
    if (plan.kind !== 'listing') throw new Error('expected listing');
    expect(plan.scoped_candidate_count).toBe(1);
    expect(plan.enqueue_catalog[0]?.catalog_product_id).toBe('bugaboo-fox');
  });
});
