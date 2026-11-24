import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DealCard, DealDetail } from '../app/deals/_components';
import { GET as rss } from '../app/rss.xml/route';
import { GET as sitemap } from '../app/sitemap.xml/route';
import { handleApi, adminDeal } from '../lib/api';
import { all, environment, type Env } from '../lib/db';
import { activeDealCount, activeDealPreview, dealSelect, endedDealCount, lifecycleDeals, modelDealSummaries, publicDealOptions, type DealWithContext } from '../lib/deals';
import { digest } from '../shared/deal-price-evidence';
import { closureEvidence, unavailablePriceEvidence } from '../crawler/src/deal-prices/verify';
import { detectSourceEnded } from '../lib/promote-external';
import { publicDealEligibility, verifiedDealIndexSql, verifiedStartColumnSql } from '../lib/verified-deal-sql';
import { checkedAt, endsAt, exampleEvidence as baseExampleEvidence, officialScope, startsAt } from './helpers/verified-deal-prices';
import { execute, legacy, migrate } from './helpers/deal-timestamps';
import { batchGate, memoryD1 } from './helpers/sqlite';

vi.mock('../lib/db', async importOriginal => ({ ...await importOriginal<typeof import('../lib/db')>(), environment: vi.fn() }));

beforeEach(() => { vi.useFakeTimers({ toFake:['Date'] }); vi.setSystemTime(Date.parse(checkedAt)+60_000); });
afterEach(() => vi.useRealTimers());
const merchant = 'https://merchant.example.com/store-1';
async function exampleEvidence(url: string, amount?: number, list?: number) {
  const evidence = await baseExampleEvidence(url,amount,list);
  if (url.startsWith('https://09pangpang.com/')) {
    const src = evidence.offer!.source;
    src.text += '\n판매처: ' + merchant;
    src.hash = await digest(src.text);
  }
  return evidence;
}
const migration = () => readFile(new URL('../migrations/0016_verified_deal_prices.sql', import.meta.url), 'utf8');

