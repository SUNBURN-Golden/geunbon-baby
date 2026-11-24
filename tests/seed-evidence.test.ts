import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { isOfficialSource } from '../shared/official-evidence';
// Frozen IDs: changes to the live seed cannot rewrite this expectation.
const expectedOrder = [
  [
    "Stokke",
    "트립트랩 하이체어(너도밤나무)"
  ],
  [
    "Stokke",
    "트립트랩 하이체어(오크)"
  ],
  [
    "Stokke",
    "트립트랩+베이비세트"
  ],
  [
    "Stokke",
    "트립트랩+베이비세트+트레이(이유식세트)"
  ],
  [
    "Stokke",
    "트립트랩 신생아&이유식 세트"
  ],
  [
    "Stokke",
    "익스플로리 X"
  ],
  [
    "Stokke",
    "요요3 프레임"
  ],
  [
    "Stokke",
    "요요3 6+ (프레임+시트)"
  ],
  [
    "Stokke",
    "요요 뉴본 배시넷 구성"
  ],
  [
    "Bugaboo",
    "폭스5 리뉴"
  ],
  [
    "Bugaboo",
    "폭스5 느와르 리미티드"
  ],
  [
    "Bugaboo",
    "버터플라이2(범퍼바 포함)"
  ],
  [
    "Bugaboo",
    "드래곤플라이(배시넷 포함)"
  ],
  [
    "Bugaboo",
    "드래곤플라이 섀시(시트 구성)"
  ],
  [
    "Cybex",
    "프리암 4.0"
  ],
  [
    "Cybex",
    "미오스 3.0"
  ],
  [
    "Cybex",
    "멜리오 카본 3.0"
  ],
  [
    "Cybex",
    "제로나 Gi (회전형 카시트)"
  ],
  [
    "Cybex",
    "제로나 T"
  ],
  [
    "Nuna",
    "피파 넥스트(바구니 카시트)"
  ],
  [
    "Nuna",
    "넥스트 시스템(토들넥스트+피파넥스트+베이스)"
  ],
  [
    "Nuna",
    "트리브 넥스트 트래블 시스템(+피파넥스트)"
  ],
  [
    "Joie",
    "아이스핀 360"
  ],
  [
    "Joie",
    "아이스핀 360 메쉬"
  ],
  [
    "BabyBjorn",
    "바운서 블리스"
  ],
  [
    "BabyBjorn",
    "바운서 밸런스 소프트"
  ],
  [
    "BabyBjorn",
    "베이비 캐리어 하모니"
  ],
  [
    "BabyBjorn",
    "베이비 캐리어 원 에어"
  ],
  [
    "BabyBjorn",
    "베이비 캐리어 미니"
  ],
  [
    "Egg",
    "에그3 디럭스"
  ],
  [
    "Egg",
    "애스턴마틴 에그3"
  ],
  [
    "D.THRONE",
    "이니셜 신생아 디럭스 유모차"
  ],
  [
    "Britax",
    "듀얼픽스 프로 LUX"
  ],
  [
    "Britax",
    "듀얼픽스 프로 STYLE"
  ],
  [
    "Britax",
    "듀얼픽스 프로 CLASSIC"
  ],
  [
    "Maxi-Cosi",
    "미카 360 프로"
  ],
  [
    "Maxi-Cosi",
    "타이탄 프로"
  ],
  [
    "Silver Cross",
    "리프2"
  ],
  [
    "Silver Cross",
    "듄2"
  ],
  [
    "Ergobaby",
    "옴니 브리즈"
  ],
  [
    "Doona",
    "두나 카시트 겸용 유모차"
  ]
];
const load = (file: string) => JSON.parse(readFileSync(new URL(`../seed/${file}`, import.meta.url), 'utf8'));
const { models } = load('models.json');
const sources = load('official-sources.json');
const recalls = load('recalls.json');
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+09:00$/;
const pricePattern = /(?:\d{1,3}(?:,\d{3})+|\d{4,})\s*원/;
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}.${i}`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}
function checkDate(value: string) {
  expect(value).toMatch(timestamp);
  expect(Number.isNaN(Date.parse(value))).toBe(false);
  expect(Date.parse(value)).toBeGreaterThanOrEqual(Date.parse('2026-10-23T00:00:00+09:00'));
}
function unconfirmed(value: { status?: string; reason?: string }) {
  expect(typeof value).toBe('object');
  expect(value.status).toBe('unconfirmed');
  expect(value.reason?.length).toBeGreaterThan(10);
}


test('41 stable model IDs and authoritative source policies', () => {
  expect(models).toHaveLength(43);
  expect(models.slice(0, 41).map((m: { brand: string; model: string }) => [m.brand, m.model])).toEqual(expectedOrder);
  for (const [brand] of expectedOrder) {
    const source = sources[brand];
    expect(source).toBeTruthy();
    expect(source.cpsc.query).toBeTruthy();
    expect(source.cpsc.match_terms.length).toBeGreaterThan(0);
    expect(source.blocked_paths).toEqual(expect.arrayContaining(['/article/', '/board/', '/review', '/community', '/event']));
    if (!Object.keys(source.hosts).length) {
      for (const m of models.filter((m: { brand: string }) => m.brand === brand)) expect(m.kr_official_price_krw).toBeNull();
    }
  }
  // Reject review and home URLs even on a previously trusted importer host.
  const aone = { hosts: { 'aonebaby.co.kr': { product_path: '^/product/' } }, blocked_paths: ['/article/', '/board/', '/review', '/community', '/event'] };
  expect(isOfficialSource('https://aonebaby.co.kr/article/review/4/4828/', aone, true)).toBe(false);
  expect(isOfficialSource('https://aonebaby.co.kr/', aone, true)).toBe(false);
  expect(isOfficialSource('https://aonebaby.co.kr/product/pipa/123/', aone, true)).toBe(true);
  expect(isOfficialSource('https://aonebaby.co.kr/product/%2e%2e/article/review/1', aone, true)).toBe(false);
  expect(isOfficialSource('https://aonebaby.co.kr.evil.example/product/pipa/', aone, true)).toBe(false);
  expect(isOfficialSource('https://aonebaby.co.kr@evil.example/product/pipa/', aone, true)).toBe(false);
  for (const host of ['lotteon.com', 'galleria.co.kr', 'lotteimall.com', 'elandmall.co.kr', 'funiz.com', 'ssg.com', 'coupang.com', 'economist.co.kr']) {
    expect(isOfficialSource(`https://${host}/product/1`, aone, true)).toBe(false);
    for (const source of Object.values(sources)) expect(Object.keys((source as { hosts: object }).hosts)).not.toContain(host);
  }
});

