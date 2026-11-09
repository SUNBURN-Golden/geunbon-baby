import { test } from 'vitest';
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

test('invalid calendar dates do not become review hints', () => {
  assert.equal(extractDates('2026/2/30 공구', NOW), null);
  assert.equal(extractDates('2026/2/29 공구', NOW), null);
  assert.equal(extractDates('2028/2/29 공구', NOW)?.starts_at, '2028-02-29T00:00:00+09:00');
});
test('December-January ranges share the correct year boundary', () => {
  const dates = extractDates('기간 2026/12/30~1/2', new Date('2026-10-21T00:00:00Z'));
  assert.equal(dates?.starts_at, '2026-12-30T00:00:00+09:00');
  assert.equal(dates?.ends_at, '2027-01-02T23:59:59+09:00');
});
test('extracted hints always fit the review schema, even with many long links', async () => {
  const { parseSuggestions } = await import('../lib/api');
  const links = Array.from({ length: 10 }, (_, i) => `https://example.test/${i}/${'a'.repeat(1800)}`).join('\n');
  const hints = toSuggestions(extract(`스토케 트립트랩 공구가 999999999999999999원\n${links}\n프로필 링크`, { now: NOW }));
  assert.equal(hints.price, null);
  assert.ok(JSON.stringify(hints).length <= 8000);
  assert.ok(parseSuggestions(hints));
});


test('incidental substrings, undeclared spacing and hashtag continuations never create models', () => {
  for (const text of [
    '트레이닝', '실내 점프 트레이닝', '트레이 닝', 'unbalanced', '요요현상', '조이스틱',
    '트립트랩과자', '요요3현상', '#트립트랩공구소식', '앞트립트랩', '트립트랩뒤',
    'mytripptrapp', 'tripptrapper', 'fox5news', '트 립 트 랩', '부가부코리아',
    'dXthrone', 'maxiXcosi', 'https://example.test/tripptrapp/트립트랩',
    '_트립트랩', '트립트랩_', 'tripptrapp\u0301', 'tripptrapp은',
  ]) assert.deepEqual(extractModels(text), [], text);
});

test('bare accessories, materials, trims and categories have no identity score', () => {
  for (const text of [
    '트레이', 'tray', '베이비세트', 'babyset', 'baby set', '배시넷', 'bassinet',
    '범퍼바', 'bumper bar', '섀시', 'chassis', '뉴본', 'newborn', '프레임', '시트', '베이스',
    '너도밤나무', '오크', '느와르', '카본', '애스턴마틴', 'Aston Martin',
    'LUX STYLE CLASSIC 리뉴 리미티드 프로 메쉬 소프트 미니 원 에어', '하이체어 유모차 카시트 바운서',
  ]) assert.deepEqual(extractModels(text), [], text);
  for (const text of ['스토케', '스토케코리아', 'BabyBjörn', 'D.THRONE', 'Maxi-Cosi', '에그', '두나']) {
    const models = extractModels(text);
    assert.ok(models.length > 0, text);
    assert.ok(models.every(m => m.confidence === 0.35), text);
  }
  for (const text of ['스토케 너도밤나무', '스토케 트레이 트레이 트레이', '부가부 느와르 리미티드']) {
    assert.ok(extractModels(text).every(m => m.confidence < 0.75), text);
  }
});

test('branded tray references remain weak suggestions and complete bundles rank first', () => {
  for (const text of ['스토케 트레이', 'Stokke tray']) {
    const models = extractModels(text);
    assert.equal(models.find(m => m.model_id === 'model-4')?.confidence, 0.60, text);
    assert.ok(models.every(m => m.confidence < 0.75), text);
  }
  const tray = extractModels('트립트랩 트레이');
  assert.equal(tray.find(m => m.model_id === 'model-4')?.confidence, 0.80);
  assert.ok(tray.every(m => m.confidence < 0.95));
  for (const text of ['트립트랩 베이비세트 트레이', 'Stokke Tripp Trapp baby set tray', '스토케 트립트랩+베이비세트+트레이', 'Tripp Trapp (baby set & tray)']) {
    const models = extractModels(text);
    assert.equal(models[0].model_id, 'model-4', text);
    assert.equal(models[0].confidence, 0.95, text);
    assert.ok(models.find(m => m.model_id === 'model-1')!.confidence < models[0].confidence);
    assert.ok(models.every(m => m.brand === 'Stokke'), text);
  }
  assert.equal(extractModels('트립트랩 하이체어(오크)')[0].model_id, 'model-2');
  assert.ok(extractModels('트립트랩 + 폭스5 + 오크').filter(m => m.brand === 'Stokke').every(m => m.confidence < 0.95));
});