test('0016 preserves historical rows, child identities, foreign keys, and indexes', async () => {
  const memory = memoryD1();
  try {
    const { db } = memory;
    await migrate(db, '0015');
    await legacy(db, 'older', startsAt, endsAt);
    await execute(db, `UPDATE ingested_items SET status = 'approved', kind = 'external_web' WHERE id = 'older';
      UPDATE deals SET origin = 'external_web', price = 400000 WHERE id = 'older';
      INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,seller_id,title,status,checked,created_at)
        VALUES ('r','older',1,'promote_external','original','hash','seller-1','original title','published','2026-11-20','2026-11-20');
      INSERT INTO external_candidates (id,source,source_url,title,text,captured_at,last_seen_at,status,promoted_deal_id)
        VALUES ('candidate','pangpang','https://09pangpang.com/post/123','title','original text','2026-11-20','2026-11-20','promoted','older');
      INSERT INTO external_promotions VALUES ('p','candidate','older','https://09pangpang.com/post/123','admin','2026-11-20','original');
      INSERT INTO deal_bundle_items VALUES ('item','older',0,'brand','archived component','model-1',12345);`);
    const tables = ['ingested_items', 'deals', 'deal_revisions', 'external_candidates', 'external_promotions', 'deal_bundle_items'];
    const projections = await Promise.all(tables.map(async name => {
      const cols = (await all<{ name: string }>(db, `PRAGMA table_info(${name})`)).map(row => row.name).join(',');
      return `SELECT ${cols} FROM ${name}`;
    }));
    const before = await Promise.all(projections.map(sql => all(db, sql)));
    const indexes = () => all<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name");
    const oldIndexes = await indexes();
    const indexKeys = async () => Promise.all(oldIndexes.map(async ({ name }) =>
      [name, await all(db, `PRAGMA index_xinfo(${name})`)]));
    const priorIndexKeys = await indexKeys();
    const sql = await migration();
    expect(sql).toContain(verifiedStartColumnSql);
    expect(sql.split('-- Verified public indexes generated from lib/verified-deal-sql.ts.\n')[1]).toBe(verifiedDealIndexSql);
    expect([...sql.matchAll(/GLOB '([^']*)'/g)].every(match => match[1].length <= 50)).toBe(true);
    await execute(db, sql);
    expect(await Promise.all(projections.map(query => all(db, query)))).toEqual(before);
    expect(await indexes()).toEqual(expect.arrayContaining(oldIndexes.map(index => expect.objectContaining({ name: index.name }))));
    expect(await indexKeys()).toEqual(priorIndexKeys);
    expect(await all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(await adminDeal(db, 'older')).toMatchObject({ price: 400000, deal_price_krw: null, price_verification: 'unverified' });
    expect((await db.prepare('SELECT verified_price_ready FROM deals WHERE id=?').bind('older').first())).toEqual({ verified_price_ready:0 });

    for (const [deal, list, discount] of [[390000,430000,9], [100000,100000,0], [100001,100000,-1],
      [99999,100000,0], [0,430000,100], [0,0,null], [null,400000,null], [0,Number.MAX_SAFE_INTEGER,100]]) {
      await db.prepare("UPDATE deals SET deal_price_krw = ?, list_price_krw = ? WHERE id = 'older'").bind(deal,list).run();
      expect(await db.prepare("SELECT discount_pct FROM deals WHERE id = 'older'").first()).toEqual({ discount_pct: discount });
    }
    for (const value of [-1, .5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(db.prepare("UPDATE deals SET deal_price_krw = ? WHERE id = 'older'").bind(value).run()).rejects.toThrow();
    }
    await expect(db.prepare("UPDATE deals SET discount_pct = 12 WHERE id = 'older'").run()).rejects.toThrow();
  } finally { memory.close(); }
});

const envFor = (db: D1Database): Env => ({ DB: db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'verified-admin-fixture-only', INGEST_TOKEN: 'verified-ingest-fixture-only' });

function requests(env: Env) {
  return (path: string, body?: unknown) => handleApi(new Request(`https://site.test/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${path.split('?')[0] === 'ingest' ? env.INGEST_TOKEN : env.ADMIN_TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'), env);
}

async function syncScopes(request: ReturnType<typeof requests>, scopes = [officialScope], observed_at = checkedAt) {
  expect((await request('admin/price-sources', { observed_at, scopes })).status).toBe(200);
}

test('only approved current evidence produces public cards, counts, feeds, histories and minima', async () => {
  const memory = memoryD1();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(checkedAt));
  try {
    const { db } = memory;
    await migrate(db);
    await db.prepare("UPDATE models SET official_price = 999999, verify_level = 'page_body' WHERE id = 'model-1'").run();
    const env = envFor(db);
    vi.mocked(environment).mockReturnValue(env);
    const request = requests(env);
    await syncScopes(request);
    const publish = async (name: string, options: { start?: string | null; deal?: number; list?: number; threads?: boolean; verified?: boolean; closed?: boolean } = {}) => {
      const source_url = options.threads ? `https://www.threads.com/@fixture/post/${name}` : `https://www.instagram.com/p/${name}/`;
      const proof = await exampleEvidence(source_url, options.deal, options.list);
      const kind = options.threads ? 'threads_post' : 'post';
      const ingest = await request('ingest', {
        source_url, account: 'fixture', ...(options.threads ? { platform: 'threads' } : {}), kind,
        text: proof.offer!.source.text, captured_at: checkedAt, ...(options.verified === false ? {} : { price_evidence: proof }),
      });
      expect(ingest.status).toBe(202);
      const { data } = await ingest.json<{ data: { id: string; price_evidence_id?: string } }>();
      const approval = { action: 'approve', model_id: 'model-1', seller_id: 'seller-1', attribution: 'explicit',
        attribution_note: 'Reviewed account and seller evidence', title: name, starts_at: options.start === undefined ? startsAt : options.start,
        ...(data.price_evidence_id ? { price_evidence_id: data.price_evidence_id } : {}) };
      if (options.threads) {
        await db.prepare("INSERT INTO seller_accounts (account,seller_id,reviewed_at) VALUES ('fixture','seller-1','2026-11-20')").run();
        expect((await request(`admin/review/${data.id}`, { ...approval, attribution: 'account' })).status).toBe(400);
      }
      const response = await request(`admin/review/${data.id}`, approval);
      expect(response.status, await response.text()).toBe(200);
      if (options.closed) await db.prepare('UPDATE deals SET source_ended = 1 WHERE id = ?').bind(data.id).run();
      return { id: data.id, source_url, proof };
    };
    const [normal, high, ended, upcoming, unknown, legacyRow, equal] = [
      await publish('normal', { threads: true }),
      await publish('high', { deal: 100000 }),
      await publish('ended', { closed: true }),
      await publish('upcoming', { start: '2026-11-23T00:00:00.000Z' }),
      await publish('unknown', { start: null }),
      await publish('legacy', { verified: false }),
      await publish('equal', { deal: 430000 }),
    ];
    const ids = [normal, high, ended, upcoming, unknown].map(row => row.id).sort();
    for (const path of ['deals', 'calendar']) {
      const { data } = await (await request(path)).json<{ data: { id: string }[] }>();
      expect(data.map(row => row.id).sort()).toEqual(ids);
    }
    expect((await activeDealPreview(db, Date.now())).map(deal => deal.id)).toEqual([high.id, normal.id]);
    expect(await activeDealCount(db, Date.now())).toBe(2);
    expect((await modelDealSummaries(db, ['model-1'], Date.now())).get('model-1')).toMatchObject({ active_count: 2, lowest_price: 100000 });
    const page = await lifecycleDeals(db, publicDealOptions(new URLSearchParams('sort=discount&limit=1'), 'page-deals'), Date.now());
    expect(page.data.map(row => row.id)).toEqual([high.id]);
    const next = await lifecycleDeals(db, publicDealOptions(new URLSearchParams({ sort: 'discount', limit: '1', cursor: page.next_cursor! }), 'page-deals'), Date.now());
    expect(next.data.map(row => row.id)).toEqual([normal.id]);
    expect(() => publicDealOptions(new URLSearchParams({ sort: 'ending', cursor: page.next_cursor! }), 'page-deals')).toThrow();
    expect(await db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(legacyRow.id).first()).toBeNull();
    expect(await db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(equal.id).first()).toBeNull();
    expect((await adminDeal(db, equal.id))?.price_review?.reason).toBe('equal_price');

    const record = await db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(normal.id).first<DealWithContext>();
    expect(record).toMatchObject({ origin: 'threads', source_url: normal.source_url, price: 390000, ends_at: endsAt, discount_pct: 9 });
    const html = renderToStaticMarkup(createElement(DealCard, { deal: record!, nowMs: Date.now() }));
    expect(html).toContain('390,000');
    expect(html).toContain('<del>430,000원</del>');
    expect(html.match(/정가보다 9% 싸요/g)).toHaveLength(1);
    expect(html).not.toContain('999,999');
    const detail = renderToStaticMarkup(createElement(DealDetail, { deal: record!, nowMs: Date.now() }));
    expect(detail).toContain(record!.price_source_url);
    expect(detail).toContain(record!.list_price_source_url);
    const feed = await (await rss()).text(), map = await (await sitemap()).text();
    for (const id of ids) {
      expect(map).toContain(id);
      if (id === high.id || id === normal.id) expect(feed).toContain(id);
      else expect(feed).not.toContain(id);
    }
    expect(map).not.toContain(equal.id);
    expect(map).not.toContain(legacyRow.id);
    const attempt = await request('admin/price-backfill', { discount_pct: 99 });
    expect(attempt.status).toBe(400);
    // A visit just before closing keeps the official evidence current through expiry.
    const refreshed = new Date(Date.parse(endsAt) - 1000).toISOString();
    await db.prepare(`UPDATE deal_price_evidence SET body = json_set(body, '$.official.source.observed_at', ?) WHERE outcome = 'verified'`).bind(refreshed).run();
    await db.prepare("UPDATE deals SET price_checked_at = ? WHERE price_verification = 'verified'").bind(refreshed).run();
    vi.setSystemTime(new Date(Date.parse(endsAt) + 1));
    expect(await activeDealCount(db, Date.now())).toBe(0);
    const after = await lifecycleDeals(db, publicDealOptions(new URLSearchParams('sort=ending'), 'page-deals'), Date.now());
    expect(after.data.map(row => row.id).sort()).toEqual(ids);
    expect((await (await rss()).text()).includes(unknown.id)).toBe(false);
  } finally { vi.useRealTimers(); memory.close(); }
});

test('a written deadline stays open while completed language and explicit overrides work', () => {
  const candidate = { text: '공구 마감일: 2099년 11월 26일', dates_raw: null, ends_at: '2099-11-26T14:59:59.999Z' };
  expect(detectSourceEnded(candidate)).toBe(false);
  expect(detectSourceEnded({ ...candidate, text: '공구 마감됨' })).toBe(true);
  expect(detectSourceEnded({ ...candidate, text: '공구 종료' })).toBe(true);
  expect(detectSourceEnded({ ...candidate, ends_at: '2020-11-26T14:59:59.999Z' })).toBe(true);
  expect(detectSourceEnded(candidate, true)).toBe(true);
  expect(detectSourceEnded({ ...candidate, text: '공구 마감됨' }, false)).toBe(false);
});

test('external promotion selects revision-bound evidence and rejects reuse with changed input', async () => {
  const memory = memoryD1({ serialize: true });
  try {
    await migrate(memory.db);
    const request = requests(envFor(memory.db));
    await syncScopes(request);
    const source_url = 'https://09pangpang.com/post/8701';
    const evidence = await exampleEvidence(source_url);
    const ingested = await request('ingest', { kind: 'external_listing', source: 'pangpang', source_url, seller_url:merchant, title: 'fixture external',
      text: evidence.offer!.source.text, captured_at: checkedAt, price_evidence: evidence });
    expect(ingested.status).toBe(202);
    const { data: candidate } = await ingested.json<{ data: { id: string; price_evidence_id: string } }>();
    const details = { action: 'promote', request_id: 'fixture-external-request', model_id: 'model-1', seller_id: 'seller-1',
      starts_at: startsAt, price_evidence_id: candidate.price_evidence_id };
    const promotion = await request(`admin/candidates/${candidate.id}`, details);
    expect(promotion.status).toBe(200);
    const { data } = await promotion.json<{ data: { deal_id: string } }>();
    expect(await memory.db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(data.deal_id).first())
      .toMatchObject({ origin: 'external_web', price: 390000, discount_pct: 9 });
    const replay = await request(`admin/candidates/${candidate.id}`, details);
    expect(await replay.json()).toMatchObject({ data: { deal_id: data.deal_id, created: false } });
    expect((await request(`admin/candidates/${candidate.id}`, { ...details, price: 350000 })).status).toBe(409);
  } finally { memory.close(); }
});

test('backfill stages separate proof for a different candidate capture, and an older ingest cannot restore its head', async () => {
  const memory = memoryD1({ serialize: true });
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const source_url = 'https://09pangpang.com/post/8710';
    const old = await exampleEvidence(source_url);
    const current = await exampleEvidence(source_url, 400000);
    const later = '2026-11-22T00:01:00.000Z';
    current.offer!.source.observed_at = later;
    const base = { kind: 'external_listing', source: 'pangpang', source_url, seller_url:merchant, title: 'fixture external' };
    const older = { ...base, text: old.offer!.source.text, captured_at: checkedAt, price_evidence: old };
    type Receipt = { data: { id: string; revision: string; price_evidence_id?: string } };
    const { data: original } = await (await request('ingest', older)).json<Receipt>();
    const form = { action: 'promote', request_id: 'fixture-stale-capture-form', model_id: 'model-1', seller_id: 'seller-1',
      starts_at: startsAt, expected_revision: original.revision, price_evidence_id: original.price_evidence_id };
    const { data: latest } = await (await request('ingest', { ...base, text: current.offer!.source.text, captured_at: later })).json<Receipt>();
    const manifest = await (await request('admin/price-backfill?kind=candidate')).json();
    expect(manifest).toMatchObject({ data: [{ id: original.id, revision: latest.revision, captureHash: current.offer!.source.hash }] });
    const submit = { kind: 'candidate', id: latest.id, expected_revision: latest.revision, request_id: 'c'.repeat(64) };
    const mismatch = await request('admin/price-backfill', { ...submit, price_evidence: old });
    expect(mismatch.status).toBe(200);
    expect(await mismatch.json()).toMatchObject({ data: { outcome: 'capture_changed', revision: latest.revision } });
    expect(await all(db, 'SELECT request_id FROM deal_price_backfill_receipts')).toEqual([{ request_id: submit.request_id }]);
    expect((await request('ingest', older)).status).toBe(202);
    expect(await db.prepare('SELECT text,last_seen_at,price_revision FROM external_candidates WHERE id = ?').bind(latest.id).first())
      .toEqual({ text: current.offer!.source.text, last_seen_at: later, price_revision: latest.revision });
    expect((await request(`admin/candidates/${latest.id}`, form)).status).toBe(409);
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(0);
    expect(await (await request('admin/price-backfill', { ...submit, request_id: 'e'.repeat(64), price_evidence: current })).json())
      .toMatchObject({ data: { outcome: 'verified' } });
    const proof = await db.prepare('SELECT evidence_id FROM deal_price_evidence_heads WHERE target_id = ? AND target_revision = ?')
      .bind(latest.id, latest.revision).first<{ evidence_id: string }>();
    const promoted = await request(`admin/candidates/${latest.id}`, { ...form, expected_revision: latest.revision, price_evidence_id: proof!.evidence_id });
    expect(promoted.status).toBe(200);
    const { data: { deal_id } } = await promoted.json<{ data: { deal_id: string } }>();
    expect(await db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(deal_id).first())
      .toMatchObject({ deal_price_krw: 400000 });
    old.offer!.source.observed_at = '2026-11-22T00:02:00.000Z';
    expect((await request('ingest', { kind: 'external_price_observation', deal_id, source_url, price_evidence: old })).status).toBe(202);
    expect(await (await request('deals')).json()).toEqual({ data: [], next_cursor: null });
    expect((await adminDeal(db, deal_id))?.price_review?.reason).toBe('prior_fact_conflict');
  } finally { memory.close(); }
});

test('backfill can record an inaccessible legacy URL while keeping variants distinct', async () => {
  const memory = memoryD1();
  try {
    await migrate(memory.db);
    const request = requests(envFor(memory.db));
    const source_url = 'https://09pangpang.com/post/8711?variant=natural';
    const response = await request('ingest', { kind: 'external_listing', source: 'pangpang', source_url,
      title: 'fixture external', text: 'Stored capture', captured_at: checkedAt });
    const { data } = await response.json<{ data: { id: string; revision: string } }>();
    expect(response.status).toBe(202);
    const target = { kind: 'candidate', id: data.id, expected_revision: data.revision, request_id: 'e'.repeat(64) };
    expect((await request('admin/price-backfill', { ...target, price_evidence: unavailablePriceEvidence(source_url.replace('natural', 'white'), 'source_inaccessible') })).status).toBe(400);
    const exact = await request('admin/price-backfill', { ...target, price_evidence: unavailablePriceEvidence(source_url, 'source_inaccessible') });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ data: { outcome: 'source_inaccessible' } });
  } finally { memory.close(); }
});

