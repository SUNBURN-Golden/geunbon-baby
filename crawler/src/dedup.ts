import { createHash } from 'node:crypto';
import families from '../config/model-families.json';
import type { ClipPayload } from '../../shared/collection-schema';
export const digest = (v: unknown): string => createHash('sha256').update(stable(v)).digest('hex');
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
export function dedupKey(url: string, p: ClipPayload): string {
  // Only reviewed families collapse options. Unknown generations remain independent.
  const family = p.target_model_id && (families as Record<string,string>)[p.target_model_id];
  if (family) {const generations=p.assertions.filter(a=>a.field==='generation').map(a=>a.value);return `family:${family}${generations.length?`:generation:${digest(generations)}`:''}`;}
  if (p.document_origin && new URL(p.document_origin).pathname !== '/') return `document:${p.document_origin}`;
  if (p.full_text && p.full_text.length >= 500) return `fingerprint:${digest(p.full_text)}`;
  return `document:${url}`;
}
