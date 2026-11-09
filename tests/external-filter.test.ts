import { expect, test } from 'vitest';
import { buildPayload, eligibilityReason, eligibilitySignals, evaluatePayload, isBabyItem, maskPersonal, TEXT_MAX, TITLE_MAX } from '../crawler/lib/external/filter';
import { extractModels } from '../crawler/lib/extract';
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


test.each(['트레이닝', '실내 점프 트레이닝', 'unbalanced', '요요현상', '조이스틱', '트립트랩과자', '요요3현상'])(
  'incidental alias in %s supplies no model evidence or eligibility', title => {
    const item = base({ title, text: title });
    expect(extractModels(title)).toEqual([]);
    expect(eligibilitySignals(item)).toMatchObject({keyword_match:false, model_threshold_match:false, has_model_category:false});
    expect(evaluatePayload('pangpang', item, now)).toEqual({accepted:false, reason:'not_baby_item'});
  },
);

test.each(['트레이', 'tray', 'baby set', '배시넷', '범퍼바', '섀시', '뉴본', '너도밤나무', 'LUX', '스토케', '스토케코리아', '스토케 트레이', 'Stokke tray', '스토케 폭스5'])(
  'weak evidence %s cannot pass the inclusive model threshold', title => {
    const item = base({title, text:title});
    expect(extractModels(title).every(m => m.confidence < 0.75)).toBe(true);
    expect(eligibilitySignals(item).model_threshold_match).toBe(false);
    // Latin baby set continues to use the existing baby-keyword path.
    expect(eligibilityReason(item)).toBe(title === 'baby set' ? null : 'not_baby_item');
    const payload = buildPayload('pangpang', {...item, category_text:'육아용품'}, now)!;
    expect(payload).toMatchObject({model_match:false, category:null});
    expect(payload.suggestions.models).toEqual(extractModels(title));
  },
);

test('baby keywords keep incidental substring listings eligible without assigning a category', () => {
  const payload = buildPayload('pangpang', base({title:'아기 실내 점프 트레이닝', text:''}), now)!;
  expect(payload).toMatchObject({model_match:false, category:null});
  expect(payload.suggestions.models).toEqual([]);
});

test('title and category are independent matching spans with deterministic merged suggestions', () => {
  for (const [title, category_text] of [['트립', '트랩'], ['부가부', '폭스'], ['스토케', '트레이']]) {
    const item = base({title, category_text, text:''});
    expect(eligibilitySignals(item).model_threshold_match).toBe(false);
    expect(eligibilityReason(item)).toBe('not_baby_item');
  }
  const categoryOnly = buildPayload('pangpang', base({title:'특가', category_text:'트립트랩', text:''}), now)!;
  expect(categoryOnly).toMatchObject({model_match:true, category:'high_chair'});
  expect(categoryOnly.suggestions.models).toEqual(extractModels('트립트랩'));
  const both = buildPayload('pangpang', base({title:'트립트랩', category_text:'요요3', text:''}), now)!;
  expect(both.suggestions.models.some(m => m.model_id === 'model-1')).toBe(true);
  expect(both.suggestions.models.some(m => m.model_id === 'model-7')).toBe(true);
  expect(both.suggestions.models).toHaveLength(8);
  // Mean of model 0.80, primary price 0.90 and period 0.95, rounded.
  expect(both.suggestions.confidence).toBe(0.88);
  expect(categoryOnly.suggestions.confidence).toBe(0.88);
});

test.each(['아기 실내 점프 트레이닝', '아기 폭스', '트립트랩'])(
  'model-like metadata cannot change title/category evidence for %s', title => {
    const item = base({title, text:'', seller_handle:null, seller_url:null});
    const original = buildPayload('pangpang', item, now)!;
    expect(original.suggestions.confidence).toBe(title === '트립트랩' ? 0.88 : title === '아기 폭스' ? 0.78 : 0.93);
    for (const metadata of [
      {seller_handle:'트립트랩', seller_name:'부가부 폭스5', seller_url:'https://example.test/priam'},
      {seller_handle:'부가부 폭스5', seller_name:'스토케', source_url:'https://example.test/tripptrapp'},
      {text:'스토케 트립트랩 베이비세트 트레이'},
      {price:{value:390000, raw:'390,000원 트립트랩'}, dates:{...item.dates!, raw:'10/26~10/28 폭스5'}},
    ]) {
      const payload = buildPayload('pangpang', {...item, ...metadata}, now)!;
      expect(payload.suggestions.models).toEqual(original.suggestions.models);
      expect(payload.model_match).toBe(original.model_match);
      expect(payload.category).toBe(original.category);
      expect(payload.suggestions.confidence).toBe(original.suggestions.confidence);
    }
  },
);

test.each(['기저귀', '분유', 'diaper', 'formula'])(
  'exclusion %s wins over a genuine model in every exclusion field', excluded => {
    for (const field of ['title', 'category_text', 'text'] as const) {
      const item = base({[field]:`${field === 'title' ? '트립트랩 ' : ''}${excluded}`});
      expect(eligibilitySignals(item).model_threshold_match).toBe(true);
      expect(eligibilityReason(item)).toBe('excluded_category');
      expect(evaluatePayload('pangpang', item, now)).toEqual({accepted:false, reason:'excluded_category'});
    }
  },
);

test('rejection order keeps empty normalized titles last', () => {
  expect(evaluatePayload('pangpang', base({title:' ', category_text:'', text:''}), now)).toEqual({accepted:false, reason:'not_baby_item'});
  expect(evaluatePayload('pangpang', base({title:' ', category_text:'유모차', text:'분유'}), now)).toEqual({accepted:false, reason:'excluded_category'});
  expect(evaluatePayload('pangpang', base({title:' ', category_text:'유모차', text:''}), now)).toEqual({accepted:false, reason:'empty_title'});
});