for (const [index, m] of models.slice(0, 41).entries()) {
  test(`model-${index + 1}: official price, bundle, manual and recall evidence`, () => {
    const e = m.evidence, b = m.bundle, source = sources[m.brand];
    expect(['page_body', 'official_unpublished']).toContain(m.verify_level);
    expect(['manufacturer', 'importer']).toContain(e.source_kind);
    expect(e.quote.length).toBeGreaterThan(0);
    expect(e.quote.length).toBeLessThanOrEqual(120);
    expect(e.locator).toBeTruthy();
    checkDate(e.checked_at);
    expect(e.checked_at.slice(0, 10)).toBe(m.checked);
    expect(m.kr_importer).toBe(source.importer_basis.status === 'recheck_failed' ? `${source.importer} (기존 정보, 재확인 실패)` : source.importer ?? '미확인');
    if (m.kr_official_price_krw !== null) {
      expect(m.verify_level).toBe('page_body');
      expect(e.kind).toBe('official_msrp');
      expect(e.reason).toBeNull();
      expect(e.price_label).toBeTruthy();
      expect(m.kr_official_price_krw).toBeGreaterThan(0);
      expect(isOfficialSource(m.source_url, source, true)).toBe(true);
      const amounts = [...e.quote.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/g)].map(x => Number(x[1].replaceAll(',', '')));
      expect(amounts).toContain(m.kr_official_price_krw);
      if (amounts.length > 1) expect(e.price_label).toMatch(/정상|원래|Original/);
    } else {
      expect(m.verify_level).toBe('official_unpublished'); expect(e.kind).toBe('unpublished');
      expect(['not_listed', 'discontinued', 'importer_unconfirmed', 'fetch_failed']).toContain(e.reason);
      expect(m.note).toBeTruthy();
    }
    if (m.source_url) {
      expect(e.source_status).toBe('read');
      if (Object.keys(source.hosts).length) expect(isOfficialSource(m.source_url, source)).toBe(true);
      else expect(m.source_url).toBe(source.importer_basis.url);
      expect(m.source_url).not.toBe(e.source_attempt?.url);
    } else {
      expect(e.source_status).toBe('unavailable');
      expect(m.kr_official_price_krw).toBeNull();
      expect(e.source_attempt.status).toBe('fetch_failed');
      expect(e.source_attempt.attempted_at).toMatch(timestamp);
    }
    unconfirmed(b.generation); unconfirmed(b.kr_configuration);
    expect(b.included.length).toBeGreaterThan(0); expect(Array.isArray(b.compatible)).toBe(true);
    for (const part of [...b.included, ...b.compatible]) {
      expect(part.item || part.part).toBeTruthy();
      if (part.status === 'unconfirmed') expect(part.reason).toBeTruthy();
      else { expect(isOfficialSource(part.source_url, source)).toBe(true); checkDate(part.checked_at); }
    }
    if (b.warranty.status) unconfirmed(b.warranty);
    else { expect(b.warranty.summary).toBeTruthy(); expect(isOfficialSource(b.warranty.source_url, source)).toBe(true); checkDate(b.warranty.checked_at); }
    expect(['confirmed', 'not_found']).toContain(b.manual.status); checkDate(b.manual.checked_at);
    if (b.manual.status === 'confirmed') {
      expect(isOfficialSource(b.manual.url, source)).toBe(true); expect(b.manual.locator).toBeTruthy();
    } else { expect(new URL(b.manual.searched_url).protocol).toMatch(/^https?:$/); expect(b.manual.reason).toBeTruthy(); }
    expect(Array.isArray(b.safety.certifications)).toBe(true);
    if (!b.safety.certifications.length) expect(b.safety.certifications_note).toBeTruthy();
    for (const cert of b.safety.certifications) {
      expect(cert.name).toBeTruthy(); expect(cert.evidence).toBeTruthy(); checkDate(cert.checked_at);
      expect(isOfficialSource(cert.source_url, source)).toBe(true);
    }
    const c = b.safety.recalls.cpsc, snapshot = recalls.brands[m.brand];
    expect(['ok', 'fetch_failed']).toContain(c.status); expect(c.status).toBe(snapshot.status);
    expect(c.brand_query).toBe(source.cpsc.query); checkDate(c.checked_at);
    expect(c.checked_at).toBe(recalls.checked_at); expect(c.result_note).toContain('안전을 보장하지 않');
    if (c.status === 'ok') {
      expect(c.raw_count).toBe(snapshot.raw_count); expect(c.raw_count).toBeGreaterThanOrEqual(c.match_count);
      expect(c.match_count).toBe(c.reviewed.length);
      expect([...new Set(c.reviewed.map((r: { recall_id: string }) => r.recall_id))].sort()).toEqual(snapshot.kept.map((r: { recall_id: string }) => r.recall_id).sort());
      expect(new Set(c.reviewed.map((r: { recall_id: string }) => r.recall_id)).size).toBe(c.reviewed.length);
    } else {
      expect(c.raw_count).toBeNull(); expect(c.match_count).toBeNull(); expect(c.reviewed).toEqual([]);
      expect(c.result_note).toContain('조회를 완료하지 못함');
    }
    for (const r of c.reviewed) { expect(['unknown', 'applies', 'not_applicable', 'not_this_model']).toContain(r.kr_applicability); expect(r.note).toBeTruthy(); }
    expect(b.safety.recalls.safetykorea).toMatchObject({ status: 'not_connected' });
    expect(b.safety.recalls.safetykorea.reason).toBeTruthy();
    for (const [path, value] of strings(m)) {
      expect(value.length, path).toBeLessThanOrEqual(300);
      expect(value, path).not.toMatch(/data:|https?:[^\s]*\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i);
      if (path !== '.evidence.quote') expect(value, path).not.toMatch(pricePattern);
      expect(value, path).not.toMatch(/안전\s*(을\s*)?보장(?!\s*하지\s*않)|리콜\s*(이력\s*)?없음\s*확인|안전이\s*확인/);
    }
  });
}

