export type ImporterStatus = 'confirmed' | 'unconfirmed' | 'recheck_failed';
export const importerStatus: Record<ImporterStatus, string | null> = { confirmed: null, unconfirmed: '수입사 미확인', recheck_failed: '기존 정보, 재확인 실패' };
export const isImporterStatus = (s: unknown): s is ImporterStatus => typeof s === 'string' && Object.hasOwn(importerStatus, s);
export const importerStatusLabel = (s: unknown) => importerStatus[isImporterStatus(s) ? s : 'unconfirmed'];
export type Model = { id: string; brand: string; name: string; category: string; importer: string; importer_status: ImporterStatus; official_price: number | null; source_url: string; checked: string; verify_level: string; note: string };
export type Seller = { id: string; name: string; source_url: string; registration_source: string | null; withdrawal_source: string | null; official_import_source: string | null };
export const sellerAnchor = (id: string) => `trust-${id}`;
export const sellerTrustHref = (id: string) => `/sellers#${encodeURIComponent(sellerAnchor(id))}`;
export type Deal = { image_url: string | null; id: string; model_id: string; seller_id: string; title: string; price: number | null; source_url: string; verify_level: string; checked: string; starts_at: string; ends_at: string };
export const categories: Record<string, string> = { high_chair: '하이체어', stroller: '유모차', car_seat: '카시트', bouncer: '바운서', carrier: '아기띠' };
export const verification: Record<string, string> = { page_body: '공식 원문 본문 확인', official_unpublished: '공식가 미확인 · 정보 없음', page_text: '페이지 본문 확인', search_summary: '검색 요약 · 재확인 필요', seed_unspecified: '시드에 검증 수준 미기재', manual: '관리자 원문 확인' };
export const unknownVerification = '확인 수준 정보 없음';
export const verificationLabel = (level: string | null | undefined) =>
  level && Object.hasOwn(verification, level) ? verification[level] : unknownVerification;
export const money = (value: number | null | undefined) => value == null ? '정보 없음' : `${value.toLocaleString('ko-KR')}원`;
export const displayableOfficialPrice = (model: { official_price: number | null; verify_level: string | null }) =>
  model.verify_level === 'page_body' && model.official_price !== null &&
  Number.isSafeInteger(model.official_price) && model.official_price >= 0 ? model.official_price : null;
export function comparison(model: Omit<Model, 'note'>, deals: Deal[]) {
  return {
    gonggu: deals.filter(d => d.model_id === model.id).map(d => ({ ...d, advertisement: true })),
    official: { price: displayableOfficialPrice(model), source: model.source_url, checked: model.checked, verify_level: model.verify_level },
  };
}
// 외부 공구 모음 사이트. 허용 소스·호스트의 단일 출처(서버 검증, 관리자 화면, 크롤러 설정 검증이 함께 쓴다). 표시 순서가 곧 수집 순서다.
export const EXTERNAL_SOURCES = {
  pangpang: { host: '09pangpang.com', name: '공구팡팡' },
  momcalendar: { host: 'momcalendar.com', name: '맘캘린더' },
  buyg: { host: 'buyg.kr', name: 'BUYG' },
  snapup: { host: 'snapup.co.kr', name: '스냅업' },
} as const;
export type ExternalSourceId = keyof typeof EXTERNAL_SOURCES;
export const externalSourceIds = Object.keys(EXTERNAL_SOURCES) as ExternalSourceId[];
export type ExternalCandidate = {
  id: string; source: string; source_url: string; title: string; text: string;
  seller_handle: string | null; seller_name: string | null; seller_url: string | null;
  price_hint: number | null; price_raw: string | null; price_basis: string;
  starts_at: string | null; ends_at: string | null; dates_raw: string | null;
  category: string | null; model_match: number; suggestions: string | null;
  captured_at: string; last_seen_at: string; status: 'candidate' | 'dismissed'; reviewed_at: string | null;
};

// Lifecycle metadata and original evidence are exclusively for authenticated administrators.
export type DealRevision = Pick<Deal, 'model_id' | 'seller_id' | 'title' | 'price' | 'starts_at' | 'ends_at' | 'image_url' | 'checked'> & {
  id: string; deal_id: string; version: number; action: 'publish' | 'correct' | 'withdraw';
  request_id: string; reason: string | null; status: 'published' | 'withdrawn'; created_at: string;
};
export type AdminDeal = Deal & {
  status: 'published' | 'withdrawn'; version: number; updated_at: string | null; withdrawn_at: string | null;
  revisions: DealRevision[];
  evidence: { source_url: string; account: string; text: string; captured_at: string; image_url: string | null;
    attribution: string | null; attribution_note: string | null; reviewed_at: string | null } | null;
};
