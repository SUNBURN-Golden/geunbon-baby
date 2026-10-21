import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, extractDates, extractLinks, extractModels, extractPrices, toSuggestions } from '../crawler/lib/extract';

// 기준 시각: 모든 날짜 테스트를 결정적으로 만든다(KST 기준).
const NOW = new Date('2026-10-21T09:00:00+09:00');

test('전형적인 트립트랩 공구 캡션: 모델·공구가·기간·프로필 링크', () => {
  const caption = [
    '스토케 트립트랩 너도밤나무 공구 열립니다📦',
    '공구가 390,000원 (정가 430,000원)',
    '공구기간 10/26~10/28',
    '자세한 건 프로필 링크 확인해 주세요!',
  ].join('\n');
  const out = extract(caption, { now: NOW });
  assert.equal(out.models[0].model_id, 'model-1'); // 너도밤나무 변형이 1순위
  assert.equal(out.models[0].brand, 'Stokke');
  assert.ok(out.models[0].confidence >= 0.9);
  assert.equal(out.price?.value, 390000); // 공구가가 정가를 이긴다
  assert.equal(out.dates?.starts_at, '2026-10-26T00:00:00+09:00');
  assert.equal(out.dates?.ends_at, '2026-10-28T23:59:59+09:00');
  assert.ok(out.dates && out.dates.confidence >= 0.9);
  assert.ok(out.links.some(l => l.kind === 'link_in_bio'));
});

test('만원 표기와 M월 D일 범위, 할인 화살표', () => {
  const out = extract('부가부 폭스5 리뉴\n정가 234만원 → 공구가 199만원\n11월 2일부터 11월 5일까지', { now: NOW });
  assert.equal(out.price?.value, 1990000);
  assert.ok(out.models.some(m => m.brand === 'Bugaboo' && m.name.includes('폭스5')));
  assert.equal(out.dates?.starts_at, '2026-11-02T00:00:00+09:00');
  assert.equal(out.dates?.ends_at, '2026-11-05T23:59:59+09:00');
});

test('39.9만 소수 만원 표기와 오전/오후 시각', () => {
  const out = extract('싸이벡스 제로나 T 카시트\n39.9만원\n오픈 10/30 오전 10시', { now: NOW });
  assert.equal(out.price?.value, 399000);
  assert.ok(out.models.some(m => m.brand === 'Cybex' && m.name.includes('제로나')));
  assert.equal(out.dates?.starts_at, '2026-10-30T10:00:00+09:00');
  assert.equal(out.dates?.ends_at, null);
});

test('만천원 혼합 표기(62만8천원)와 마감일', () => {
  const out = extract('조이 아이스핀 360 공동구매 62만 8천원!\n마감 12/1', { now: NOW });
  assert.equal(out.price?.value, 628000);
  assert.ok(out.models.some(m => m.brand === 'Joie' && m.name.includes('아이스핀')));
  assert.equal(out.dates?.ends_at, '2026-12-01T23:59:59+09:00');
  assert.equal(out.dates?.starts_at, null);
});

test('OCR 노이즈: 줄바꿈으로 쪼개진 모델명·가격도 붙여서 해석', () => {
  const out = extract('ADS\n트립\n트랩\n390,000\n10/26-10/29', { now: NOW });
  assert.ok(out.models.some(m => m.name.includes('트립트랩')));
  assert.equal(out.price?.value, 390000);
  assert.equal(out.dates?.starts_at, '2026-10-26T00:00:00+09:00');
  assert.equal(out.dates?.ends_at, '2026-10-29T23:59:59+09:00');
});

test('OCR 노이즈: 가격 숫자 중간 공백("390,0 00원") 붙이기', () => {
  const { primary } = extractPrices('트립트랩 공구가 390,0 00원');
  assert.equal(primary?.value, 390000);
});

test('범위 가격은 후보 두 개를 모두 남긴다', () => {
  const { prices } = extractPrices('공구가 39만원~42만원 선착순');
  assert.deepEqual(prices.map(p => p.value).sort((a, b) => a - b), [390000, 420000]);
});

test('배송비·정가 옆의 진짜 공구가를 고른다', () => {
  assert.equal(extractPrices('공구가 129,000원 / 배송비 3,000원').primary?.value, 129000);
  assert.equal(extractPrices('원가 150,000원 공구가 98,000원').primary?.value, 98000);
});

