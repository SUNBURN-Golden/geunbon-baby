import { homeDeals } from '../lib/home-deals';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { DealCard } from '../app/deals/_components';
import { dealSelect, type DealWithContext } from '../lib/deals';
import { ingestVerifiedOffer, mutateVerifiedOffer, verifiedOfferReviewPage } from '../lib/verified-offers';
import { syncOfficialPriceScopes } from '../lib/official-price-sources';
import { CLOSE_OFFER, INVALIDATE_OFFER, offerRegionDigest, type FailedOffer } from '../shared/verified-offer';
import { digest } from '../shared/deal-price-evidence';
import { checkedAt } from './helpers/verified-deal-prices';
import { api, execute, legacy, migrate } from './helpers/deal-timestamps';
import { memoryD1 } from './helpers/sqlite';
import { requestClaim, seal, verifiedFixture } from './helpers/verified-offer';

const now = Date.parse(checkedAt);
test('binds both prices to proof and version, withdraws immediately, republishes, closes and replays', async () => {
  const { db, close } = memoryD1({ serialize: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    await migrate(db);
    const { offer, id, scope } = await verifiedFixture();
    expect(await syncOfficialPriceScopes(db, { scopes: [scope], observed_at: checkedAt })).toBeNull();
    const noScopes = { scopes: [], observed_at: new Date(now + 1000).toISOString() };
    expect(await syncOfficialPriceScopes(db, noScopes)).toBe('invalid_source_approvals');
    expect(await db.prepare('SELECT json_array_length(scopes) AS n FROM official_price_approvals').first()).toEqual({ n: 1 });
    const submit = await ingestVerifiedOffer(db, offer, now);
    expect(submit.status, await submit.text()).toBe(202);
    const claim = await requestClaim(offer);
    const secondClaim = { ...claim, request_id: 'f'.repeat(64) };
    const operations = await Promise.all([
      mutateVerifiedOffer(db, id, claim, false, now),
      mutateVerifiedOffer(db, id, secondClaim, false, now),
    ]);
    expect(operations.map(result => result.status).sort()).toEqual([200,409]);
    const winner = operations[0].status === 200 ? claim : secondClaim;
    const replay = () => mutateVerifiedOffer(db, id, winner, false, now + 7 * 86400000);
    const receipt = await (await replay()).json();
    expect(receipt).toMatchObject({ data: { deal_id: 'deal-' + id, committed_revision: 1, created: true } });
    const listed = () => db.prepare(dealSelect(now)).first<DealWithContext>();
    const deal = await listed();
    expect(deal).toMatchObject({ model_id: 'model-1', discount_pct: 9, deal_price_krw: 390000,list_price_krw: 430000, ends_at: '2026-11-24T14:59:59.999Z' });
    const html = renderToStaticMarkup(createElement(DealCard, { deal: deal!, nowMs: now }));
    expect(html).toContain('정가보다 9% 싸요');
    expect(html).toContain('https://seller.example.com/a.jpg');
    expect(await db.prepare('SELECT source_url FROM ingested_items WHERE id=?').bind(deal!.id).first()).toEqual({ source_url: offer.facts.source_url + '#agamajung-' + id });
    expect(await db.prepare('SELECT target_kind,target_id,target_revision FROM deal_price_evidence').first()).toEqual({
      target_kind: 'deal', target_id: deal!.id, target_revision: '1',
    });
    const { facts: _, metadata: __, price_evidence: ___, liveness: ____, ...identity } = offer;
    void [_,__,___,____];
    const failure: FailedOffer = await seal({ ...identity, revision: 2, expected_version: 1, previous_digest: offer.digest,
      failure: { title: 'Changed fixture', source_url: offer.facts.source_url, gates: ['source_changed','missing_deadline'], retry_at: null, evidence: '공구 종료일 확인 필요' } });
    expect((await ingestVerifiedOffer(db, failure, now)).status).toBe(202);
    expect(await listed()).toBeNull();
    const privateReview = await api(db)('admin/candidates?kind=verified_offer_v2&state=review');
    expect(await privateReview.json()).toMatchObject({ data: [{ title: 'Changed fixture', gates: ['source_changed','missing_deadline'] }] });
    const invalidation = await requestClaim(failure, INVALIDATE_OFFER);
    expect(await (await mutateVerifiedOffer(db,id,invalidation,false,now)).json()).toMatchObject({ data: { committed_revision: 2 } });
    expect(await (await replay()).json()).toEqual(receipt);
    const updated = await seal({ ...offer, revision: 3, expected_version: 2 });
    expect((await ingestVerifiedOffer(db,updated,now)).status).toBe(202);
    expect((await mutateVerifiedOffer(db,id,await requestClaim(updated),false,now)).status).toBe(200);
    expect(await verifiedOfferReviewPage(db)).toEqual({ data: [], next_cursor: null });
    const capturedClosure = '공구 종료';
    const closureRegion = { url: offer.facts.source_url, seller_url: offer.facts.seller_url,
      locator: offer.locator, availability_badge: { value: 'closed' as const, locator: 'product:closed' } };
    const content_digest = await offerRegionDigest(capturedClosure, closureRegion, offer.facts.image_url);
    const closed = await seal({ ...updated, revision: 4, expected_version: 3, content_digest, facts: { ...updated.facts, availability: 'closed' as const },
      closure: { text: capturedClosure, hash: await digest(capturedClosure) },
      liveness: { ...closureRegion, checked_at: checkedAt, product_digest: content_digest } });
    expect((await ingestVerifiedOffer(db,closed,now)).status).toBe(202);
    const closeResponse = await mutateVerifiedOffer(db,id,await requestClaim(closed,CLOSE_OFFER),false,now);
    expect(closeResponse.status, await closeResponse.text()).toBe(200);
    expect(await listed()).toMatchObject({ source_ended: 1, deal_price_krw: 390000 });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally { close(); vi.useRealTimers(); }
});

test('updates a populated 0016 database and supports the legacy ingest uniqueness target', async () => {
  const { db, close } = memoryD1();
  try {
    await migrate(db, '0016');
    await legacy(db, 'old', '2026-11-01T00:00:00.000Z', '2026-11-24T14:59:59.999Z');
    const before = await db.prepare('SELECT id,source_url,price,version FROM deals').all();
    for (const name of ['0017_verified_offers.sql','0018_play_gyms.sql']) await execute(db, await readFile(new URL('../migrations/' + name, import.meta.url),'utf8'));
    expect(await db.prepare('SELECT id,source_url,price,version FROM deals').all()).toEqual(before);
    await db.prepare("INSERT INTO ingested_items(id,source_url,account,text,kind,captured_at) VALUES ('duplicate','https://www.instagram.com/p/old/','a','b','post','2026-11-01') ON CONFLICT(source_url) DO NOTHING").run();
    expect(await db.prepare("SELECT count(*) n FROM ingested_items").first()).toEqual({ n: 1 });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare("SELECT id,official_price FROM models WHERE category='play_gym' ORDER BY id").all()).toMatchObject({
      results: [{ id: 'model-42', official_price: null },{ id: 'model-43', official_price: null }],
    });
  } finally { close(); }
});

test('legacy collision works in both write orders and siblings keep exact URLs', async () => {
  for (const order of ['legacy_first','typed_first']) {
    const { db, close } = memoryD1();
    try {
      await migrate(db);
      const { offer, id, scope } = await verifiedFixture();
      const sibling = await verifiedFixture(390000,430000,'b');
      const url = offer.facts.source_url;
      await db.prepare('INSERT INTO official_price_approvals VALUES(1,?,?)').bind(checkedAt,JSON.stringify([scope,sibling.scope])).run();
      const writeLegacy = async () => {
        await db.prepare("INSERT INTO ingested_items(id,source_url,account,text,kind,captured_at,status) VALUES ('legacy',?,'legacy','fixture','external_web',?,'approved')").bind(url,checkedAt).run();
        return db.prepare("INSERT INTO deals(id,model_id,seller_id,title,source_url,verify_level,checked,origin) VALUES ('legacy','model-1','seller-1','Legacy',?,'manual',?,'external_web')").bind(url,checkedAt).run();
      };
      if (order === 'legacy_first') await writeLegacy();
      expect((await ingestVerifiedOffer(db,offer,now)).status).toBe(202);
      const result = await mutateVerifiedOffer(db,id,await requestClaim(offer),false,now);
      if (order === 'legacy_first') {
        expect(result.status).toBe(409);
        expect((await db.prepare("SELECT id FROM ingested_items").all()).results).toEqual([{ id: 'legacy' }]);
        expect(await db.prepare("SELECT count(*) n FROM deal_price_evidence").first()).toEqual({ n: 0 });
      } else {
        expect(result.status).toBe(200);
        expect((await ingestVerifiedOffer(db,sibling.offer,now)).status).toBe(202);
        expect((await mutateVerifiedOffer(db,sibling.id,await requestClaim(sibling.offer),false,now)).status).toBe(200);
        await expect(writeLegacy()).rejects.toThrow('offer_source_conflict');
        expect((await db.prepare('SELECT source_url FROM deals ORDER BY id').all()).results).toEqual([{ source_url: url },{ source_url: url }]);
      }
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally { close(); }
  }
});

test('home compares accepted exact configurations across ended, invalidated and withdrawn rounds', async () => {
  const { db, close } = memoryD1({ serialize: true });
  const readHome = (at: number) => homeDeals(db, at, { brand: 'Test brand', category: 'high_chair' });
  const opens = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const later = new Date(now + 86_400_001).toISOString();
  const fixtures = {
    old: await verifiedFixture(390000,430000,'old', opens(4)),
    current: await verifiedFixture(390000,430000,'current', opens(2), { checked: later }),
    dupe: await verifiedFixture(390000,430000,'dupe', opens(1), { checked: later, seller: 'https://seller.example.com/shopcurrent' }),
    conflict: await verifiedFixture(400000,430000,'conflict', opens(0), { checked: later, seller: 'https://seller.example.com/shopcurrent' }),
    kit: await verifiedFixture(360000,430000,'kit', opens(1), { checked: later, configuration: { bundle: '의자 1개, 키트 1개' } }),
    generation: await verifiedFixture(360000,430000,'gen', opens(1), { checked: later, configuration: { generation: '3세대' } }),
    option: await verifiedFixture(360000,430000,'option', opens(1), { checked: later, configuration: { option: 'White' } }),
    quantity: await verifiedFixture(360000,430000,'qty', opens(1), { checked: later, configuration: { quantity: '2개' } }),
    cheaper: await verifiedFixture(380000,430000,'cheaper', opens(1), { checked: later }),
  };
  async function publish(fixture: typeof fixtures.old, offer = fixture.offer) {
    const instant = Date.parse(offer.checked_at);
    const accepted = await ingestVerifiedOffer(db,offer,instant);
    expect(accepted.status, await accepted.text()).toBe(202);
    const committed = await mutateVerifiedOffer(db,fixture.id,await requestClaim(offer),false,instant);
    expect(committed.status, await committed.text()).toBe(200);
    return 'deal-' + fixture.id;
  }
  async function round(id: string, event_key: string, opened_at: string, expected_version = 1) {
    const seller = await db.prepare('SELECT seller_id FROM deals WHERE id=?').bind(id).first<{ seller_id: string }>();
    expect((await api(db)(`admin/deals/${id}/round`, { action: 'confirm', confirmed: true, expected_version, event_key, opened_at,
      seller_id: seller!.seller_id, source_url: 'https://seller.example.com/round-evidence' })).status).toBe(200);
  }
  const section = (inventory: Awaited<ReturnType<typeof readHome>>, key: 'low' | 'new') => inventory.sections.find(s => s.key === key)!.deals;
  const voidOffer = async (fixture: typeof fixtures.old, expected_version = 1) => {
    const { facts: _, metadata: __, price_evidence: ___, liveness: ____, ...base } = fixture.offer;
    void [_, __, ___, ____];
    const failure: FailedOffer = await seal({ ...base, revision: 2, expected_version, previous_digest: fixture.offer.digest, checked_at: later,
      failure: { title: 'Changed', source_url: fixture.offer.facts.source_url, gates: ['source_changed'], retry_at: null, evidence: '공구 정보 변경' } });
    expect((await ingestVerifiedOffer(db, failure, Date.parse(later))).status).toBe(202);
  };
  try {
    await migrate(db);
    await db.prepare('INSERT INTO official_price_approvals VALUES(1,?,?)').bind(checkedAt,
      JSON.stringify(Object.values(fixtures).map(f => f.scope))).run();
    const old = await publish(fixtures.old);
    await round(old, 'earlier', opens(4));
    expect(section(await readHome(now), 'low')).toEqual([]);
    expect(section(await readHome(now), 'new').map(d => d.id)).toEqual([old]);

    const captured = '공구 종료';
    const { offer } = fixtures.old;
    const region = { url: offer.facts.source_url, seller_url: offer.facts.seller_url, locator: offer.locator,
      availability_badge: { value: 'closed' as const, locator: 'product:closed' } };
    const content_digest = await offerRegionDigest(captured, region, offer.facts.image_url);
    const closed = await seal({ ...offer, revision: 2, expected_version: 1, content_digest, facts: { ...offer.facts, availability: 'closed' as const },
      closure: { text: captured, hash: await digest(captured) },
      liveness: { ...region, checked_at: checkedAt, product_digest: content_digest } });
    expect((await ingestVerifiedOffer(db, closed, now)).status).toBe(202);
    expect((await mutateVerifiedOffer(db,fixtures.old.id,await requestClaim(closed,CLOSE_OFFER),false,now)).status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM deal_price_history').first()).toEqual({ count: 1 });

    await db.prepare('UPDATE official_price_approvals SET scopes=?').bind(
      JSON.stringify(Object.values(fixtures).slice(1).map(f => f.scope))).run();
    const current = await publish(fixtures.current);
    await round(current, 'current-event', opens(2));
    const instant = Date.parse(later);
    expect(section(await readHome(instant), 'low').map(d => d.id)).toEqual([current]);
    const dupe = await publish(fixtures.dupe);
    await round(dupe, 'current-event', opens(2));
    const lows = section(await readHome(instant), 'low');
    expect(lows.map(d => d.id)).toEqual([current, dupe].sort());
    expect(lows.map(d => d.seller_round_number)).toEqual([1, 1]);

    const conflict = await publish(fixtures.conflict);
    await round(conflict, 'current-event', opens(2));
    expect(section(await readHome(instant), 'low')).toEqual([]);
    await voidOffer(fixtures.conflict);
    expect(section(await readHome(instant), 'low').map(d => d.id)).toEqual([current, dupe].sort());

    for (const variant of [fixtures.kit, fixtures.generation, fixtures.option, fixtures.quantity]) await publish(variant);
    expect(section(await readHome(instant), 'low').map(d => d.id)).toEqual([current, dupe].sort());

    const cheaper = await publish(fixtures.cheaper);
    expect(section(await readHome(instant), 'low')).toEqual([]);
    await voidOffer(fixtures.cheaper);
    const updated = await seal({ ...fixtures.cheaper.offer, revision: 3, expected_version: 2 });
    expect(await db.prepare('SELECT price_evidence_id FROM invalidated_publication_proofs WHERE deal_id=?').bind(cheaper).first()).toEqual({
      price_evidence_id: (await requestClaim(fixtures.cheaper.offer)).request_id,
    });
    expect(section(await readHome(instant), 'low').map(d => d.id)).toEqual([current, dupe].sort());
    await publish(fixtures.cheaper, updated);
    expect(section(await readHome(instant), 'low')).toEqual([]);
    expect((await api(db)(`admin/deals/${cheaper}`, { action: 'withdraw', expected_version: 3, request_id: 'history-withdraw-lower', reason: 'Verified withdrawal evidence' })).status).toBe(200);
    expect(section(await readHome(instant), 'low').map(d => d.id)).toEqual([current, dupe].sort());
    expect((await api(db)(`admin/deals/${old}`, { action: 'withdraw', expected_version: 2, request_id: 'history-withdraw-early', reason: 'Verified withdrawal evidence' })).status).toBe(200);
    expect(section(await readHome(instant), 'low')).toEqual([]);
  } finally { close(); }
});