test.each(['공구 마감됨', '안내: 공구 마감됨', '종료'])('a delivered closure "%s" moves a verified offer to ended', async label => {
  const memory = memoryD1();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(checkedAt));
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const source_url = 'https://09pangpang.com/post/8712';
    const proof = await exampleEvidence(source_url);
    const original = proof.offer!.source;
    const { data: candidate } = await (await request('ingest', { kind: 'external_listing', source: 'pangpang', source_url, seller_url:merchant,
      title: 'fixture external', text: original.text, captured_at: checkedAt, price_evidence: proof })).json<{ data: { id: string; price_evidence_id: string } }>();
    const promotion = await request(`admin/candidates/${candidate.id}`, { action: 'promote', request_id: 'fixture-live-closure',
      model_id: 'model-1', seller_id: 'seller-1', starts_at: startsAt, price_evidence_id: candidate.price_evidence_id });
    expect(promotion.status).toBe(200);
    const { data: { deal_id } } = await promotion.json<{ data: { deal_id: string } }>();
    const time = Date.parse(checkedAt);
    const watch = 'ingest?kind=external_price_observation';
    expect(await (await request(watch)).json()).toMatchObject({ data: { id: deal_id, source_url, capture_hash: original.hash } });
    expect(await activeDealCount(db, time)).toBe(1);
    const captured = original.text + '\n' + label;
    const observed = '2026-11-22T00:10:00.000Z';
    const price_evidence = label === '종료' ? await closureEvidence(source_url, captured, observed) :
      { ...proof, offer: { ...proof.offer, source: { ...original, text: captured, hash: await digest(captured), observed_at: observed } } };
    vi.setSystemTime(Date.parse(observed));
    const submit = { kind: 'external_price_observation', deal_id, source_url, price_evidence };
    expect((await request('ingest', submit)).status).toBe(202);
    expect((await request('ingest', submit)).status).toBe(202);
    expect(await activeDealCount(db, time)).toBe(0);
    expect(await endedDealCount(db, time)).toBe(1);
    expect(await (await request(watch)).json()).toMatchObject({ data: { id: deal_id, revision: '2' } });
    expect(await db.prepare('SELECT version,source_ended,deal_price_krw FROM deals WHERE id = ?').bind(deal_id).first())
      .toEqual({ version: 2, source_ended: 1, deal_price_krw: 390000 });
  } finally { memory.close(); vi.restoreAllMocks(); }
});