test('explicit Korean particles, commerce suffixes, OCR aliases and same-brand compounds survive', () => {
  for (const text of [
    '트립\n트랩', '트립 트랩', 'Tripp Trapp', 'tripp\ntrapp', 'Ｔｒｉｐｐ Ｔｒａｐｐ',
    '#트립트랩공구', '#트립트랩공동구매', '스토케트립트랩',
    ...['은', '는', '이', '가', '을', '를', '과', '와', '도', '만', '의', '에', '에서', '으로', '로'].map(p => `트립트랩${p}`),
  ]) {
    const models = extractModels(text);
    assert.ok(models.some(m => m.model_id === 'model-1' && m.confidence >= 0.80), text);
    assert.ok(models.every(m => m.brand === 'Stokke'), text);
  }
});

test('declared versions, qualifiers and identifying phrases establish the supported families', () => {
  for (const [text, id] of [
    ['폭스5', 'model-10'], ['fox5', 'model-10'], ['요요3', 'model-7'], ['yoyo3', 'model-7'],
    ['버터플라이2', 'model-12'], ['butterfly2', 'model-12'], ['에그3', 'model-30'], ['egg3', 'model-30'],
    ['리프2', 'model-38'], ['reef2', 'model-38'], ['듄2', 'model-39'], ['dune2', 'model-39'],
    ['요요3은', 'model-7'], ['yoyo3은', 'model-7'], ['제로나 T는', 'model-19'], ['제로나 T', 'model-19'], ['zerona Gi', 'model-18'], ['아이스핀 360', 'model-23'],
    ['옴니 브리즈', 'model-40'], ['omni breeze', 'model-40'], ['피파넥스트', 'model-20'], ['pipa next', 'model-20'],
    ['토들넥스트', 'model-21'], ['베이비뵨 원 에어', 'model-28'], ['BabyBjörn mini', 'model-29'],
    ['두나 카시트 겸용 유모차', 'model-41'], ['Silver Cross reef2', 'model-38'], ['D.THRONE initial', 'model-32'],
    ['Maxi-Cosi mica', 'model-36'], ['에그3 Aston Martin', 'model-31'],
  ]) assert.ok(extractModels(text).some(m => m.model_id === id && m.confidence >= 0.75), text);
  assert.ok(!extractModels('제로나 T').some(m => m.model_id === 'model-18'));
  assert.ok(!extractModels('제로나 Gi').some(m => m.model_id === 'model-19'));
  for (const text of ['T', 'Gi', '360', '3', '원 에어', '제로나T', '아이스핀360', '폭스5현상']) {
    assert.ok(extractModels(text).every(m => m.confidence < 0.75), text);
  }
});

test('ambiguous families need local matching evidence; other mentions and brands cannot boost them', () => {
  for (const text of ['요요', '폭스', '블리스', '밸런스', '하모니', '미카', '타이탄', '브리즈', '넥스트']) {
    assert.ok(extractModels(text).every(m => m.confidence <= 0.50), text);
  }
  for (const [text, id] of [['부가부 폭스', 'model-10'], ['스토케 요요', 'model-7'], ['BabyBjörn balance', 'model-26']]) {
    assert.equal(extractModels(text).find(m => m.model_id === id)?.confidence, 0.90, text);
  }
  for (const text of [
    '스토케 폭스', '스토케 폭스5', '부가부 트립트랩', '스토케 폭스 부가부', '부가부 폭스 부가부',
    '부가부, 폭스', '부가부. 폭스', '부가부 그리고 폭스', '부가부 또는 폭스', '부가부 트립트랩 폭스',
    '부가부와 폭스', '스토케 폭스 폭스 느와르',
  ]) assert.ok(extractModels(text).filter(m => ['model-10', 'model-11'].includes(m.model_id)).every(m => m.confidence < 0.75), text);
  const two = extractModels('스토케 트립트랩과 부가부 폭스');
  assert.equal(two.find(m => m.model_id === 'model-1')?.confidence, 0.90);
  assert.equal(two.find(m => m.model_id === 'model-10')?.confidence, 0.90);
  const independent = extractModels('트립트랩과 요요3');
  assert.ok(independent.some(m => m.model_id === 'model-1' && m.confidence === 0.80));
  assert.ok(independent.some(m => m.model_id === 'model-7' && m.confidence === 0.80));
});

test('ordering and ten-result limit stay deterministic without accumulating repeated weak words', () => {
  const caption = '트립트랩 요요3 폭스5 버터플라이2 프리암 미오스 멜리오 트리브 아이스핀';
  const models = extractModels(caption);
  assert.equal(models.length, 10);
  assert.deepEqual(models, extractModels(caption));
  assert.deepEqual(models.map(m => m.model_id), models.map(m => m.model_id).sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(extractModels('스토케 트레이 트레이'), extractModels('스토케 트레이'));
});
