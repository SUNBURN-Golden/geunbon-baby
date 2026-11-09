import { UNKNOWN, type GongguExtraction, type ScopedCategory } from './types';
const categories = new Set<ScopedCategory>(['stroller', 'high_chair', 'car_seat', 'play_gym', 'carrier', 'bouncer']);
function field(value: unknown) {
  if (value === null || value === undefined) return UNKNOWN;
  const text = String(value).trim();
  return text.length ? text : UNKNOWN;
}
export function normalizeExtraction(raw: Record<string, unknown>, pageUrl: string, checkedDate: string): GongguExtraction {
  const categoryRaw = field(raw.category);
  const category = categories.has(categoryRaw as ScopedCategory) ? (categoryRaw as ScopedCategory) : UNKNOWN;
  const url = field(raw.url);
  return {
    brand: field(raw.brand),
    model: field(raw.model),
    category,
    gonggu_price: field(raw.gonggu_price),
    regular_price: field(raw.regular_price),
    period: field(raw.period),
    gifts: field(raw.gifts),
    conditions: field(raw.conditions),
    seller: field(raw.seller),
    url: url === UNKNOWN ? pageUrl : url,
    checked_date: field(raw.checked_date) === UNKNOWN ? checkedDate : field(raw.checked_date),
    in_scope: raw.in_scope === true,
    ...(raw.catalog_product_id ? { catalog_product_id: String(raw.catalog_product_id).slice(0, 80) } : {}),
    ...(raw.offer_ref ? { offer_ref: String(raw.offer_ref).slice(0, 40) } : {}),
    ...(raw.notes ? { notes: String(raw.notes).slice(0, 500) } : {}),
  };
}
export function normalizeExtractionWithCatalog(
  raw: Record<string, unknown>,
  pageUrl: string,
  checkedDate: string,
  catalog?: { catalog_product_id?: string; offer_ref?: string; category?: ScopedCategory },
) {
  const merged = {
    ...raw,
    catalog_product_id: raw.catalog_product_id ?? catalog?.catalog_product_id,
    offer_ref: raw.offer_ref ?? catalog?.offer_ref,
    category: raw.category ?? catalog?.category,
  };
  const out = normalizeExtraction(merged, pageUrl, checkedDate);
  if (catalog?.catalog_product_id && out.category === UNKNOWN && catalog.category) {
    out.category = catalog.category;
    out.in_scope = true;
  }
  return out;
}
export function parseModelJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model_json_missing');
  return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
}
export function buildExtractionPrompt(text: string, url: string) {
  return `공개 웹 페이지 본문만 보고 근본 프리미엄 육아용품(유모차·하이체어/트립트랩·카시트·플레이짐/모빌·아기띠·바운서) 공구·가격 정보를 추출한다.
가격·날짜를 본문에서 찾을 수 없으면 반드시 "정보 없음"만 쓴다. 추측·발명 금지.
JSON 단일 객체로만 답한다: brand, model, category(stroller|high_chair|car_seat|play_gym|carrier|bouncer|정보 없음), gonggu_price, regular_price, period, gifts, conditions, seller, url, checked_date(YYYY-MM-DD|정보 없음), in_scope(boolean), notes(optional).
URL: ${url}
--- 본문 ---
${text.slice(0, 12000)}`;
}