test('the site rejects unapproved official URLs, expired approvals, and queued proofs after revocation', async () => {
  const memory = memoryD1();
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const source_url = 'https://09pangpang.com/post/8702';
    const evidence = await exampleEvidence(source_url);
    const incoming = { kind: 'external_listing', source: 'pangpang', source_url, seller_url:merchant, title: 'fixture external',
      text: evidence.offer!.source.text, captured_at: checkedAt };
    const sellerProof = structuredClone(evidence);
    sellerProof.official!.source.url = 'https://seller.example.com/products/test-model';
    expect((await request('ingest', { ...incoming, price_evidence: sellerProof })).status).toBe(409);
    const expired = { ...officialScope, approved_at: '2024-01-01T00:00:00.000Z', expires_at: '2025-01-01T00:00:00.000Z' };
    expect((await request('admin/price-sources', { scopes: [expired], observed_at: '2026-11-22T00:00:00.001Z' })).status).toBe(400);
    const expiredProof = structuredClone(evidence);
    expiredProof.official!.source.observed_at = '2024-02-01T00:00:00.000Z';
    expect((await request('ingest', { ...incoming, price_evidence: expiredProof })).status).toBe(409);
    await syncScopes(request, [officialScope], '2026-11-22T00:00:00.002Z');
    const staged = await request('ingest', { ...incoming, price_evidence: evidence });
    const { data } = await staged.json<{ data: { id: string; price_evidence_id: string } }>();
    const promote = { action: 'promote', request_id: 'fixture-authority-revoke', model_id: 'model-1', seller_id: 'seller-1',
      starts_at: startsAt, price_evidence_id: data.price_evidence_id };
    expect((await request('admin/price-sources', { scopes: [], observed_at: '2026-11-22T00:00:00.003Z', revoke_at_revision: '2026-11-22T00:00:00.002Z' })).status).toBe(200);
    expect(await (await request(`admin/candidates/${data.id}`, promote)).json()).toEqual({ error: 'official_source_not_approved' });
    expect((await request('admin/price-sources', { observed_at: checkedAt, scopes: [officialScope] })).status).toBe(409);
    expect(await all(db, 'SELECT id FROM deals')).toEqual([]);
  } finally { memory.close(); }
});

