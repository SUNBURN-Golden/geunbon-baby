import { describe, expect, test } from 'vitest';
import { normalizeExtraction, parseModelJson } from '../crawler/src/deepseek-web/extract';
import { UNKNOWN } from '../crawler/src/deepseek-web/types';
describe('deepseek-web extraction schema', () => {
  test('unknown price becomes 정보 없음', () => {
    const row = normalizeExtraction({ brand: 'Nuna', model: '피파', gonggu_price: null, in_scope: false }, 'https://example.com/x', '2026-10-20');
    expect(row.gonggu_price).toBe(UNKNOWN);
    expect(row.regular_price).toBe(UNKNOWN);
  });
  test('parses fenced json from model output', () => {
    const raw = parseModelJson('설명\n```json\n{"brand":"Stokke","model":"Tripp Trapp","in_scope":true}\n```');
    expect(raw.brand).toBe('Stokke');
  });
});
