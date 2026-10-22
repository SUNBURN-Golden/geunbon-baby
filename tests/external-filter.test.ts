import { expect, test } from 'vitest';
import { buildPayload, isBabyItem, maskPersonal, TEXT_MAX, TITLE_MAX } from '../crawler/lib/external/filter';
import type { ParsedItem } from '../crawler/lib/external/parse';

const base = (overrides: Partial<ParsedItem> = {}): ParsedItem => ({
  source_url: 'https://09pangpang.com/deal/1', title: '스토케 트립트랩 공구', text: '스토케 트립트랩 공구\n390,000원', category_text: '',
  price: { value: 390000, raw: '390,000원' }, dates: { starts_at: '2026-10-26T00:00:00+09:00', ends_at: '2026-10-28T23:59:59+09:00', raw: '10/26~10/28', confidence: 0.85 },
  seller_handle: 'seller', seller_url: 'https://www.instagram.com/seller/', ...overrides,
});
const now = new Date('2026-10-22T00:30:00Z');

test('non-baby items and diaper/formula items are not sent', () => {
  expect(buildPayload('pangpang', base({ title: '뷰티 클렌징 폼 공구', text: '뷰티 클렌징 폼 공구 12,000원' }), now)).toBeNull();
  expect(buildPayload('pangpang', base({ title: '유아용품 기저귀 공구', text: '유아용품 기저귀 공구 29,900원' }), now)).toBeNull();
  expect(buildPayload('pangpang', base({ title: '아기 분유 공구', text: '아기 분유 공구 29,900원' }), now)).toBeNull();
  expect(isBabyItem({ title: '캠핑 의자 공구', text: '', category_text: '' })).toBe(false);
});

test('baby keywords, category text and seed model matches pass', () => {
  expect(isBabyItem({ title: '신생아 속싸개 공구', text: '', category_text: '' })).toBe(true);
  expect(isBabyItem({ title: '특가 오픈', text: '', category_text: '유아용품' })).toBe(true);
  const payload = buildPayload('pangpang', base(), now)!;
  expect(payload).toMatchObject({ kind: 'external_listing', source: 'pangpang', account: 'pangpang', model_match: true, price_hint: 390000, price_basis: 'external_listing', captured_at: '2026-10-22T00:30:00.000Z' });
  expect(payload.category).toBe('high_chair');
  expect(payload.text).toBe('스토케 트립트랩 공구 / 기간 10/26~10/28 / 가격 390,000원 / 셀러 @seller');
  expect(payload.suggestions.models.length).toBeGreaterThan(0);
});

test('a generic baby keyword without a seed model is sent with model_match false', () => {
  const payload = buildPayload('momcalendar', base({ title: '신생아 속싸개 공구' }), now)!;
  expect(payload.model_match).toBe(false);
  expect(payload.category).toBeNull();
});

test('personal details are masked in both title and text', () => {
  const dirty = '유모차 공구 문의 010-1234-5678 mom@example.invalid 36개월 아기 지유이 엄마 후기 02-123-4567 123456-1234567 돌 아기';
  const masked = maskPersonal(dirty);
  for (const leak of ['010-1234', 'mom@example', '36개월', '지유이 엄마', '02-123', '123456-1234567', '돌 아기']) expect(masked).not.toContain(leak);
  const payload = buildPayload('pangpang', base({ title: dirty, seller_handle: null, seller_url: null }), now)!;
  for (const field of [payload.title, payload.text]) {
    for (const leak of ['010-1234', 'mom@example', '36개월', '지유이 엄마']) expect(field).not.toContain(leak);
  }
});

test('masking keeps prices, dates and product words intact', () => {
  expect(maskPersonal('390,000원 10/26~10/28 2026-10-26 1세트 6세 이상')).toBe('390,000원 10/26~10/28 2026-10-26 1세트 [아이 나이] 이상');
});

test('title is capped at 200 characters and text at 2,000; payload never carries an image URL', () => {
  const payload = buildPayload('pangpang', base({ title: `유모차 ${'가'.repeat(500)}` }), now)!;
  expect(payload.title.length).toBeLessThanOrEqual(TITLE_MAX);
  expect(payload.text.length).toBeLessThanOrEqual(TEXT_MAX);
  expect('image_url' in payload).toBe(false);
  expect(JSON.stringify(payload)).not.toMatch(/image|\.jpg|\.png/i);
});

test('an inverted date range is dropped rather than sent', () => {
  const payload = buildPayload('pangpang', base({ dates: { starts_at: '2026-10-28T00:00:00+09:00', ends_at: '2026-10-26T23:59:59+09:00', raw: 'x', confidence: 0.5 } }), now)!;
  expect(payload.starts_at).toBeNull();
  expect(payload.ends_at).toBeNull();
});
