import { FACT_FIELDS } from '../../../shared/collection-schema';
import { canonicalUrl, filterText } from '../../../shared/privacy-rules';
import { isHardBlockedPath } from '../../lib/external/robots';
import { visitAllowed, type SourcePolicy } from '../source-policy';
import type { RegistryScope, SourceRegistryEntry, Reason } from './types';

export const validTime = (s: unknown): s is string => typeof s==='string' && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));
const text = (s: unknown): s is string => typeof s==='string' && s.length>0 && s.length<=2000 && filterText(s,2000)===s;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x=>typeof x==='string') && new Set(v).size===v.length;
const path = (p: string) => p.startsWith('/') && !/[\s%?#\\;\u0000-\u001f\u007f]/.test(p) && !p.includes('//') && !p.split('/').some(s=>s==='.'||s==='..');
const positive = (n: unknown) => n===null || Number.isSafeInteger(n) && Number(n)>0;
export function validateEntry(e: SourceRegistryEntry): SourceRegistryEntry {
  const check = (ok: unknown) => {if(!ok)throw new Error('invalid_registry_entry');};
  check(e && /^[a-zA-Z0-9:_.-]{1,160}$/.test(e.source_id) && Number.isSafeInteger(e.revision) && e.revision>0);
  check(['manufacturer_importer','catalog','official_seller','public_db','group_buy','social'].includes(e.kind));
  for(const list of [e.scope_hosts,e.allowed_path_prefixes,e.path_patterns,e.query_keys,e.blocked_paths,e.collectable_fields])check(strings(list));
  check(e.allowed_path_prefixes.every(path) && e.blocked_paths.every(path));
  check(e.query_keys.every(k=>/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(k)) && e.collectable_fields.every(f=>FACT_FIELDS.includes(f)));
  if(e.origin===null)check(!e.scope_hosts.length && !e.allowed_path_prefixes.length && !e.path_patterns.length);
  else {
    const u=new URL(e.origin);canonicalUrl(e.origin);
    check(u.origin===e.origin && u.protocol==='https:' && !u.username && !u.password && !u.port);
    // Host aliases require their own origin/ID, never wildcard/subdomain matching.
    check(e.scope_hosts.length===1 && e.scope_hosts[0]===u.hostname);
  }
  for(const pattern of e.path_patterns){check(pattern.startsWith('^/') && pattern.length<=300);new RegExp(pattern);}
  check(['registered','deprioritized','excluded'].includes(e.status) && (e.reevaluate_at===null||validTime(e.reevaluate_at)));
  check(positive(e.refresh_ms));
  check(e.retention && [e.retention.snippets_days,e.retention.full_text_days,e.retention.images_days].every(positive) && text(e.retention.conditions));
  check(Array.isArray(e.unsupported) && e.unsupported.every(u=>text(u.scope)&&text(u.reason)));
  check(Array.isArray(e.evidence) && e.evidence.length>0 && e.evidence.every(v=>text(v.reference)));
  for(const p of [e.permission.robots,e.permission.terms]){
    check(['allowed','disallowed','unknown'].includes(p.status));
    check((p.checked_at===null||validTime(p.checked_at)) && (p.evidence===null||text(p.evidence)));
    if(p.status!=='unknown')check(validTime(p.checked_at) && text(p.evidence));
  }
  return e;
}
export const pathMatches = (pathname: string, prefix: string) => pathname===prefix || prefix.endsWith('/') && pathname.startsWith(prefix);
export function registryUrl(raw: string): URL {
  if(typeof raw!=='string'||raw.length>2048||/[\s\\\u0000-\u001f\u007f]/.test(raw))throw new Error('invalid_url');
  // Reject ambiguous raw paths before WHATWG URL normalizes dot segments or escapes.
  const match=/^https:\/\/[^/?#]+([^?#]*)/.exec(raw);
  if(!match)throw new Error('invalid_url');
  const rawPath=match[1] || '/';
  if(!path(rawPath))throw new Error('invalid_url');
  const u=new URL(raw);canonicalUrl(`${u.origin}${u.pathname}`);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||isHardBlockedPath(u.pathname))throw new Error('invalid_url');
  return u;
}
export const matchedPrefix = (s: RegistryScope, u: URL) => s.origin===u.origin && s.scope_hosts.includes(u.hostname)
  // Alternatives form a union: adding a specific path to '/' cannot make it narrower.
  ? s.allowed_path_prefixes.filter(p=>pathMatches(u.pathname,p)).sort((a,b)=>a.length-b.length)[0] : undefined;
export function scopeReason(s: RegistryScope,u: URL): Reason|undefined {
  if(s.origin!==u.origin)return 'origin_mismatch';
  if(!s.scope_hosts.includes(u.hostname))return 'host_mismatch';
  if(!matchedPrefix(s,u)||s.path_patterns.length&&!s.path_patterns.some(p=>new RegExp(p).test(u.pathname)))return 'path_mismatch';
  const seen=new Set<string>();
  for(const [k,v] of u.searchParams){
    if(!s.query_keys.includes(k)||seen.has(k)||!v||v.length>100||!/^[\p{L}\p{N}_.-]+$/u.test(v)||filterText(v,100)!==v)return 'query_denied';
    seen.add(k);
  }
}
/**
 * Static admission shared by config-time validation and runtime `decide()`.
 * Deliberately excludes permissions, approvals and reevaluation deadlines:
 * those remain runtime checks in `entryReason()`.
 */
export function staticEntryReason(e: SourceRegistryEntry,u: URL,fields: readonly string[]): Reason|undefined {
  if(e.status!=='registered')return 'inactive';
  if(e.blocked_paths.some(p=>u.pathname.includes(p)))return 'blocked_path';
  if(e.unsupported.some(s=>s.scope==='*'||s.scope.startsWith('/')&&pathMatches(u.pathname,s.scope)||fields.includes(s.scope)))return 'unsupported';
  const scope=scopeReason(e,u);if(scope)return scope;
  if(fields.some(f=>!e.collectable_fields.includes(f as typeof FACT_FIELDS[number])))return 'field_denied';
  return undefined;
}
export function entryReason(e: SourceRegistryEntry,u: URL,fields: readonly string[],now: number): Reason|undefined {
  const staticReason=staticEntryReason(e,u,fields);if(staticReason)return staticReason;
  const permissions=[e.permission.robots,e.permission.terms];
  if(permissions.some(p=>p.status==='disallowed'))return 'permission_denied';
  if(permissions.some(p=>p.status!=='allowed'||!validTime(p.checked_at)||Date.parse(p.checked_at)>now||!p.evidence))return 'permission_unknown';
  if(!e.reevaluate_at||Date.parse(e.reevaluate_at)<=now)return 'reevaluation_due';
}
// A narrower prefix can win only if its extra constraints provably imply the broad ones.
// Different regular expressions are deliberately incomparable, rather than guessed by length.
export function narrower(a: SourceRegistryEntry,b: SourceRegistryEntry,u: URL): boolean {
  const ap=matchedPrefix(a,u),bp=matchedPrefix(b,u);
  return !!ap && !!bp && ap.length>bp.length && pathMatches(ap,bp)
    && (!b.path_patterns.length || a.path_patterns.length>0 && a.path_patterns.every(p=>b.path_patterns.includes(p)))
    && a.query_keys.every(k=>b.query_keys.includes(k));
}
export function legacyReason(sources: readonly SourcePolicy[],u: URL,fields: readonly string[]): Reason|undefined {
  const candidates=sources.flatMap(s=>{
    if(s.origin!==u.origin)return [];
    const p=s.paths.filter(p=>pathMatches(u.pathname,p)).sort((a,b)=>a.length-b.length)[0];
    return p?[{s,p}]:[];
  });
  if(!candidates.length)return 'legacy_scope_mismatch';
  const length=Math.max(...candidates.map(c=>c.p.length));
  const closest=[...new Set(candidates.filter(c=>c.p.length===length).map(c=>c.s))];
  if(closest.length!==1)return 'ambiguous_scope';
  const s=closest[0];
  if(!s.enabled)return 'legacy_disabled';
  if(!visitAllowed(u.href,s))return 'legacy_scope_mismatch';
  if(fields.some(f=>!s.official_fields.includes(f as typeof FACT_FIELDS[number])))return 'legacy_field_denied';
}