test('모델 언급이 없으면 모델 후보를 만들지 않는다', () => {
  assert.deepEqual(extractModels('아가 목도리 수제공구 15,000원'), []);
  const out = extract('아가 목도리 수제공구 15,000원\n기간 10/24~10/26', { now: NOW });
  assert.deepEqual(out.models, []);
  assert.equal(out.price?.value, 15000);
});

test('가격·일정이 없으면 null (추측하지 않는다)', () => {
  const out = extract('스토케 공구 준비 중! 곧 좋은 소식 전해드릴게요 😊', { now: NOW });
  assert.equal(out.price, null);
  assert.equal(out.dates, null);
  assert.ok(out.models.length > 0 && out.models[0].confidence <= 0.5);
});

test('날짜처럼 보이는 것·URL 속 숫자를 가격/날짜로 오인하지 않는다', () => {
  const out = extract('2박 3일 여행 다녀왔어요 1+1 이벤트는 아니고요\n후기: https://blog.example.com/2026/10/16/sale-390000', { now: NOW });
  assert.equal(out.dates, null);
  assert.equal(out.price, null);
  assert.equal(out.links[0].url, 'https://blog.example.com/2026/10/16/sale-390000');
});

test('단일 날짜는 낮은 신뢰도로 시작일 후보만', () => {
  const dates = extractDates('10/30 오픈', NOW);
  assert.equal(dates?.starts_at, '2026-10-30T00:00:00+09:00');
  assert.equal(dates?.ends_at, null);
  assert.ok(dates && dates.confidence <= 0.6);
});

test('연말 게시의 1/2는 다음 해로 해석한다', () => {
  const yearEnd = new Date('2026-12-28T12:00:00+09:00');
  assert.equal(extractDates('1/2 오픈!', yearEnd)?.starts_at, '2027-01-02T00:00:00+09:00');
  const newYear = new Date('2027-01-05T12:00:00+09:00');
  assert.equal(extractDates('12/28 마감', newYear)?.ends_at, '2026-12-28T23:59:59+09:00');
});

test('YYYY/MM/DD와 요일·시간 표기', () => {
  const dates = extractDates('2026/11/3(화) 오후 8시 오픈', NOW);
  assert.equal(dates?.starts_at, '2026-11-03T20:00:00+09:00');
});

test('시드 밖 브랜드 가격도 가격 후보로는 잡는다', () => {
  const out = extract('D.THRONE 이니셜 유모차 조기예약 109만원', { now: NOW });
  assert.equal(out.price?.value, 1090000);
  assert.ok(out.models.some(m => m.brand === 'D.THRONE'));
});

test('두 모델이 함께 언급되면 둘 다 후보로', () => {
  const models = extractModels('트립트랩과 요요3 함께 공구합니다');
  assert.ok(models.some(m => m.name.includes('트립트랩')));
  assert.ok(models.some(m => m.name.includes('요요3')));
});

test('스토리 OCR: 요일·시간·까지 표기가 섞인 짧은 텍스트', () => {
  const out = extract('트립트랩\n398,000\n11/3(화) 저녁 8시까지', { now: NOW });
  assert.equal(out.price?.value, 398000);
  assert.equal(out.dates?.ends_at?.slice(0, 10), '2026-11-03');
});

test('구매 링크는 링크 후보로, 프로필 안내 문구는 link_in_bio 로', () => {
  const links = extractLinks('구매 여기서↓ https://smartstore.example.com/tripp/1029 오픈!\n나머지는 프로필 링크 참고');
  assert.deepEqual(links.filter(l => l.kind === 'url').map(l => l.confidence >= 0.9), [true]);
  assert.ok(links.some(l => l.kind === 'link_in_bio' && l.url === ''));
});

test('toSuggestions 는 검수 API 스키마로 좁힌다', () => {
  const suggestion = toSuggestions(extract('스토케 트립트랩 공구가 390,000원\n10/26~10/28', { now: NOW }));
  assert.deepEqual(Object.keys(suggestion).sort(), ['confidence', 'dates', 'links', 'models', 'price']);
  assert.ok(suggestion.price && suggestion.price.value === 390000 && 'source_line' in suggestion.price === false);
  assert.ok(suggestion.dates && suggestion.dates.starts_at && suggestion.dates.ends_at);
});

test('같은 입력에는 항상 같은 결과(순수 함수)', () => {
  const caption = '스토케 트립트랩 너도밤나무 390,000원 10/26~10/28 https://example.com/buy';
  assert.deepEqual(extract(caption, { now: NOW }), extract(caption, { now: NOW }));
});
