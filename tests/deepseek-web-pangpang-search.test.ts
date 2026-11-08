import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { planPangpangPage } from '../crawler/src/deepseek-web/source-select';
import { canonicalUrl } from '../shared/privacy-rules';
import { pangpangQueryAllowed } from '../crawler/lib/external/pangpang';

const SEARCH_URL = 'https://09pangpang.com/search/r/%EC%9C%A1%EC%95%84%ED%85%9C';
const html = () => readFileSync(join(process.cwd(), 'tests/fixtures/external/pangpang/search-yugatem.html'), 'utf8');

describe('pangpang 육아템 search (public fixture)', () => {
  const config = loadDeepSeekWebConfig();
  test('canonicalUrl accepts public search tracking on post links', () => {
    const raw = 'https://09pangpang.com/post/859983?pid=731682&source=search';
    expect(pangpangQueryAllowed(new URL(raw))).toBe(true);
    expect(canonicalUrl(raw)).toBe('https://09pangpang.com/post/859983');
  });
  test('parser sees 30 products; scope finds 0 core (accessories/broad)', () => {
    const plan = planPangpangPage(html(), SEARCH_URL, new Date('2026-11-08T05:17:29Z'), config);
    expect(plan.kind).toBe('listing');
    if (plan.kind !== 'listing') return;
    expect(plan.raw_product_count).toBe(30);
    expect(plan.scoped_candidate_count).toBe(0);
    expect(plan.enqueue).toHaveLength(0);
    expect(plan.zero_reason).toBe('scope_no_core');
    expect(plan.scope_counts.accessory_or_broad + plan.scope_counts.outside_scope).toBe(30);
    expect(plan.parser_outcome_counts.accepted_product).toBe(30);
  });
  test('suggests permitted core public search URLs (not private API)', () => {
    const plan = planPangpangPage(html(), SEARCH_URL, new Date('2026-11-08T05:17:29Z'), config);
    if (plan.kind !== 'listing') return;
    expect(plan.suggested_searches.length).toBeGreaterThan(0);
    for (const url of plan.suggested_searches) {
      expect(url).toMatch(/^https:\/\/09pangpang\.com\/search\/r\//);
      expect(url).not.toMatch(/\/api\/|\/admin\/|\/my\/|\/auth/);
    }
    expect(plan.suggested_searches).toContain('https://09pangpang.com/search/r/%EC%9C%A0%EB%AA%A8%EC%B0%A8');
  });
});
