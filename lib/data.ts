export type Model = { id: string; brand: string; name: string; category: string; importer: string; official_price: number | null; source_url: string; checked: string; verify_level: string; note: string };
export type Seller = { id: string; name: string; source_url: string; registration_source: string | null; withdrawal_source: string | null; official_import_source: string | null };
export type Deal = { id: string; model_id: string; seller_id: string; title: string; price: number | null; source_url: string; verify_level: string; checked: string; starts_at: string; ends_at: string };
export const categories: Record<string, string> = { high_chair: '하이체어', stroller: '유모차', car_seat: '카시트', bouncer: '바운서', carrier: '아기띠' };
export const verification: Record<string, string> = { page_text: '페이지 본문 확인', search_summary: '검색 요약 · 재확인 필요', seed_unspecified: '시드에 검증 수준 미기재', manual: '관리자 원문 확인' };
export const money = (value: number | null | undefined) => value == null ? '정보 없음' : `${value.toLocaleString('ko-KR')}원`;
export function dealState(d: Deal) { const now = Date.now(); return now < Date.parse(d.starts_at) ? '예정' : now > Date.parse(d.ends_at) ? '종료' : '진행'; }
export function comparison(model: Omit<Model, 'note'>, deals: Deal[]) {
  return {
    gonggu: deals.filter(d => d.model_id === model.id).map(d => ({ ...d, advertisement: true })),
    official: { price: model.official_price, source: model.source_url, checked: model.checked, verify_level: model.verify_level },
  };
}