test.each(['social', 'external'] as const)('%s approval cannot select evidence that arrived after the form opened', async channel => {
  const memory = memoryD1();
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const social = channel === 'social';
    const source_url = social ? 'https://www.instagram.com/p/late-proof/' : 'https://09pangpang.com/post/8703';
    const proof = await exampleEvidence(source_url);
    const incoming = { source_url, text: proof.offer!.source.text, captured_at: checkedAt,
      ...(social ? { kind: 'post', account: 'fixture' } : { kind: 'external_listing', source: 'pangpang', title: 'fixture' }) };
    type Receipt = { data: { id: string; revision: string; price_evidence_id: string } };
    const { data: original } = await (await request('ingest', incoming)).json<Receipt>();
    const { data: verified } = await (await request('ingest', { ...incoming, price_evidence: proof })).json<Receipt>();
    expect(verified.id).toBe(original.id);
    expect(verified.price_evidence_id).toMatch(/^[a-f0-9]{64}$/);
    const path = `admin/${social ? 'review' : 'candidates'}/${original.id}`;
    const form = { action: social ? 'approve' : 'promote', request_id: 'fixture-stale-proof-form', model_id: 'model-1', seller_id: 'seller-1',
      title: 'fixture', starts_at: startsAt, attribution: 'explicit', attribution_note: 'Reviewed account and seller evidence', expected_revision: original.revision ?? checkedAt };
    const stale = await request(path, form);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale_evidence' });
    expect(await all(db, 'SELECT id FROM deals')).toEqual([]);
    const selected = { ...form, price_evidence_id: verified.price_evidence_id };
    expect((await request(path, selected)).status).toBe(200);
    expect((await request(path, selected)).status).toBe(200);
    expect((await request(path, form)).status).toBe(409);
  } finally { memory.close(); }
});

