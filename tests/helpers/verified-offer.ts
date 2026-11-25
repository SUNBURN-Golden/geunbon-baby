import { assessPriceEvidence, digest, offerDeadlinePrecision, type Configuration } from '../../shared/deal-price-evidence';
import {
  catalogIdentity, OFFER_KIND, offerCandidateId, offerDigestFields, offerHash, offerKeyFields, offerRegionDigest, PROMOTE_OFFER,
  type OfferClaim, type OfferPayload, type VerifiedOffer,
} from '../../shared/verified-offer';
import { checkedAt, exampleEvidence, mockReading, officialScope } from './verified-deal-prices';

export const verifiedFixtureModel = { id: 'model-1', brand: 'Test brand', name: 'Test model', category: 'high_chair' as const };
const model = verifiedFixtureModel;
const gyms = [
  { id: 'model-42', brand: '하베브릭스', name: '바람개비 아기체육관', category: 'play_gym' },
  { id: 'model-43', brand: 'Lovevery', name: 'The Play Gym', category: 'play_gym' },
];
export async function seal<T extends OfferPayload>(offer: T): Promise<T> {
  const { digest: _, ...body } = offer;
  void _;
  return { ...offer, digest: await offerHash(offerDigestFields(body)) };
}
export async function verifiedFixture(deal = 390000, list = 430000, sibling = '', starts_at: string | null = null,
  schedule: { checked?: string; ends?: string; catalog?: Parameters<typeof catalogIdentity>[0]; seller?: string; source?: string; configuration?: Partial<Configuration> } = {}) {
  const checked = schedule.checked ?? checkedAt;
  const url = schedule.source ?? 'https://seller.example.com/round-1';
  const seller = schedule.seller ?? 'https://seller.example.com/shop' + sibling;
  const evidence = await exampleEvidence(url, deal, list);
  const labels = { brand: '브랜드', model: '모델', generation: '세대', option: '옵션', quantity: '수량', bundle: '구성' };
  for (const kind of ['offer', 'official'] as const) {
    const capture = evidence[kind]!;
    let text = capture.source.text;
    for (const [field, value] of Object.entries(schedule.configuration ?? {})) {
      const prefix = labels[field as keyof Configuration] + ': ';
      text = text.split('\n').map(line => line.startsWith(prefix) ? prefix + value : line).join('\n');
    }
    if (kind === 'offer') {
      if (schedule.ends) text = text.replace(/^마감일:.*$/m, `마감일: ${schedule.ends}`);
      if (starts_at) text += '\n공구 시작일: ' + starts_at;
    }
    capture.source = { ...capture.source, text, hash: await digest(text), observed_at: checked };
    const reading = mockReading(text, kind === 'official');
    capture.readings = [reading, structuredClone(reading)];
  }
  const scope = { ...officialScope, variant: { id: 'fixture-' + sibling, site_model_id: model.id, catalog_id: 'fixture', configuration: evidence.offer!.readings[0]!.configuration!,
    brand_aliases: [] as string[], model_aliases: [] as string[], skus: [] as string[] } };
  evidence.official_approval = { id: scope.id, revision: scope.revision, variant: scope.variant };
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
    expected_version: 0, revision: 1, checked_at: checked, locator,
    catalog_revision: await offerHash(catalogIdentity(schedule.catalog ?? [model, ...gyms])), content_digest,
    facts: { ...prices, model_id: model.id, brand: model.brand, model: model.name, category: model.category, seller_handle: new URL(seller).pathname.slice(1),
      seller_url: seller, source_url: url, title: 'Verified fixture', starts_at,
      availability: starts_at && starts_at > checked ? 'scheduled' : 'unknown',
      deadline_precision: offerDeadlinePrecision(reading)!, image_url: image },
    price_evidence: evidence, metadata: [metadata, structuredClone(metadata)],
    liveness: { ...liveness, checked_at: checked, product_digest: content_digest },
  });
  return { id: offerCandidateId(payload.offer_id), offer: payload, scope };
}
export async function requestClaim(offer: OfferPayload, action: OfferClaim['action'] = PROMOTE_OFFER): Promise<OfferClaim> {
  return { action, request_id: await offerHash([action, offer.offer_id, offer.revision, offer.digest]),
    revision: offer.revision, digest: offer.digest, offer_key: offer.offer_key, expected_version: offer.expected_version };
}
