// 유아용품 판정, 개인정보 마스킹, 전송 페이로드 조립. 이미지 URL·페이지 전체 덤프는 다루지 않는다.
import { models as seedModels } from '../../../seed/models.json';
import { extract, extractModels, toSuggestions, type Suggestions } from '../extract';
import type { ParsedItem } from './parse';

const BABY = /육아|유아|아기|아가|신생아|출산|임산부|베이비|유모차|카시트|아기띠|힙시트|바운서|하이체어|식탁의자|보행기|쏘서|젖병|이유식|아기침대|범보|속싸개|모빌|놀이매트|baby|stroller/i;
// 블루프린트 범위 밖.
const EXCLUDED = /기저귀|분유|조제유|diaper|formula/i;
const MODEL_CONFIDENCE = 0.75;

export const TITLE_MAX = 200;
export const TEXT_MAX = 2000;

// 전화번호, 이메일, 주민·계좌번호형 긴 숫자열, 아이 나이, "OO이 엄마" 호칭을 가린다.
export function maskPersonal(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[이메일]')
    .replace(/(?<!\d)(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g, '[전화번호]')
    .replace(/(?<!\d)0\d{1,2}[-.\s)]\s?\d{3,4}[-.\s]\d{4}(?!\d)/g, '[전화번호]')
    .replace(/(?<![\d,.])\d(?:-?\d){10,}(?![\d,])/g, '[번호]')
    .replace(/(?:(?:\d{1,3}|[일이삼사오육칠팔구십]{1,3})\s*(?:개월|살)|\d{1,3}\s*세(?![가-힣]))(?:\s*(?:아기|아이|딸|아들|여아|남아))?/g, '[아이 나이]')
    .replace(/돌\s*(?:아기|아이|쟁이|딸|아들)/g, '[아이 나이]')
    .replace(/[가-힣]{1,3}이\s*(?:엄마|아빠|맘|어머니|아버지)/g, '[호칭]');
}

export type ExternalPayload = {
  kind: 'external_listing'; source: string; source_url: string; account: string; title: string; text: string;
  seller_handle: string | null; seller_name: string | null; seller_url: string | null;
  price_hint: number | null; price_raw: string | null; price_basis: 'external_listing';
  starts_at: string | null; ends_at: string | null; dates_raw: string | null;
  category: string | null; model_match: boolean; captured_at: string; suggestions: Suggestions;
};

export type EligibilitySignals = {
  keyword_match:boolean; model_threshold_match:boolean;
  has_model_category:boolean;
  excluded_title:boolean; excluded_category:boolean; excluded_text:boolean;
};
export function eligibilitySignals(item: Pick<ParsedItem, 'title' | 'text' | 'category_text'>): EligibilitySignals {
  const label = `${item.title} ${item.category_text}`;
  const top=extractModels(label)[0],modelMatch=(top?.confidence??0)>=MODEL_CONFIDENCE;
  return {keyword_match:BABY.test(label),model_threshold_match:modelMatch,has_model_category:modelMatch&&categoryOf(top?.model_id)!==null,
    excluded_title:EXCLUDED.test(item.title),excluded_category:EXCLUDED.test(item.category_text),excluded_text:EXCLUDED.test(item.text)};
}
export type RejectionReason = 'excluded_category'|'not_baby_item'|'empty_title';
export function eligibilityReason(item: Pick<ParsedItem, 'title' | 'text' | 'category_text'>): Exclude<RejectionReason,'empty_title'>|null {
  const signals=eligibilitySignals(item);
  if(signals.excluded_title||signals.excluded_category||signals.excluded_text)return 'excluded_category';
  return signals.keyword_match||signals.model_threshold_match?null:'not_baby_item';
}

export function isBabyItem(item: Pick<ParsedItem, 'title' | 'text' | 'category_text'>): boolean {
  return eligibilityReason(item) === null;
}

const categoryOf = (modelId: string | undefined) => (modelId ? seedModels[Number(modelId.replace('model-', '')) - 1]?.category ?? null : null);

// 유아용품이 아니면 null.
export type PayloadEvaluation = {accepted:true;payload:ExternalPayload} | {accepted:false;reason:RejectionReason};
export function evaluatePayload(source: string, item: ParsedItem, capturedAt: Date): PayloadEvaluation {
  const reason=eligibilityReason(item);
  if (reason) return {accepted:false,reason};
  const title = maskPersonal(item.title).trim().slice(0, TITLE_MAX);
  if (!title) return {accepted:false,reason:'empty_title'};
  const dates = item.dates?.starts_at && (!item.dates.ends_at || Date.parse(item.dates.ends_at) > Date.parse(item.dates.starts_at)) ? item.dates : null;
  const datesRaw = item.dates?.raw ? maskPersonal(item.dates.raw).slice(0, 60) : null;
  const priceRaw = item.price ? maskPersonal(item.price.raw).slice(0, 60) : null;
  const text = maskPersonal([title, datesRaw && `기간 ${datesRaw}`, priceRaw && `가격 ${priceRaw}`, item.seller_handle && `셀러 @${item.seller_handle}`].filter(Boolean).join(' / ')).slice(0, TEXT_MAX);
  const extraction = extract(text, { now: capturedAt });
  const top = extractModels(`${item.title} ${item.category_text}`)[0];
  const modelMatch = (top?.confidence ?? 0) >= MODEL_CONFIDENCE;
  return {accepted:true,payload:{
    kind: 'external_listing', source, source_url: item.source_url, account: source, title, text,
    seller_handle: item.seller_handle, seller_name: 'seller_name' in item ? String(item.seller_name ?? '') || null : null, seller_url: item.seller_url,
    price_hint: item.price && Number.isSafeInteger(item.price.value) ? item.price.value : null, price_raw: priceRaw, price_basis: 'external_listing',
    starts_at: dates?.starts_at ?? null, ends_at: dates?.ends_at ?? null, dates_raw: datesRaw,
    category: modelMatch ? categoryOf(top?.model_id) : null, model_match: modelMatch,
    captured_at: capturedAt.toISOString(), suggestions: toSuggestions(extraction),
  }};
}
export function buildPayload(source: string, item: ParsedItem, capturedAt: Date): ExternalPayload | null {
  const result=evaluatePayload(source,item,capturedAt);
  return result.accepted?result.payload:null;
}