test('edited pending posts accept successful retries and changed live prices return to review', async () => {
  const memory = memoryD1();
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const source_url = 'https://www.instagram.com/p/edited-price/';
    const proof = await exampleEvidence(source_url);
    const captured_at = '2026-11-22T00:01:00.000Z';
    const original = { source_url, account: 'fixture', kind: 'post', captured_at: checkedAt, image_url: 'https://cdninstagram.com/original.jpg' };
    const retryable = { ...proof, offer: null, official: null, official_approval: null, failed: 'provider_retryable' };
    const first = await request('ingest', { ...original, text: 'Original caption', price_evidence: retryable });
    const { data: pending } = await first.json<{ data: { id: string; price_evidence_id: string } }>();
    proof.offer!.source.observed_at = captured_at;
    const edited = await request('ingest', { ...original, captured_at, text: proof.offer!.source.text, price_evidence: proof, image_url: null });
    expect(edited.status).toBe(202);
    const { data } = await edited.json<{ data: { id: string; revision: string; price_evidence_id: string } }>();
    expect(data).toMatchObject({ id: pending.id, revision: captured_at });
    expect(data.price_evidence_id).not.toBe(pending.price_evidence_id);
    expect(await db.prepare('SELECT image_url FROM ingested_items WHERE id = ?').bind(data.id).first()).toEqual({ image_url: original.image_url });
    const path = `admin/review/${data.id}`;
    const approve = { action: 'approve', model_id: 'model-1', seller_id: 'seller-1', title: 'fixture', starts_at: startsAt,
      attribution: 'explicit', attribution_note: 'Reviewed account and seller evidence' };
    expect((await request(path, { ...approve, price_evidence_id: pending.price_evidence_id })).status).toBe(409);
    expect((await request(path, { ...approve, price_evidence_id: data.price_evidence_id })).status).toBe(200);
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(1);
    const correction = { action: 'correct', expected_version: 1, request_id: 'title-correction-fixture', reason: 'Reviewed corrected title',
      title: 'Corrected title', model_id: 'model-1', price: 390000, starts_at: startsAt, ends_at: endsAt, include_image: true };
    expect((await request(`admin/deals/${data.id}`, correction)).status).toBe(200);
    expect(await db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(data.id).first()).toMatchObject({ title: 'Corrected title', price: 390000 });
    const changed = await exampleEvidence(source_url, 400000);
    for (const time of ['2026-11-22T00:02:00.000Z', '2026-11-22T00:03:00.000Z']) {
      changed.offer!.source.observed_at = time;
      expect((await request('ingest', { ...original, captured_at: time, text: changed.offer!.source.text, price_evidence: changed })).status).toBe(202);
      expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(0);
      expect((await adminDeal(db, data.id))?.price_review).toMatchObject({ reason: 'prior_fact_conflict', result: { facts: { deal_price_krw: 400000 } } });
    }
    await request('ingest', { ...original, captured_at, text: proof.offer!.source.text, price_evidence: proof });
    vi.setSystemTime(Date.parse('2026-11-22T00:03:00.000Z'));
    const reviewed = (await adminDeal(db, data.id))!;
    expect(reviewed.version).toBe(4);
    expect(reviewed.previous_price_reviews).toEqual(expect.arrayContaining([expect.objectContaining({ id: data.price_evidence_id })]));
    expect((await request(`admin/deals/${data.id}`, { ...correction, request_id: 'apply-changed-price-fixture', expected_version: reviewed.version,
      price: 400000, price_evidence_id: reviewed.price_review!.id })).status).toBe(200);
    expect(await db.prepare(`${dealSelect(Date.parse(checkedAt))} AND d.id = ?`).bind(data.id).first()).toMatchObject({ price: 400000 });
  } finally { memory.close(); }
});