test('identity-only play gyms append stable IDs with unknown domestic MSRP', () => {
  expect(models.slice(41).map(({ brand, model, category, kr_official_price_krw, verify_level, source_url }: typeof import('../seed/models.json').models[number]) =>
    [brand, model, category, kr_official_price_krw, verify_level, new URL(source_url).hostname])).toEqual([
      ['하베브릭스','바람개비 아기체육관','play_gym',null,'official_unpublished','m.whittlestore.com'],
      ['Lovevery','The Play Gym','play_gym',null,'official_unpublished','lovevery.com'],
    ]);
});

test('snapshot provenance and Linux/Workers boundary', () => {
  expect(recalls.endpoint).toBe('https://www.saferproducts.gov/RestWebServices/Recall');
  expect(recalls.empty_result_is_not_safety_guarantee).toBe(true);
  for (const [brand, snapshot] of Object.entries(recalls.brands)) {
    const row = snapshot as { query: string; kept: { matched_term: string; recall_id: string; url: string }[] };
    expect(row.query).toBe(sources[brand].cpsc.query);
    for (const recall of row.kept) { expect(sources[brand].cpsc.match_terms).toContain(recall.matched_term); expect(new URL(recall.url).protocol).toBe('https:'); }
  }
  const script = readFileSync(new URL('../scripts/recall-check.ts', import.meta.url), 'utf8');
  expect(script).not.toMatch(/from\s+['"][^'"]*crawler\//);
  const policy = readFileSync(new URL('../shared/cpsc-recalls.ts', import.meta.url), 'utf8');
  expect(policy).not.toMatch(/fetch\(|node:fs|node:http/);
});

test('failed importer checks are attempts, and previous importers and domestic hosts survive transport errors', () => {
  const previous = JSON.parse(readFileSync(new URL('./fixtures/models-before-0008.json', import.meta.url), 'utf8')).models;
  for (const brand of ['Cybex', 'Joie', 'Egg', 'Britax', 'Maxi-Cosi', 'Ergobaby']) {
    expect(sources[brand].importer).toBe(previous.find((m: { brand: string }) => m.brand === brand).kr_importer);
    expect(sources[brand].importer_basis.status).toBe('recheck_failed');
  }
  for (const brand of ['Egg', 'Britax', 'Maxi-Cosi', 'Ergobaby']) {
    const basis = sources[brand].importer_basis;
    expect(basis.url).toBeUndefined(); expect(basis.checked_at).toBeUndefined();
    expect(basis.attempted_url).toBeTruthy(); expect(basis.attempted_at).toMatch(timestamp);
    for (const m of models.filter((m: { brand: string }) => m.brand === brand)) expect(m.source_url).toBe('');
  }
  for (const [brand, host] of [['Cybex', 'cybex-shop.co.kr'], ['Nuna', 'aonebaby.co.kr'], ['Joie', 'joiebaby.co.kr'], ['Egg', 'eggstroller.co.kr'], ['Britax', 'britaxmall.co.kr'], ['Maxi-Cosi', 'mbaby.co.kr']]) expect(Object.keys(sources[brand].hosts)).toContain(host);
  for (const m of models.filter((m: { brand: string }) => m.brand === 'Bugaboo')) {
    expect(m.bundle.safety.recalls.cpsc.reviewed.find((r: { recall_id: string }) => r.recall_id === '938')?.kr_applicability).toBe('unknown');
  }
});

test('recall snapshot records every query variant and rejected IDs without dropping audit evidence', () => {
  for (const [brand, row] of Object.entries(recalls.brands)) {
    const snapshot = row as { status: string; queries: string[]; raw_count: number; kept: { recall_id: string }[]; rejected: { recall_id: string; title: string }[]; requests: { query: string; field: string; row_count: number }[] };
    const queries = [...new Set([sources[brand].cpsc.query, ...sources[brand].cpsc.match_terms])];
    expect(snapshot.queries).toEqual(queries);
    expect(Array.isArray(snapshot.rejected)).toBe(true);
    if (snapshot.status !== 'ok') continue;
    expect(snapshot.requests.map(r => [r.query, r.field])).toEqual(queries.flatMap(query => [[query, 'RecallTitle'], [query, 'ProductName']]));
    expect(snapshot.raw_count).toBe(snapshot.requests.reduce((n, r) => n + r.row_count, 0));
    const kept = new Set(snapshot.kept.map(r => r.recall_id));
    for (const rejected of snapshot.rejected) {
      expect(rejected.recall_id).toMatch(/^\d+$/); expect(rejected.title).toBeTruthy();
      expect(kept.has(rejected.recall_id)).toBe(false);
    }
    expect(new Set(snapshot.rejected.map(r => r.recall_id)).size).toBe(snapshot.rejected.length);
  }
});
