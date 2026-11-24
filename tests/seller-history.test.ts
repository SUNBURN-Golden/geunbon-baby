import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawStore } from '../crawler/engine/raw-store';
import { applyPacket } from '../crawler/src/history/transport';
import { checkExtraction, validateExtraction } from '../crawler/src/deepseek-web/extract';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
import type { PriceCompletion } from '../crawler/src/deal-prices/verify';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { campaignDetail, historyConfigurations, modelPriceHistory, sellerCampaignPage, sellerProfile } from '../lib/deals';
import { manageOfficialSeller } from '../lib/official-sellers';
import { canonical, hashJson, type OfficialPolicy } from '../shared/official-seller';
import { attestOfficialSeller, type Adapter } from '../crawler/src/history/official-verifier';
import { collectorSnapshot, fetchInventory, reconcileHistory } from '../crawler/src/history/reconcile';
import { ingestVerifiedOffer, mutateVerifiedOffer } from '../lib/verified-offers';
import { digest, PRICE_MODELS } from '../shared/deal-price-evidence';
import { offerRegionDigest, type VerifiedOffer } from '../shared/verified-offer';
import { sellersCopy } from '../lib/copy/sellers.ko';
import { DealCard } from '../app/deals/_components';
import { PriceHistory } from '../app/sellers/_price-history';
import SellerPage from '../app/sellers/[handle]/page';
import ModelPage from '../app/models/[id]/page';
import { api, execute, migrate } from './helpers/deal-timestamps';
import { checkedAt, exampleEvidence, mockReading, offerHtml, officialScope, officialUrl } from './helpers/verified-deal-prices';
import { requestClaim, seal, verifiedFixture } from './helpers/verified-offer';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(), environment: () => ({ DB: context.db }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
let memory: ReturnType<typeof memoryD1>;
let get: ReturnType<typeof api>;
const start = Date.parse(checkedAt);
const source = 'https://seller.example.com/round-1';
const merchant = 'https://seller.example.com/shop';
const schema = new URL('../migrations/0019_seller_history.sql', import.meta.url);

beforeEach(async () => {
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(start);
  memory = memoryD1({serialize:true});
  context.db = memory.db; get = api(memory.db);
  await migrate(memory.db);
});
afterEach(() => { memory.close(); vi.useRealTimers(); });

async function scopes(db: D1Database, scope: object) {
  await db.prepare('INSERT INTO official_price_approvals VALUES (1,?,?)')
    .bind(checkedAt,JSON.stringify([scope])).run();
}
async function publish(db: D1Database, offer: VerifiedOffer, id: string) {
  const ingest = await ingestVerifiedOffer(db,offer);
  expect(ingest.status,await ingest.text()).toBe(202);
  const claim = await requestClaim(offer);
  const result = await mutateVerifiedOffer(db,id,claim);
  expect(result.status,await result.text()).toBe(200);
  return 'deal-' + id;
}
async function updateOffer(amount: number, revision: number, expected: number, time: string, round?: string) {
  const {offer,id,scope} = await verifiedFixture(amount,430000,'','2026-10-31T15:00:00.000Z');
  const proof = offer.price_evidence;
  if (round) proof.offer!.source.text += '\n공구 회차: ' + round;
  proof.offer!.source.hash = await digest(proof.offer!.source.text);
  proof.offer!.source.observed_at = time;
  proof.official!.source.observed_at = time;
  const {product_digest:_,checked_at:__,...region} = offer.liveness;
  void [_,__];
  const content = await offerRegionDigest(proof.offer!.source.text,region,offer.facts.image_url);
  return {id,scope,offer:await seal({...offer,revision,expected_version:expected,checked_at:time,content_digest:content,
    facts:{...offer.facts,price_checked_at:time},liveness:{...region,checked_at:time,product_digest:content}})};
}

test('verified revisions publish immediately, retain returning prices, and retract the targeted low', async () => {
  const db = memory.db;
  const startFixture = await updateOffer(390000,1,0,checkedAt);
  await scopes(db,startFixture.scope);
  let dealId = '';
  for (const [index,amount] of [390000,370000,390000,390000].entries()) {
    const at = new Date(start+index*1000).toISOString();
    vi.setSystemTime(at);
    const f = await updateOffer(amount,index+1,index,at);
    dealId = await publish(db,f.offer,f.id);
    const detail = await campaignDetail(db,dealId,Date.now());
    expect(detail).toMatchObject({seller_handle:'shop',seller_ordinal:1,offer:{amount,record_low:index<2}});
  }
  const apiChart = await get('models/model-1/price-history?limit=1');
  expect(apiChart.status).toBe(200);
  const history = await apiChart.json<{data:[{amount:number}];minimum:{amount:number};observation_count:number;next_cursor:string}>();
  expect(history).toMatchObject({data:[{amount:390000}],minimum:{amount:370000},observation_count:3});
  expect(history.next_cursor).toBeTruthy();
  expect(await (await get('deals')).json()).toMatchObject({data:[{id:dealId,price:390000,seller_ordinal:1,offer:{record_low:false}}]});
  expect(await (await get('models/model-1')).json()).toMatchObject({data:{comparison:{current:{active_count:1,lowest_price:390000}}}});
  const configuration = (await historyConfigurations(db,'model-1'))[0];
  const historical = await modelPriceHistory(db,'model-1',configuration.configuration_key,new URLSearchParams(),Date.now(),null,configuration.scope);
  expect(historical.data.map(p=>p.amount)).toEqual([390000,370000,390000]);
  const low = historical.data[1];
  const retract = {request_id:'retract-low',reason:'Original price evidence was corrected',observation_id:low.id,
    campaign_id:low.campaign_id,expected_version:1};
  expect((await get('admin/history-retract',retract)).status).toBe(200);
  expect((await get('admin/history-retract',retract)).status).toBe(200);
  const current = await campaignDetail(db,dealId,Date.now());
  const card = renderToStaticMarkup(createElement(DealCard,{deal:current!,nowMs:Date.now()}));
  expect(card).toContain(sellersCopy.lowest);
  expect(card).toContain(sellersCopy.ordinal(1));
  expect(card).toContain('정가보다 9% 싸요');
  vi.setSystemTime(start+86_400_000+5000);
  expect((await get(`deals/${dealId}`)).status).toBe(404);
  expect(await sellerProfile(db,'shop',Date.now())).toMatchObject({total:1,first_seen:{observed_at:checkedAt}});
  expect(await modelPriceHistory(db,'model-1',configuration.configuration_key,new URLSearchParams(),Date.now()))
    .toMatchObject({observation_count:2,minimum:{amount:390000}});
});

test('historical imports preserve URL uniqueness, aggregate two rounds and follow off-page links', async () => {
  const db = memory.db;
  await scopes(db,officialScope);
  await db.prepare("UPDATE sellers SET handle='known-shop' WHERE id='seller-1'").run();
  await db.prepare("INSERT INTO seller_identity_aliases VALUES ('storefront',?,'seller-1',?,'original')").bind(merchant,merchant).run();
  const build = async (round: number, id: string, amount = 390000, permalink = source) => {
    const proof = await exampleEvidence(permalink,amount);
    proof.offer!.source.text += `\n판매처: ${merchant}\n공구 회차: ${round}` + (permalink===source ? '' : `\n공구 공지: ${source}`);
    proof.offer!.source.hash = await digest(proof.offer!.source.text);
    return {observation:{namespace:'review-queue',record_key:id,revision_key:'record-1',item_key:'offer',
      source_url:permalink,observed_at:'2026-11-22',precision:'day'},
      seller_id:'seller-1',seller_url:merchant,model_id:'model-1',title:`Round ${round}`,locator:'product:1',price_evidence:proof};
  };
  const packet = {request_id:'history-packet',reason:'Original archived campaign and price proofs',items:[
    await build(1,'old-1'),await build(1,'old-cross',390000,'https://other.example.com/announcement'),
    await build(2,'old-2',370000),
  ]};
  const response = await get('admin/history-import',packet);
  expect(response.status,await response.clone().text()).toBe(200);
  const receipt = await response.json<{data:{campaigns:string[];observations:string[]}}>();
  expect(receipt.data.campaigns).toHaveLength(2);
  expect(await (await get('admin/history-import',packet)).json()).toEqual(receipt);
  expect((await get('admin/history-import',{...packet,reason:'A different reason for same key'})).status).toBe(409);
  expect(await db.prepare('SELECT count(*) AS n FROM deals').first()).toEqual({n:0});
  expect(await sellerProfile(db,'known-shop',Date.now())).toMatchObject({total:2,brands:['Test brand'],first_seen:{precision:'day'}});
  const [page,next] = await Promise.all([
    sellerCampaignPage(db,'seller-1',new URLSearchParams({limit:'1'}),Date.now()),
    sellerCampaignPage(db,'seller-1',new URLSearchParams({round:receipt.data.campaigns[1]}),Date.now()),
  ]);
  expect(page.next_cursor).toBeTruthy();
  expect(next.data[0].id).toBe(receipt.data.campaigns[1]);
  const html = renderToStaticMarkup(await SellerPage({params:Promise.resolve({handle:'known-shop'}),
    searchParams:Promise.resolve({round:receipt.data.campaigns[1]})}));
  expect(html).toContain(sellersCopy.history);
  expect(html).toContain(sellersCopy.listPrice);
  expect(html).toContain(source);
  const [config] = await historyConfigurations(db,'model-1');
  const history = await modelPriceHistory(db,'model-1',config.configuration_key,new URLSearchParams({limit:'1'}),Date.now());
  const chart = renderToStaticMarkup(createElement(PriceHistory,{history}));
  expect(chart).toContain(sellersCopy.lowest);
  expect(chart).toContain(sellersCopy.chartTitle);
  expect(chart).toContain('370,000원');
  expect(await db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({results:[]});
});

test.each(['brand_site','brand_account'] as const)('automatically activates %s evidence and keeps revoked replays inactive', async source_kind => {
  const { offer,id,scope } = await updateOffer(390000,1,0,checkedAt);
  await scopes(memory.db,scope);
  const dealId = await publish(memory.db,offer,id);
  const deal = (await campaignDetail(memory.db,dealId,start))!;
  const keypair = await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const key = Buffer.from(await crypto.subtle.exportKey('spki',keypair.publicKey)).toString('base64url');
  const site = source_kind==='brand_site';
  const source_identity = site ? 'brand.example.com' : 'instagram:brand';
  const capturedUrl = site ? 'https://brand.example.com/dealers' : 'https://www.instagram.com/p/brand-post/';
  const policy: OfficialPolicy = {keys:{test:key},models:{deepseek:['deepseek-flash'],qwen:['qwen4-max-preview']},
    brands:{'Test brand':{hosts:{'brand.example.com':'directory'},accounts:{'instagram:brand':'official-brand'}}}};
  const capture = {text:`공식 판매처: ${merchant}`,url:capturedUrl,captured_at:checkedAt,source_identity,
    observed_author:site ? null : source_identity,acquisition:'authorized_capture' as const};
  const claim = {brand_id:'Test brand',seller_id:deal.seller_id,seller_identity_url:merchant,campaign_id:deal.campaign_id!,
    relationship:'seller',source_kind,brand_binding_ref:site ? 'directory':'official-brand'} as const;
  const adapter = (model: string): Adapter => async ({claim,untrusted_source_data}) =>
    ({model,run_id:model,verdict:'affirmed',claim,passage:untrusted_source_data});
  const adapters = {deepseek:adapter('deepseek-flash'),qwen:adapter('qwen4-max-preview')};
  const signer = {key_id:'test',private_key:keypair.privateKey};
  expect(await attestOfficialSeller({...capture,text:`Thank you ${merchant}`},claim,policy,adapters,signer)).toBeNull();
  expect(await attestOfficialSeller({...capture,url:''},claim,policy,adapters,signer)).toBeNull();
  expect(await attestOfficialSeller(capture,claim,policy,{...adapters,qwen:adapters.deepseek},signer)).toBeNull();
  if (!site) expect(await attestOfficialSeller({...capture,observed_author:'instagram:shop'},claim,policy,adapters,signer)).toBeNull();
  const packet = (await attestOfficialSeller(capture,claim,policy,adapters,signer))!;
  expect(packet).toBeTruthy();
  const bad = structuredClone(packet);
  bad.envelope.results[1] = {...bad.envelope.results[0]};
  bad.digest = await hashJson(bad.envelope);
  await expect(manageOfficialSeller(memory.db,{action:'store',packet:bad},canonical(policy))).rejects.toMatchObject({code:'invalid_attestation'});
  const wrongClaim: typeof claim = {...claim,campaign_id:'unrelated-round'};
  const wrong = await attestOfficialSeller(capture,wrongClaim,policy,adapters,signer);
  await expect(manageOfficialSeller(memory.db,{action:'store',packet:wrong},canonical(policy))).rejects.toMatchObject({status:409});
  await expect(manageOfficialSeller(memory.db,{action:'store',packet},canonical(policy))).resolves.toMatchObject({state:'approved'});
  const detail = (await campaignDetail(memory.db,dealId,start))!;
  expect(renderToStaticMarkup(createElement(DealCard,{deal:detail,nowMs:start}))).toContain(`href="${capturedUrl}"`);
  await manageOfficialSeller(memory.db,{action:'revoke',digest:packet.digest,request_id:'revoke-fixture',reason:'Evidence was withdrawn by the brand'},canonical(policy));
  await manageOfficialSeller(memory.db,{action:'store',packet},canonical(policy));
  expect((await campaignDetail(memory.db,dealId,start))?.official_badges).toEqual([]);
});

test('populated 0018 upgrade replays committed receipts and leaves old SQL contracts intact', async () => {
  const old = memoryD1();
  try {
    await migrate(old.db,'0018');
    const {offer,id,scope} = await updateOffer(390000,1,0,checkedAt);
    await scopes(old.db,scope);
    const dealId = await publish(old.db,offer,id);
    const historySnapshot = () => old.db.prepare(`SELECT type,name,sql FROM sqlite_schema
      WHERE tbl_name IN ('deals','deal_revisions','ingested_items','external_candidates','verified_offer_receipts') ORDER BY name`).all();
    const before = await historySnapshot();
    const committed = await old.db.prepare('SELECT * FROM verified_offer_receipts').all();
    await execute(old.db,await readFile(schema,'utf8'));
    const after = await historySnapshot();
    expect(after.results).toEqual(expect.arrayContaining(before.results));
    expect(await old.db.prepare('SELECT * FROM verified_offer_receipts').all()).toEqual(committed);
    expect(await campaignDetail(old.db,dealId,start)).toMatchObject({seller_handle:'shop',seller_ordinal:1});
    const url = 'https://www.instagram.com/p/prior-legacy/';
    for (const id of ['old','duplicate']) await old.db.prepare(`INSERT INTO ingested_items(id,source_url,kind,account,text,captured_at)
      VALUES (?,?,'post','known','body',?) ON CONFLICT(source_url) DO NOTHING`).bind(id,url,checkedAt).run();
    expect(await old.db.prepare('SELECT id FROM ingested_items WHERE source_url=?').bind(url).first()).toEqual({id:'old'});
    expect(await old.db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({results:[]});
  } finally { old.close(); }
});

test('generation checked inventory reports unmapped deals as held', async () => {
  const db = memory.db;
  await db.prepare("INSERT INTO ingested_items(id,source_url,account,text,kind,captured_at,status) VALUES ('legacy',?,'x','x','post',?,'approved')").bind(source,checkedAt).run();
  await db.prepare("INSERT INTO deals(id,model_id,seller_id,title,source_url,verify_level,checked) VALUES ('legacy','model-1','seller-1','old',?,'manual',?)").bind(source,checkedAt).run();
  await db.prepare("INSERT INTO history_reconciliation(namespace,record_key,reason) VALUES ('fixture','legacy','unresolved')").run();
  const snapshot = await fetchInventory(async p => (await get(`admin/history-inventory${p.size ? `?${p}` : ''}`)).json());
  const report = await reconcileHistory(snapshot,null,null);
  expect(report.inputs).toEqual(expect.arrayContaining([expect.objectContaining({id:'legacy',state:'held',reason:'missing_history_membership'})]));
  // Derived reconciliation state and reference rows are context, not backfill
  // inputs, so they must not add source totals.
  expect(report.totals['d1:deals']).toEqual({held:1});
  for (const reference of ['d1:history_reconciliation','d1:sellers','d1:models','d1:history_receipts',
    'd1:official_approvals','d1:official_attestations']) expect(report.totals[reference]).toBeUndefined();
  expect((await get('deals/legacy')).status).toBe(404);
  await db.prepare("UPDATE deals SET title='edited' WHERE id='legacy'").run();
  expect((await get(`admin/history-inventory?generation=${snapshot.manifest.generation}&type=deals`)).status).toBe(409);
});

test('reconciliation verifies retained raw captures, records exclusions and resumes a lost import response', async () => {
  const scratch = await mkdtemp(join(tmpdir(),'seller-history-test-'));
  const file = join(scratch,'collector.sqlite');
  const local = new DatabaseSync(file);
  try {
    await scopes(memory.db,officialScope);
    await memory.db.prepare("INSERT INTO seller_identity_aliases VALUES ('storefront',?,'seller-1',?,'original')").bind(merchant,merchant).run();
    const proof = await exampleEvidence(source);
    const raw = new RawStore(join(scratch,'raw'),'fixture',process.cwd(),() => start,() => {});
    const archive = (text:string) => raw.writeInspected({text,fullTextAllowed:true,permissionBasis:'synthetic fixture'});
    const offer = archive(proof.offer!.source.text + '\n공구 회차: 1\n판매처: ' + merchant);
    const list = archive(proof.official!.source.text);
    local.exec(`CREATE TABLE engine_captures(id,source_id,url_norm,fetched_at,status,content_hash,prev_capture_id,raw_ref,data)`);
    const insert = local.prepare("INSERT INTO engine_captures VALUES (?,?,?,?,'ok',?,NULL,'retained',?)");
    for (const [id,url,hash] of [['offer',source,offer.hash],['catalog',officialUrl,list.hash],['unavailable','https://example.com/missing','a'.repeat(64)]]) {
      insert.run(id,'permitted',url,checkedAt,hash,JSON.stringify({artifact_hash:hash}));
    }
    const queue = join(scratch,'queue');
    await mkdir(queue, {mode:0o700});
    const completion = JSON.parse(await readFile(new URL('./fixtures/deepseek-web/mock-completion.json', import.meta.url),'utf8'));
    const extraction = checkExtraction(validateExtraction(completion.content,source,checkedAt.slice(0,10)),preparePage(offerHtml,source),checkedAt);
    await writeFile(join(queue,'review-queue.jsonl'),JSON.stringify({
      id:'rejected-fixture',status:'rejected',source_kind:'public_web',verify_level:'model_extract',created_at:checkedAt,extraction,
    })+'\n',{mode:0o600});

    const snapshot = await fetchInventory(async p => (await get(`admin/history-inventory${p.size ? `?${p}` : ''}`)).json());
    const complete: PriceCompletion = async (index,{user}) => {
      const { untrusted_source_data } = JSON.parse(user.split('\n').at(-1)!);
      return {model:PRICE_MODELS[index],content:JSON.stringify({...mockReading(untrusted_source_data,user.startsWith('Read the manufacturer')),orders_open:null}),
        usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
    };
    const report = await reconcileHistory(snapshot,queue,collectorSnapshot(file),{
      store:raw,permitted:new Set(['permitted']),maxAgeMs:86_400_000,now:start,complete,
    });
    expect(report.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({id:'rejected-fixture',state:'excluded',reason:'rejected'}),
      expect.objectContaining({id:'unavailable',state:'unavailable',reason:'artifact_missing_or_expired'}),
      expect.objectContaining({id:'offer:line:1',state:'held',reason:'qualified_for_import'}),
    ]));
    expect(report.packet.operations).toHaveLength(1);
    expect(report.totals['collector:captures'].newly_accepted).toBeUndefined();
    let lost = true;
    const send = async (operation: unknown) => {
      const result = await get('admin/history-import',operation);
      expect(result.status,await result.clone().text()).toBe(200);
      if (lost) { lost=false; throw new Error('response lost'); }
      return result.json();
    };
    const checkpoint = join(scratch,'checkpoint.json');
    await expect(applyPacket(report.packet,checkpoint,send)).rejects.toThrow('response lost');
    const resumed = await applyPacket(report.packet,checkpoint,send);
    expect(resumed.receipts).toHaveLength(1);
    expect(resumed.newlyAccepted).toBe(1);
    const replayed = await applyPacket(report.packet,checkpoint,() => { throw new Error('already checkpointed'); });
    expect(replayed.receipts).toHaveLength(1);
    expect(replayed.newlyAccepted).toBe(0);
    expect(await memory.db.prepare("SELECT count(*) AS n FROM history_receipts WHERE id LIKE 'import:%'").first()).toEqual({n:1});
    expect(await memory.db.prepare('SELECT amount,list_amount FROM accepted_offer_prices').first()).toEqual({amount:390000,list_amount:430000});
  } finally { local.close(); await rm(scratch,{recursive:true,force:true}); }
});

test('resumed apply reports only operations sent in the current run', async () => {
  const scratch = await mkdtemp(join(tmpdir(),'seller-history-checkpoint-'));
  try {
    const checkpoint = join(scratch,'checkpoint.json');
    const packet = {version:1,operations:[
      {request_id:'first',source:'site-deal'},
      {request_id:'second',source:'site-deal'},
      {request_id:'third',source:'queue'},
    ]};
    let lost = true;
    const send = async (operation: {request_id:string}) => {
      if (lost && operation.request_id === 'second') { lost = false; throw new Error('response lost'); }
      return {request_id:operation.request_id};
    };
    await expect(applyPacket(packet,checkpoint,send)).rejects.toThrow('response lost');
    const resumed = await applyPacket(packet,checkpoint,send);
    // first was checkpointed before the lost response and must not be recounted.
    expect(resumed.receipts.map(receipt => receipt.request_id)).toEqual(['first','second','third']);
    expect(resumed.newlyAccepted).toBe(2);
    const replayed = await applyPacket(packet,checkpoint,() => { throw new Error('nothing to send'); });
    expect(replayed.receipts).toHaveLength(3);
    expect(replayed.newlyAccepted).toBe(0);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});

test('seller history hides another seller’s global record low', () => {
  const history = {
    sampled: [], data: [], observation_count: 0, next_cursor: null,
    minimum: { id:'low', amount:100000, list_amount:200000, point_time:'2026-11-20', observed_at:'2026-11-20',
      precision:'day', seller_id:'seller-2', handle:'other-shop', seller_name:'Other seller', campaign_id:'round-other' },
  } as unknown as Awaited<ReturnType<typeof modelPriceHistory>>;
  const profile = renderToStaticMarkup(createElement(PriceHistory,{history,seller:'seller-1'}));
  expect(profile).not.toContain('Other seller');
  expect(profile).not.toContain('100,000원');
  const product = renderToStaticMarkup(createElement(PriceHistory,{history}));
  expect(product).toContain('Other seller');
  expect(product).toContain('100,000원');
});

test('reconciliation never resurrects a published deal whose observation was retracted', async () => {
  const db = memory.db;
  const fixture = await updateOffer(390000,1,0,checkedAt);
  await scopes(db,fixture.scope);
  const dealId = await publish(db,fixture.offer,fixture.id);
  const [configuration] = await historyConfigurations(db,'model-1');
  const [observation] = (await modelPriceHistory(db,'model-1',configuration.configuration_key,
    new URLSearchParams(),Date.now())).data;
  expect(observation).toBeTruthy();
  const retract = {request_id:'retract-only',reason:'The only price evidence was corrected',observation_id:observation!.id,
    campaign_id:observation!.campaign_id,expected_version:1};
  expect((await get('admin/history-retract',retract)).status).toBe(200);
  expect((await get(`deals/${dealId}`)).status).toBe(404);
  expect(await db.prepare('SELECT count(*) AS n FROM campaign_observations WHERE campaign_id=? AND retracted_by IS NULL')
    .bind(observation!.campaign_id).first()).toEqual({n:0});
  const snapshot = await fetchInventory(async p => (await get(`admin/history-inventory${p.size ? `?${p}` : ''}`)).json());
  const report = await reconcileHistory(snapshot,null,null,undefined,async id => {
    const row = await db.prepare("SELECT body FROM deal_price_evidence WHERE id=? AND outcome='verified'")
      .bind(id).first<{ body: string }>();
    return row ? JSON.parse(row.body) : null;
  });
  expect(report.inputs).toEqual(expect.arrayContaining([
    expect.objectContaining({source:'d1:deals',id:dealId,state:'excluded',reason:'retracted_history_membership'}),
  ]));
  expect(report.packet.operations).toEqual([]);
  expect(await db.prepare('SELECT count(*) AS n FROM campaign_observations').first()).toEqual({n:1});
});

test('the model page applies the default configuration to deals, summaries and the chart', async () => {
  const db = memory.db;
  const first = await verifiedFixture(390000,430000,'','2026-10-31T15:00:00.000Z');
  const second = await verifiedFixture(380000,430000,'2','2026-10-31T15:00:00.000Z');
  await db.prepare('INSERT INTO official_price_approvals VALUES (1,?,?)')
    .bind(checkedAt,JSON.stringify([first.scope,second.scope])).run();
  const [firstDeal,secondDeal] = [await publish(db,first.offer,first.id),await publish(db,second.offer,second.id)];
  // Give the second round its own evidenced configuration so the page has a
  // selector and a non-default deal that must not leak into the default view.
  const configuration = '["test brand","test model","1세대","Natural","1개","단품"]';
  const offer = await db.prepare('SELECT id FROM campaign_offers WHERE deal_id=?').bind(secondDeal).first<{ id: string }>();
  await db.prepare('UPDATE campaign_offers SET configuration_key=? WHERE deal_id=?').bind(configuration,secondDeal).run();
  await db.prepare('UPDATE offer_price_observations SET configuration_key=? WHERE offer_id=?').bind(configuration,offer!.id).run();
  const configurations = await historyConfigurations(db,'model-1');
  expect(configurations).toHaveLength(2);
  expect(configurations[0].configuration_key).toBe(configuration);
  const html = renderToStaticMarkup(await ModelPage({params:Promise.resolve({id:'model-1'}),
    searchParams:Promise.resolve({})}));
  expect(html).toContain('380,000원');
  expect(html).not.toContain('390,000원');
  const api = await (await get('models/model-1')).json<{ data: { comparison: { gonggu: {id:string}[]; current:{lowest_price:number} } } }>();
  expect(api.data.comparison.gonggu.map(deal => deal.id)).toEqual([secondDeal]);
  expect(api.data.comparison.current.lowest_price).toBe(380000);
  expect(firstDeal).not.toBe(secondDeal);
});

test('public seller listings expose the stable handle used by seller pages', async () => {
  await memory.db.prepare("UPDATE sellers SET handle='known-shop' WHERE id='seller-1'").run();
  const response = await get('sellers');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({data:[expect.objectContaining({id:'seller-1',handle:'known-shop'})]});
});
