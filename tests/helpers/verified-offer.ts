import { assessPriceEvidence, digest, offerDeadlinePrecision } from '../../shared/deal-price-evidence';
import {
  catalogIdentity, OFFER_KIND, offerCandidateId, offerDigestFields, offerHash, offerKeyFields, offerRegionDigest, PROMOTE_OFFER,
  type OfferClaim, type OfferPayload, type VerifiedOffer,
} from '../../shared/verified-offer';
import { checkedAt, exampleEvidence, mockReading, officialScope } from './verified-deal-prices';

const model = { id: 'model-1', brand: 'Test brand', name: 'Test model', category: 'high_chair' as const };
const gyms = [
  { id: 'model-42', brand: '하베브릭스', name: '바람개비 아기체육관', category: 'play_gym' },
  { id: 'model-43', brand: 'Lovevery', name: 'The Play Gym', category: 'play_gym' },
];
export async function seal<T extends OfferPayload>(offer: T): Promise<T> {
  const { digest: _, ...body } = offer;
  void _;
  return { ...offer, digest: await offerHash(offerDigestFields(body)) };
}
export async function verifiedFixture(deal = 390000, list = 430000, sibling = '', starts_at: string | null = null) {
  const url = 'https://seller.example.com/round-1';
  const seller = 'https://seller.example.com/shop' + sibling;
  const evidence = await exampleEvidence(url, deal, list);
  const scope = { ...officialScope, variant: { id: 'fixture-' + sibling, site_model_id: model.id, catalog_id: 'fixture', configuration: evidence.offer!.readings[0]!.configuration!,
    brand_aliases: [] as string[], model_aliases: [] as string[], skus: [] as string[] } };
  evidence.official_approval = { id: scope.id, revision: scope.revision, variant: scope.variant };
  if (starts_at) {
    const day = new Date(Date.parse(starts_at) + 9 * 3600000).toISOString().slice(0, 10);
    const text = evidence.offer!.source.text + '\n공구 시작일: ' + day;
    evidence.offer!.source = { ...evidence.offer!.source, text, hash: await digest(text) };
    const reading = mockReading(text, false);
    evidence.offer!.readings = [reading, structuredClone(reading)];
  }
  const prices = assessPriceEvidence(evidence).facts!;
  const reading = evidence.offer!.readings[0]!;
  const metadata = {
    brand: { value: model.brand, quote: reading.identity!.brand.quote }, model: { value: model.name, quote: reading.identity!.model.quote },
    configuration: null, seller: { value: seller, quote: seller }, offer: { value: url, quote: url },
    start: starts_at ? { value: starts_at, quote: evidence.offer!.source.text.split('\n').at(-1)! } : null,
    end: null, price: null, regular: null, availability: null,
  };
  const locator = 'product:' + (sibling || 'a');
  const keys = offerKeyFields(seller, model.id, prices.configuration, url, locator, starts_at);
  const offer_key = await offerHash(keys.offer);
  const liveness = { url, seller_url: seller, locator, availability_badge: null };
  const image = 'https://seller.example.com/a.jpg';
  const content_digest = await offerRegionDigest(evidence.offer!.source.text, liveness, image);
  const payload: VerifiedOffer = await seal({
    kind: OFFER_KIND, offer_id: await offerHash(['fixture', offer_key]), offer_key, campaign_key: await offerHash(keys.campaign), digest: '',
    expected_version: 0, revision: 1, checked_at: checkedAt, locator,
    catalog_revision: await offerHash(catalogIdentity([model, ...gyms])), content_digest,
    facts: { ...prices, model_id: model.id, brand: model.brand, model: model.name, category: model.category, seller_handle: 'shop' + sibling,
      seller_url: seller, source_url: url, title: 'Verified fixture', starts_at,
      availability: starts_at && starts_at > checkedAt ? 'scheduled' : 'unknown',
      deadline_precision: offerDeadlinePrecision(reading)!, image_url: image },
    price_evidence: evidence, metadata: [metadata, structuredClone(metadata)],
    liveness: { ...liveness, checked_at: checkedAt, product_digest: content_digest },
  });
  return { id: offerCandidateId(payload.offer_id), offer: payload, scope };
}
export async function requestClaim(offer: OfferPayload, action: OfferClaim['action'] = PROMOTE_OFFER): Promise<OfferClaim> {
  return { action, request_id: await offerHash([action, offer.offer_id, offer.revision, offer.digest]),
    revision: offer.revision, digest: offer.digest, offer_key: offer.offer_key, expected_version: offer.expected_version };
}