test('backfill applies once, demotes a later disagreement, and cannot revive a withdrawn deal', async () => {
  const memory = memoryD1({ serialize: true });
  try {
    await migrate(memory.db);
    const { db } = memory, request = requests(envFor(db));
    await syncScopes(request);
    const id = 'legacy-price';
    await legacy(db, id, startsAt, endsAt);
    await db.prepare("UPDATE ingested_items SET status = 'approved',attribution='explicit',attribution_note='Reviewed seller source association' WHERE id = ?").bind(id).run();
    const source = `https://www.instagram.com/p/${id}/`;
    const proof = await exampleEvidence(source);
    await db.prepare('UPDATE ingested_items SET text = ? WHERE id = ?').bind(proof.offer!.source.text, id).run();
    const target = { kind: 'deal', id, expected_revision: '1', request_id: '1'.repeat(64), price_evidence: proof };
    const submit = (payload: unknown) => request('admin/price-backfill', payload);
    const first = await submit(target);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ data: { outcome: 'verified' } });
    expect(await (await submit(target)).json()).toMatchObject({ data: { outcome: 'verified' } });
    expect(await db.prepare('SELECT version,price FROM deals WHERE id = ?').bind(id).first()).toEqual({ version: 2, price: null });
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(1);
    const changed = structuredClone(proof);
    changed.offer!.source.observed_at = '2026-11-23T00:00:00.000Z';
    changed.offer!.readings[1]!.amount = 390001;
    expect((await submit({ ...target, price_evidence: changed })).status).toBe(409);

    const disputed = await submit({ ...target, request_id: '2'.repeat(64), expected_revision: '2', price_evidence: changed });
    expect(await disputed.json()).toMatchObject({ data: { outcome: 'offer_price_disagreement' } });
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(0);
    expect((await adminDeal(db, id))?.price_review?.reason).toBe('offer_price_disagreement');
    expect(await (await request(`admin/deals/${id}`, { action: 'withdraw', expected_version: 3, request_id: 'fixture-withdraw-prices', reason: 'Reviewed terminal withdrawal' })).json())
      .toMatchObject({ data: { status: 'withdrawn', version: 4 } });
    expect((await submit({ ...target, request_id: '3'.repeat(64), expected_revision: '3' })).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM deal_price_evidence WHERE target_id = ?').bind(id).first()).toEqual({ n: 2 });
  } finally { memory.close(); }
});

test('a concurrent withdrawal wins over stale backfill without storing a receipt or changing history', async () => {
  const gate = batchGate(2, [1, 0]);
  const memory = memoryD1({ gate, serialize: true });
  try {
    const { db } = memory;
    await migrate(db);
    const id = 'withdraw-first';
    await legacy(db, id, startsAt, endsAt);
    await db.prepare("UPDATE ingested_items SET status = 'approved',attribution='explicit',attribution_note='Reviewed seller source association' WHERE id = ?").bind(id).run();
    const request = requests(envFor(db));
    await syncScopes(request);
    const evidence = await exampleEvidence(`https://www.instagram.com/p/${id}/`);
    await db.prepare('UPDATE ingested_items SET text = ? WHERE id = ?').bind(evidence.offer!.source.text, id).run();
    const backfill = request('admin/price-backfill', { kind: 'deal', id, expected_revision: '1', request_id: 'a'.repeat(64), price_evidence: evidence });
    await gate.firstArrived;
    const withdraw = request(`admin/deals/${id}`, { action: 'withdraw', expected_version: 1, request_id: 'fixtures-withdraw-wins', reason: 'Withdrawn during verification' });
    const [result, revoked] = await Promise.all([backfill, withdraw]);
    expect(result.status).toBe(409);
    expect(revoked.status).toBe(200);
    expect(await db.prepare('SELECT version,status FROM deals WHERE id = ?').bind(id).first()).toEqual({ version: 2, status: 'withdrawn' });
    expect(await all(db, 'SELECT action FROM deal_revisions')).toEqual([{ action: 'withdraw' }]);
    expect(await all(db, 'SELECT id FROM deal_price_evidence')).toEqual([]);
    expect(await all(db, 'SELECT request_id FROM deal_price_backfill_receipts')).toEqual([]);
  } finally { memory.close(); }
});

