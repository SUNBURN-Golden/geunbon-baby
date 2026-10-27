import { FACT_FIELDS, type ClipPayload } from '../../shared/collection-schema';
import { canonicalUrl, filterText, sanitizeValue } from '../../shared/privacy-rules';
export { canonicalUrl, filterText };
export function privacyFilter(raw: unknown): ClipPayload {
  if (!raw || typeof raw !== 'object' || JSON.stringify(raw).length > 24000) throw new Error('payload_shape');
  const p = raw as ClipPayload;
  if (!Array.isArray(p.assertions) || p.assertions.length > 30) throw new Error('assertions_shape');
  return {
    title: typeof p.title === 'string' ? filterText(p.title,200) || null : null,
    published_at: typeof p.published_at === 'string' && Number.isFinite(Date.parse(p.published_at)) ? new Date(p.published_at).toISOString() : null,
    target_model_id: typeof p.target_model_id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(p.target_model_id) && filterText(p.target_model_id)===p.target_model_id ? p.target_model_id : null,
    assertions: p.assertions.filter(a=>a && FACT_FIELDS.includes(a.field)).map(a=>({field:a.field,value:sanitizeValue(a.value),quote:filterText(a.quote ?? ''),locator:filterText(a.locator ?? '',160), conditions:Object.fromEntries(Object.entries({...((a.value&&typeof a.value==='object'&&!Array.isArray(a.value))?a.value:{}),...(a.conditions??{})}).filter(([k])=>['currency','market','option','bundle','effective_at','seller','price_kind','channel','scheme'].includes(k)).map(([k,v])=>[k,filterText(String(v),100)])),msrp_explicit:a.msrp_explicit === true})).filter(a=>a.quote && a.locator && a.value !== ''),
    ...(p.seller_handle && /^[a-zA-Z0-9._]{1,30}$/.test(p.seller_handle) && filterText(p.seller_handle)===p.seller_handle ? { seller_handle:p.seller_handle.toLowerCase() } : {}),
    ...(p.document_origin ? {document_origin:canonicalUrl(p.document_origin)} : {}),
    ...(typeof p.full_text === 'string' ? {full_text:filterText(p.full_text,20000)} : {}),
  };
}
// AI adapters must use this boundary and place the returned object in a data message.
export function aiData(raw: unknown) { return { trust:'untrusted_source_data', data:privacyFilter(raw) }; }
