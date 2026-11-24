export type Provider = 'deepseek' | 'qwen';
export type Claim = {
  brand_id: string;
  seller_id: string;
  seller_identity_url: string;
  relationship: 'seller';
  campaign_id: string | null;
  evidence_url: string;
  capture_hash: string;
  source_kind: 'brand_site' | 'brand_account';
  source_identity: string;
  brand_binding_ref: string;
  captured_at: string;
};
export type Verdict = {
  provider: Provider;
  model: string;
  run_id: string;
  verdict: 'affirmed';
  claim: Claim;
  passage_hash: string;
};
export type Attestation = {
  version: 1;
  key_id: string;
  claim: Claim;
  results: [Verdict & { result_digest: string }, Verdict & { result_digest: string }];
};
export type SignedAttestation = { envelope: Attestation; digest: string; signature: string };
export type OfficialPolicy = {
  keys: Record<string, string>;
  models: Record<Provider, string[]>;
  brands: Record<string, { hosts: Record<string, string>; accounts: Record<string, string> }>;
};

type Dict = Record<string, unknown>;
const token = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9._:@/-]{1,200}$/.test(x);
export const isDigest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const dictionary = (x: unknown): x is Dict => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Dict, fields: string[]) => Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, x: unknown) => dictionary(x) ?
    Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
}
export async function hashBytes(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export const hashJson = (x: unknown) => hashBytes(new TextEncoder().encode(canonical(x)));
export const hashText = (x: string) => hashBytes(new TextEncoder().encode(x));
export function evidenceUrl(x: unknown): URL | null {
  if (typeof x !== 'string' || x.length > 2048) return null;
  try {
    const url = new URL(x);
    if (url.href !== x || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+$/i.test(url.hostname) ||
      /\.(?:local|internal|localhost|test|invalid)$/i.test(url.hostname) ||
      [...url.searchParams.keys()].some(k => !['id', 'page', 'p', 'store'].includes(k) ||
        url.searchParams.getAll(k).length !== 1 || !/^[a-zA-Z0-9_.-]{1,60}$/.test(url.searchParams.get(k)!))) return null;
    return url;
  } catch { return null; }
}
const social = (host: string) => /(^|\.)(instagram\.com|threads\.net|threads\.com)$/.test(host);
export function claimAllowed(value: unknown, policy: Pick<OfficialPolicy, 'brands'>): value is Claim {
  if (!dictionary(value) || !exact(value, ['brand_id','seller_id','seller_identity_url','relationship','campaign_id','evidence_url','capture_hash',
    'source_kind','source_identity','brand_binding_ref','captured_at']) ||
    typeof value.brand_id !== 'string' || !value.brand_id || value.brand_id.length > 100 ||
    !token(value.seller_id) || !evidenceUrl(value.seller_identity_url) || !(value.campaign_id === null || token(value.campaign_id)) ||
    value.relationship !== 'seller' || !isDigest(value.capture_hash) || !token(value.source_identity) ||
    !token(value.brand_binding_ref) || typeof value.captured_at !== 'string') return false;
  try { if (new Date(value.captured_at).toISOString() !== value.captured_at) return false; } catch { return false; }
  const url = evidenceUrl(value.evidence_url);
  if (!url || !Object.hasOwn(policy.brands, value.brand_id)) return false;
  const brand = policy.brands[value.brand_id];
  if (value.source_kind === 'brand_site') return !social(url.hostname) && url.hostname === value.source_identity &&
    url.pathname !== '/' && Object.hasOwn(brand.hosts, value.source_identity) && brand.hosts[value.source_identity] === value.brand_binding_ref;
  if (value.source_kind !== 'brand_account' || !social(url.hostname) ||
    !Object.hasOwn(brand.accounts, value.source_identity) || brand.accounts[value.source_identity] !== value.brand_binding_ref) return false;
  const host = url.hostname.replace(/^www\./, '');
  const [platform, author] = value.source_identity.split(':');
  return /^[a-z0-9._]{1,30}$/.test(author ?? '') && !url.search &&
    (platform === 'instagram' && host === 'instagram.com' && /^\/(?:p|reel)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
      platform === 'threads' && ['threads.net', 'threads.com'].includes(host) &&
      url.pathname.startsWith(`/@${author}/post/`) && /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname.slice(`/@${author}/post`.length)));
}
export function verdictAllowed(value: unknown, provider: Provider, claim: Claim, policy: OfficialPolicy): value is Verdict {
  return dictionary(value) && exact(value, ['provider','model','run_id','verdict','claim','passage_hash']) &&
    value.provider === provider && token(value.model) && policy.models[provider].includes(value.model) &&
    token(value.run_id) && value.verdict === 'affirmed' && canonical(value.claim) === canonical(claim) && isDigest(value.passage_hash);
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function bytes(value: string) {
  if (value.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('encoding');
  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
  if (value !== base64(decoded)) throw new Error('encoding');
  return decoded;
}
export async function verifyAttestation(packet: unknown, policy: OfficialPolicy): Promise<SignedAttestation | null> {
  try {
    if (!dictionary(packet) || !exact(packet, ['envelope','digest','signature']) || !isDigest(packet.digest) || typeof packet.signature !== 'string') return null;
    const e = packet.envelope;
    if (!dictionary(e) || !exact(e, ['version','key_id','claim','results']) || e.version !== 1 || !token(e.key_id) ||
      !Object.hasOwn(policy.keys, e.key_id) || !claimAllowed(e.claim, policy) || !Array.isArray(e.results) || e.results.length !== 2) return null;
    for (const [index, provider] of (['deepseek','qwen'] as const).entries()) {
      const result = e.results[index];
      if (!dictionary(result)) return null;
      const { result_digest, ...verdict } = result;
      if (!verdictAllowed(verdict, provider, e.claim, policy) || !isDigest(result_digest) || await hashJson(verdict) !== result_digest) return null;
    }
    if (await hashJson(e) !== packet.digest) return null;
    const key = await crypto.subtle.importKey('spki', bytes(policy.keys[e.key_id]), { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, bytes(packet.signature), new TextEncoder().encode(canonical(e)))) return null;
    return packet as SignedAttestation;
  } catch { return null; }
}
