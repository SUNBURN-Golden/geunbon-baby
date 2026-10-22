import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseItems, parseHtml, selectAll } from '../crawler/lib/external/parse';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/external/${name}`, import.meta.url), 'utf8');
const now = new Date('2026-10-22T00:00:00+09:00');

test('pangpang: title, price, dates, seller and same-origin links; scripts and cross-origin links are ignored', () => {
  const items = parseItems(fixture('pangpang.html'), 'https://09pangpang.com/search/r/%EC%9C%A1%EC%95%84%ED%85%9C', 'https://09pangpang.com', '', now);
  const urls = items.map(item => item.source_url);
  expect(urls).toContain('https://09pangpang.com/deal/101?utm_source=ad&id=7');
  expect(urls).toContain('https://09pangpang.com/deal/102');
  expect(urls.some(url => !url.startsWith('https://09pangpang.com/'))).toBe(false);
  expect(urls.some(url => url.includes('/api/'))).toBe(false);
  const first = items.find(item => item.source_url.includes('/deal/101'))!;
  expect(first.title).toContain('스토케 트립트랩 공구');
  expect(first.price).toMatchObject({ value: 390000 });
  expect(first.dates?.starts_at).toMatch(/^2026-10-26T00:00:00\+09:00$/);
  expect(first.dates?.ends_at).toMatch(/^2026-10-28T23:59:59\+09:00$/);
  expect(first.seller_handle).toBe('synthetic_seller');
  expect(first.seller_url).toBe('https://www.instagram.com/synthetic_seller/');
  expect(first.category_text).toContain('하이체어');
  expect(JSON.stringify(items)).not.toContain('kid.jpg');
});

test('relative links resolve against the page URL and only against the origin', () => {
  const items = parseItems('<ul><li><a href="detail?id=1">트립트랩 공구 390,000원</a></li><li><a href="//evil.example.invalid/x">공구 120,000원</a></li></ul>', 'https://09pangpang.com/list/page', 'https://09pangpang.com');
  expect(items.map(item => item.source_url)).toEqual(['https://09pangpang.com/list/detail?id=1']);
});

test('momcalendar articles parse with a month-day range', () => {
  const items = parseItems(fixture('momcalendar.html'), 'https://momcalendar.com/', 'https://momcalendar.com', '', now);
  const hit = items.find(item => item.source_url === 'https://momcalendar.com/events/55/')!;
  expect(hit.price?.value).toBe(549000);
  expect(hit.dates?.starts_at).toBe('2026-10-26T00:00:00+09:00');
  expect(hit.dates?.ends_at).toBe('2026-10-28T23:59:59+09:00');
});

test('snapup table rows parse; a row without a numeric price keeps price null', () => {
  const items = parseItems(fixture('snapup.html'), 'https://snapup.co.kr/influencer/calendar', 'https://snapup.co.kr', '', now);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ source_url: 'https://snapup.co.kr/influencer/calendar/9001', seller_handle: 'synthetic.shop' });
  expect(items[0].price?.value).toBe(1090000);
  expect(items[1].price).toBeNull();
});

test('configured item_selector wins over the heuristic and reads rendered DOM prices as numbers', () => {
  const items = parseItems(fixture('buyg-rendered.html'), 'https://buyg.kr/', 'https://buyg.kr', 'div.item', now);
  expect(items.map(item => item.price?.value)).toEqual([1590000, 139000]);
  expect(items[0].category_text).toBe('유아동');
});

test('selectors support tag, class, id, attribute, descendant and comma lists; unsupported syntax throws', () => {
  const root = parseHtml('<div id="a" class="x y"><p class="y" data-k="v">1</p><span>2</span></div><b>3</b>');
  expect(selectAll(root, '.x .y').length).toBe(1);
  expect(selectAll(root, '#a p').length).toBe(1);
  expect(() => selectAll(root, '#a > p')).toThrow();
  expect(selectAll(root, 'p[data-k=v], b').length).toBe(2);
  expect(() => selectAll(root, 'div:first-child')).toThrow();
});
