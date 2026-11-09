import { describe, expect, test } from 'vitest';
import { loadGeunbonCatalog, matchCatalogProduct, nextCatalogSearch, classifyCatalogScope } from '../crawler/src/deepseek-web/catalog';
import { planPangpangPage } from '../crawler/src/deepseek-web/source-select';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