test('first Instagram proof on a previously approved deal is staged and its receipt survives withdrawal', async () => {
  const memory = memoryD1();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(checkedAt));
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const source_url = 'https://www.instagram.com/p/first-approved-proof/';
    const price_evidence = await exampleEvidence(source_url);
    const original = { kind: 'post', source_url, account: 'fixture', captured_at: checkedAt, text: price_evidence.offer!.source.text };
    const { data } = await (await request('ingest', original)).json<{ data: { id: string } }>();
    const id = data.id;
    expect((await request('admin/review/' + id, { action: 'approve', model_id: 'model-1', seller_id: 'seller-1', title: 'Instagram fixture',
      attribution: 'explicit', attribution_note: 'Verified original seller attribution' })).status).toBe(200);
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(0);

    const delivery = { ...original, price_evidence };
    const observed = await request('ingest', delivery);
    expect(observed.status).toBe(202);
    const { data: receipt } = await observed.json<{ data: { price_evidence_id: string; revision: string } }>();
    expect(receipt).toMatchObject({ price_evidence_id: expect.any(String), revision: '2' });
    expect((await adminDeal(db, id))?.price_review).toMatchObject({ id: receipt.price_evidence_id, reason: 'first_proof_requires_review' });
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(0);

    const path = 'admin/deals/' + id;
    const correction = await request(path, { action: 'correct', expected_version: 2, request_id: 'first-instagram-price-review',
      reason: 'Reviewed verified Instagram price and official comparison', model_id: 'model-1', title: 'Instagram fixture',
      price: 390000, starts_at: startsAt, ends_at: endsAt, price_evidence_id: receipt.price_evidence_id, include_image: false });
    expect(correction.status).toBe(200);
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(1);
    expect((await request(path, { action: 'withdraw', expected_version: 3, request_id: 'withdraw-first-price-fixture',
      reason: 'Independent withdrawal after price approval' })).status).toBe(200);
    const replay = await request('ingest', delivery);
    expect(await replay.json()).toMatchObject({ data: receipt });
    expect(await activeDealCount(db, Date.parse(checkedAt))).toBe(0);
    expect(await db.prepare('SELECT status,version FROM deals WHERE id=?').bind(id).first()).toEqual({ status: 'withdrawn', version: 4 });
  } finally { memory.close(); vi.restoreAllMocks(); }
});

test('a closure with an edited amount drops both public projections while the official page is unavailable', async () => {
  const memory = memoryD1();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(checkedAt));
  try {
    const { db } = memory;
    await migrate(db);
    const request = requests(envFor(db));
    await syncScopes(request);
    const source_url = 'https://09pangpang.com/post/8172';
    const proof = await exampleEvidence(source_url);
    const listing = { kind: 'external_listing', source: 'pangpang', source_url, seller_url:merchant,
      title: 'Closure with a price edit', text: proof.offer!.source.text, captured_at: checkedAt, price_evidence: proof };
    const { data: candidate } = await (await request('ingest', listing)).json<{ data: { id: string; price_evidence_id: string } }>();
    const promotion = await request('admin/candidates/' + candidate.id, { action: 'promote', request_id: 'closure-edited-price-fixture',
      model_id: 'model-1', seller_id: 'seller-1', starts_at: startsAt, price_evidence_id: candidate.price_evidence_id });
    expect(promotion.status).toBe(200);
    const { data: { deal_id } } = await promotion.json<{ data: { deal_id: string } }>();
    expect(await activeDealCount(db, Date.now())).toBe(1);

    const edited = await exampleEvidence(source_url, 400000);
    const captured = edited.offer!.source.text + '\n공구 마감됨';
    const at = new Date(Date.parse(checkedAt) + 600_000).toISOString();
    const closure = await closureEvidence(source_url, captured, at);
    expect((await request('ingest', { kind: 'external_price_observation', deal_id, source_url, price_evidence: closure })).status).toBe(202);
    expect(await activeDealCount(db, Date.now())).toBe(0);
    expect(await endedDealCount(db, Date.now())).toBe(0);
    expect((await adminDeal(db, deal_id))?.price_review?.evidence.offer?.source.text).toContain('400,000');
    expect(await db.prepare('SELECT source_ended,price_verification FROM deals WHERE id = ?').bind(deal_id).first())
      .toEqual({ source_ended: 1, price_verification: 'unverified' });
  } finally { memory.close(); vi.restoreAllMocks(); }
});

test('a legacy reader over migrated D1 still exposes priceless rows; the verified reader does not', async () => {
  const memory = memoryD1();
  try {
    const { db } = memory;
    await migrate(db);
    const id = 'priceless-legacy';
    await legacy(db, id, startsAt, endsAt);
    await db.prepare("UPDATE ingested_items SET status = 'approved',attribution='explicit',attribution_note='Reviewed seller source association' WHERE id = ?").bind(id).run();
    // The 7f8d7d8 public reader selected status = 'published' without evidence,
    // so a direct rollback after 0016 still shows legacy rows (documented
    // residual exposure in README §0016).
    const oldReader = await all<{ id: string }>(db, "SELECT id FROM deals WHERE status = 'published' AND id = ?", id);
    expect(oldReader.map(row => row.id)).toEqual([id]);
    const newReader = await all<{ id: string }>(db, `SELECT id FROM deals WHERE ${publicDealEligibility('deals', Date.parse(checkedAt))} AND id = ?`, id);
    expect(newReader).toEqual([]);
  } finally { memory.close(); }
});
