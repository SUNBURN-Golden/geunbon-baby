import { expect, test, vi } from 'vitest';
import { deliverOffer, identityFor, newOffer, offerKeys, publicationClient, stageOffer, type SiteClient } from '../crawler/src/offers/delivery';
import type { OfferTransport } from '../crawler/src/offers/transport';
import { OFFER_KIND, offerCandidateId } from '../shared/verified-offer';
import { checkedAt } from './helpers/verified-deal-prices';
import { temporaryOfferStore } from './helpers/offer-store';
import { requestClaim, verifiedFixture } from './helpers/verified-offer';

test('requires an exact ack and reconciles a lost promotion response after freshness expires', async () => {
  let now = Date.parse(checkedAt);
  const f = temporaryOfferStore(() => now);
  try {
    const { offer, id } = await verifiedFixture();
    f.store.transaction(await stageOffer(f.store, offer));
    const claim = await requestClaim(offer);
    const receipt = { ...claim, kind: OFFER_KIND, candidate_id: id, deal_id: 'deal-' + id, promotion_id: claim.request_id,
      committed_at: checkedAt, committed_revision: 1, created: true };
    let matches = false;
    const site: SiteClient = vi.fn(async (path, method, body) => {
      if (path === '/api/v1/ingest') {
        expect(body).toEqual(offer);
        return { status: 202, data: { kind: OFFER_KIND, id, state: 'eligible', offer_key: offer.offer_key,
          revision: offer.revision, digest: matches ? offer.digest : '0'.repeat(64) } };
      }
      expect(path).toContain(id);
      if (method === 'GET') return { status: 200, data: receipt };
      expect(body).toEqual(claim);
      throw new Error('fixture response lost');
    });
    expect(await deliverOffer(f.store, site)).toBe(true);
    expect(site).toHaveBeenCalledTimes(1);
    matches = true;
    now += 60000;
    expect(await deliverOffer(f.store, site)).toBe(true);
    expect(site).toHaveBeenCalledTimes(3);
    now += 360000;
    f.reopen();
    expect(await deliverOffer(f.store, site)).toBe(true);
    expect(site).toHaveBeenCalledTimes(4);
    expect(f.store.db.prepare("SELECT count(*) n FROM offer_metric_events WHERE kind='publication'").get()).toEqual({ n: 1 });
    expect(await deliverOffer(f.store, site)).toBe(false);
  } finally { f.close(); }
});

test('binds each credential to its HTTPS endpoint and never follows redirects', async () => {
  const fixtureTokens = { ingest: 'fixture-ingest-token-unshared', admin: 'fixture-admin-token-unshared' };
  const read = vi.fn(async (path: string) => path.endsWith('ingest_token') ? fixtureTokens.ingest : fixtureTokens.admin);
  const send = vi.fn(async () => ({ status: 302, body: '', headers: { location: 'https://other.example.com/' } }));
  const site = publicationClient('https://test.example.com', send as unknown as OfferTransport, read);
  const admin = '/api/v1/admin/candidates/' + offerCandidateId('0'.repeat(64));
  await expect(site('https://other.example.com/api/v1/ingest','POST',{})).rejects.toThrow('offer_endpoint_invalid');
  await expect(site('/api/v1/ingest?next=somewhere','POST',{})).rejects.toThrow('offer_endpoint_invalid');
  expect(read).not.toHaveBeenCalled();
  expect((await site('/api/v1/ingest','POST',{ kind: 'fixture' })).status).toBe(302);
  expect((await site(admin,'POST',{})).status).toBe(302);
  expect(send.mock.calls).toEqual([
    ['https://test.example.com/api/v1/ingest', expect.objectContaining({ body: '{"kind":"fixture"}',
      headers: expect.objectContaining({ authorization: 'Bearer ' + fixtureTokens.ingest }) })],
    ['https://test.example.com' + admin, expect.objectContaining({ body: '{}',
      headers: expect.objectContaining({ authorization: 'Bearer ' + fixtureTokens.admin }) })],
  ]);
  expect(read.mock.calls.map(([file]) => file.split('/').at(-1))).toEqual(['agamajung_ingest_token', 'agamajung_admin_token']);
});

test('dated cross-posts deduplicate, a provisional campaign reconciles, and a later round remains distinct', async () => {
  const f = temporaryOfferStore(() => Date.parse(checkedAt));
  try {
    const { offer } = await verifiedFixture();
    const keys = await offerKeys(offer.facts, offer.locator);
    const { digest: _, offer_id: __, revision: ___, expected_version: ____, kind: _____, ...draft } = offer;
    void [_,__,___,____,_____];
    const provisional = await newOffer(f.store, { ...draft, offer_key: keys.offer_key, campaign_key: keys.campaign_key });
    if (!provisional || provisional === 'collision' || !('facts' in provisional)) throw new Error('fixture');
    f.store.transaction(await stageOffer(f.store, provisional));
    const facts = { ...offer.facts, starts_at: '2026-11-20T15:00:00.000Z' };
    const { provisional: alias, ...dated } = await offerKeys(facts, offer.locator);
    expect(identityFor(f.store, dated, alias)).toMatchObject({ id: provisional.offer_id });
    const reconciled = await newOffer(f.store, { ...draft, ...dated, facts }, undefined, alias);
    if (!reconciled || reconciled === 'collision') throw new Error('fixture');
    f.store.transaction(await stageOffer(f.store, reconciled));
    const crossPost = await offerKeys({ ...facts, source_url: 'https://other.example.com/post' }, 'secondary-post');
    expect(identityFor(f.store, crossPost)).toMatchObject({ id: provisional.offer_id });
    const later = await offerKeys({ ...facts, starts_at: '2026-11-22T15:00:00.000Z' }, offer.locator);
    expect(identityFor(f.store, later, later.provisional)).toBeNull();
  } finally { f.close(); }
});
