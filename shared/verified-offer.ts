import { canonicalUrl, filterText } from './privacy-rules';
import { configurationFields, identityToken, type Configuration, type PriceEvidence, type VerifiedPrices } from './deal-price-evidence';

export const OFFER_KIND = 'verified_offer_v2';
export const PROMOTE_OFFER = 'promote_verified_offer_v2';
export const INVALIDATE_OFFER = 'invalidate_verified_offer_v2';
export const CLOSE_OFFER = 'close_verified_offer_v2';
export const OFFER_FRESHNESS_MS = 5 * 60_000;
export const OFFER_CATEGORIES = ['stroller', 'high_chair', 'car_seat', 'bouncer', 'carrier', 'play_gym'] as const;
export type OfferCategory = typeof OFFER_CATEGORIES[number];
export type Availability = 'open' | 'ongoing' | 'scheduled' | 'unknown' | 'closed';
export const metadataFields = ['brand', 'model', 'configuration', 'seller', 'price', 'regular', 'start', 'end', 'availability', 'offer'] as const;
export type MetadataReading = Record<typeof metadataFields[number], { value: string; quote: string } | null>;
export type OfferFacts = VerifiedPrices & {
  model_id: string; brand: string; model: string; category: OfferCategory; seller_handle: string;
  seller_url: string; source_url: string; title: string; starts_at: string | null;
  deadline_precision: string; availability: Availability; image_url: string | null;
};
export type Liveness = {
  url: string; checked_at: string; seller_url: string; locator: string; product_digest: string;
  availability_badge: { value: Availability; locator: string } | null;
};
type OfferIdentity = {
  kind: typeof OFFER_KIND; offer_id: string; offer_key: string; campaign_key: string;
  revision: number; expected_version: number; digest: string; checked_at: string;
  locator: string; catalog_revision: string; content_digest: string;
};
export type VerifiedOffer = OfferIdentity & {
  facts: OfferFacts; price_evidence: PriceEvidence; metadata: [MetadataReading, MetadataReading];
  liveness: Liveness;
  closure?: { text: string; hash: string };
};
export type FailedOffer = OfferIdentity & {
  failure: { title: string; source_url: string; gates: string[]; retry_at: string | null; evidence: string };
  previous_digest: string | null;
};
export type OfferPayload = VerifiedOffer | FailedOffer;
export type OfferClaim = {
  action: typeof PROMOTE_OFFER | typeof INVALIDATE_OFFER | typeof CLOSE_OFFER; request_id: string;
  offer_key: string; revision: number; digest: string; expected_version: number;
};
export type OfferAck = { kind: typeof OFFER_KIND; id: string; offer_key: string; revision: number; digest: string; state: 'eligible' | 'published' | 'review' };
export type OfferReceipt = OfferClaim & {
  kind: typeof OFFER_KIND; candidate_id: string; promotion_id: string;
  deal_id: string | null; committed_revision: number | null; committed_at: string; created: boolean;
};

export const digestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const offerCandidateId = (id: string) => `verified-${id}`;
export function offerUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return canonicalUrl(value, true); } catch { return null; }
}
export function offerImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\#]/.test(value)) return null;
  try {
    const url = new URL(value);
    // Preserve opaque CDN signatures on image URLs.
    canonicalUrl(url.origin + url.pathname, true);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
export const offerText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && filterText(value, max) === value && !value.includes('[redacted]');
export const providerModel = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
export function canonicalOfferJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalOfferJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalOfferJson(record[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export async function offerHash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalOfferJson(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function offerDigestFields(offer: Omit<OfferPayload, 'digest'>) {
  return ['offer-evidence@2', offer];
}
export function offerRegionDigest(text: string, region: Omit<Liveness, 'checked_at' | 'product_digest'>, image: string | null) {
  return offerHash(['offer-region@2', text, region, image]);
}
export function offerKeyFields(seller: string, model: string, configuration: Configuration, campaign: string, locator: string, startsAt: string | null) {
  const identity = [seller, model, configurationFields.map(field => identityToken(configuration[field]))];
  const day = startsAt ? new Date(Date.parse(startsAt) + 9 * 3_600_000).toISOString().slice(0, 10) : null;
  const provisional = ['campaign', identity, campaign, locator];
  return { campaign: day ? [...provisional, day] : provisional, provisional,
    offer: day ? ['dated', identity, day] : provisional };
}
export function catalogIdentity(rows: { id: string; brand: string; name: string; category: string }[]) {
  return rows.filter(row => OFFER_CATEGORIES.some(category => category === row.category))
    .map(row => [row.id, row.brand, row.name, row.category]).sort((a, b) => a[0].localeCompare(b[0]));
}
export function sellerHandle(seller: string) {
  const url = new URL(seller);
  return url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '').toLowerCase() ?? url.hostname;
}
