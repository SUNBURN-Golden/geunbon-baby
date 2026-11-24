import type { PriceReview } from './deal-price-review';
import { dealsCopy } from './deals-copy';

export type Model = { id: string; brand: string; name: string; category: string; importer: string; official_price: number | null; source_url: string; checked: string; verify_level: string; note: string };
export type Seller = { id: string; handle?: string; name: string; source_url: string; registration_source: string | null; withdrawal_source: string | null; official_import_source: string | null };
export const sellerAnchor = (id: string) => `trust-${id}`;
export const sellerTrustHref = (id: string) => `/sellers#${encodeURIComponent(sellerAnchor(id))}`;
export type DealOrigin = 'instagram' | 'external_web' | 'threads';
export type Deal = {
  image_url: string | null;
  id: string;
  model_id: string | null;
  seller_id: string;
  title: string;
  price: number | null;
  deal_price_krw?: number | null;
  list_price_krw?: number | null;
  discount_pct?: number | null;
  price_source_url?: string | null;
  list_price_source_url?: string | null;
  price_checked_at?: string | null;
  source_url: string;
  verify_level: string;
  checked: string;
  starts_at: string | null;
  ends_at: string | null;
  origin?: DealOrigin;
  source_host?: string | null;
  source_ended?: number;
  orders_open?: number;
  brand_label?: string | null;
  category_label?: string | null;
  promoted_by?: string | null;
  promoted_at?: string | null;
  external_candidate_id?: string | null;
};
export type DealBundleItem = {
  id: string;
  deal_id: string;
  position: number;
  brand: string | null;
  product_name: string;
  model_id: string | null;
  price: number | null;
};
export const categories: Record<string, string> = { high_chair: '하이체어', stroller: '유모차', car_seat: '카시트', bouncer: '바운서', carrier: '아기띠', play_gym: '플레이짐·모빌' };
export const verification: Record<string, string> = {
  page_body: '공식 원문 본문 확인',
  official_unpublished: '공식가 미확인 · 정보 없음',
  page_text: '페이지 본문 확인',
  search_summary: dealsCopy.searchSummary,
  seed_unspecified: dealsCopy.seedUnspecified,
  manual: dealsCopy.manual,
  verified_offer_v2: '공구 원문 교차 확인',
};
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
  captured_at: string; last_seen_at: string; status: 'candidate' | 'dismissed' | 'promoted'; reviewed_at: string | null;
  promoted_deal_id?: string | null;
  price_revision?: string;
  price_review?: PriceReview | null;
  price_observation?: PriceReview | null;
};

// Lifecycle metadata and original evidence are exclusively for authenticated administrators.
export type DealRevision = Pick<Deal, 'model_id' | 'seller_id' | 'title' | 'price' | 'starts_at' | 'ends_at' | 'image_url' | 'checked'> & {
  id: string; deal_id: string; version: number; action: 'publish' | 'correct' | 'withdraw' | 'promote_external' | 'verify_prices';
  request_id: string; reason: string | null; status: 'published' | 'withdrawn'; created_at: string;
};
export type AdminDeal = Deal & {
  status: 'published' | 'withdrawn'; version: number; updated_at: string | null; withdrawn_at: string | null;
  revisions: DealRevision[];
  price_review?: PriceReview | null;
  price_evidence_version?: number | null;
  previous_price_reviews?: PriceReview[];
  evidence: { source_url: string; account: string; text: string; captured_at: string; image_url: string | null;
    attribution: string | null; attribution_note: string | null; reviewed_at: string | null } | null;
};
