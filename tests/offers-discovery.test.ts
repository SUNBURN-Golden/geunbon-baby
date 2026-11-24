import { expect, test } from 'vitest';
import { catalogMatch, catalogSnapshot, discoveryLinks, emptyExtraction, prepareProductRegions } from '../crawler/src/offers/evidence';
import { loadGeunbonCatalog } from '../crawler/src/deepseek-web/catalog';
import { offerUrl } from '../shared/verified-offer';
import { models } from '../seed/models.json';

test('public discovery retains product query identity and seller links across discovery sources', () => {
  const tag = 'https://www.threads.net/search?q=육아공구';
  const links = discoveryLinks(`<main><a href="/@seller">브랜드 멘션</a>
    <a href="https://linktr.ee/seller">공구 모음</a><a href="https://pf.kakao.com/seller">카카오</a>
    <a href="https://smartstore.naver.com/seller/products/100">스마트스토어</a>
    <a href="https://gonggumoa.com/product?product_no=42">판매처</a>
    <a href="https://momcalendar.com/product?product_no=43">판매처</a>
    <a href="https://www.stokke.com/notice">공식 공구</a></main>`, tag);
  expect(links.map(link => link.destination)).toEqual([
    'https://www.threads.net/@seller','https://linktr.ee/seller','https://pf.kakao.com/seller',
    'https://smartstore.naver.com/seller/products/100','https://gonggumoa.com/product?product_no=42',
    'https://momcalendar.com/product?product_no=43','https://www.stokke.com/notice',
  ]);
  expect(offerUrl(tag)).toContain('q=');
  expect(offerUrl('https://seller.example.com/?token=fixture')).toBeNull();
  expect(offerUrl('https://seller.example.com/?product_no=42')).not.toBe(offerUrl('https://seller.example.com/?product_no=43'));
});

test('keeps each sibling image and scope beyond the previous eight items and matches a production play gym', () => {
  const url = 'https://seller.example.com/round';
  const markup = Array.from({ length: 12 }, (_, i) => `<section data-product>
    <h2>${i === 9 ? 'Lovevery The Play Gym' : 'Stokke 모델 ' + i}</h2>
    <p>공구가: ${i + 1}0000원</p><img src="/offers/${i}.jpg">
    <a href="/shop" rel="seller">판매처</a>
    </section>`).join('');
  const regions = prepareProductRegions('<main>' + markup + '<p data-scope="all-products">마감일: 2026-10-28까지</p></main>', url);
  expect(regions).toHaveLength(12);
  expect(new Set(regions.map(row => row.locator)).size).toBe(12);
  const tenth = regions[9];
  expect(tenth).toMatchObject({ image: 'https://seller.example.com/offers/9.jpg',
    sellers: ['https://seller.example.com/shop'], source: url });
  expect(tenth.text).toContain('마감일: 2026-10-28까지');
  expect(tenth.text).not.toContain('Stokke');
  const catalog = catalogSnapshot(models.map((m, i) => ({ ...m, id: 'model-' + (i + 1), name: m.model })));
  const metadata = { ...emptyExtraction, brand: { value: 'Lovevery', quote: 'Lovevery The Play Gym' },
    model: { value: 'The Play Gym', quote: 'Lovevery The Play Gym' } };
  expect(catalogMatch(metadata, tenth, catalog, loadGeunbonCatalog()).model?.id).toBe('model-43');
});

test('Threads exact post uses only the author-bound visible post region', () => {
  const same = `<article data-post-id="135" data-author="seller"><section data-post-body><p>공구가: 390,000원</p></section></article>`;
  const different = same.replace('135', '999').replace('390,000', '100,000');
  const [region] = prepareProductRegions(same + different, 'https://www.threads.net/@seller/post/135');
  expect(region.text).toContain('390,000');
  expect(region.text).not.toContain('100,000');
  expect(region.sellers).toEqual(['https://www.threads.net/@seller']);
});
