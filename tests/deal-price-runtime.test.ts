import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { DealCard } from '../app/deals/_components';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { priceSourceAuthority } from '../crawler/src/deal-prices/runtime';
import { preparedOfferText } from '../crawler/src/deal-prices/verify';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
import { initializeSourceRegistry, SourceRegistryStore } from '../crawler/src/source-registry/store';
import { loadRegistrySeed } from '../crawler/src/source-registry/seed';
import { handleApi, adminDeal } from '../lib/api';
import { activeDealCount, activeDealPreview, endedDealCount, modelDealSummaries } from '../lib/deals';
import type { Env } from '../lib/db';
import { PRICE_MODELS, type Configuration, type Reading } from '../shared/deal-price-evidence';
import { fixture, source } from './helpers/collector';
import { migrate } from './helpers/deal-timestamps';
import { memoryD1 } from './helpers/sqlite';

const official = 'https://gear.example.org/products/tripp-trapp';
const base = 'https://09pangpang.com/post/';
const deadline = '2026-10-24T14:59:59.999Z';
const stamp = '2026-10-23T10:00:00.000Z';
const configuration = (bundle: string): Configuration => ({
  brand: 'Stokke', model: 'Tripp Trapp', generation: '2세대', option: '내추럴', quantity: '1개', bundle,
});
const variants = ['단품', '베이비 세트'].map((bundle, i) => ({
  id: i ? 'chair-baby-set' : 'chair', catalog_id: 'stokke-tripp-trapp', configuration: configuration(bundle), skus: [],
}));
const open = '현재 공구 주문 가능';
const row = (...cells: string[]) => '<tr>' + cells.map(cell => '<td>' + cell + '</td>').join('') + '</tr>';
const option = (bundle: string, price: string, orders?: string) =>
  row('옵션: 내추럴', '수량: 1개', '구성: ' + bundle, price, orders ?? '');
const page = (body: string) => '<main><article><h1>스토케 트립트랩 2세대 공동구매</h1><div class="offer">' + body + '</div></article></main>';
const offer = (bundle: string, price: string) => page('<p>마감일: 2026년 10월 24일</p><table>' +
  option(bundle, price, open) + row('유모차 거치대 액세서리', '공구가: 3,000원') + '</table>');
const officialPage = (price: number) => page('<table>' + option('단품', '정가: ' + price.toLocaleString('ko-KR') + '원') +
  option('베이비 세트', '정가: 560,000원') + '</table>');

function readFixture(text: string, officialSide: boolean, wanted: string, disagree: boolean): Reading {
  const find = (quote: string, from = 0) => ({ quote, start: text.indexOf(quote, from) });
  const lines = text.split('\n');
  const line = lines.find(line => line.includes('구성: ' + wanted) && line.includes(officialSide ? '정가:' : '공구가:')) ?? lines.find(line => line.includes('옵션:') && line.includes('공구가:')) ?? lines.find(line => line.includes('거치대')) ?? '';
  const price = line.split(' | ').find(cell => cell.startsWith(officialSide ? '정가:' : '공구가:'));
  const selected = text.indexOf(line);
  const config = configuration(wanted);
  const wants = { brand: '스토케', model: '트립트랩', generation: '2세대', option: '옵션: 내추럴', quantity: '수량: 1개', bundle: '구성: ' + wanted };
  const identity = Object.fromEntries(Object.entries(wants).map(([field, quote]) => [field, ['option', 'quantity', 'bundle'].includes(field) && line.includes(quote) ?
      find(quote, selected) : find(text.includes(quote) ? quote : '스토케')])) as Reading['identity'];
  return {
    amount: price ? Number(price.replace(/\D/g, '')) + Number(disagree && officialSide) : null,
    price: price ? find(price, selected) : null, deadline: officialSide ? null : find('마감일: 2026년 10월 24일'),
    configuration: config, identity, orders_open: !officialSide && line.includes(open) ? find(open) : null,
  };
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test('routine web verification binds option prices and refreshes active and archived comparisons from the same official page', async () => {
  const linux = fixture();
  const site = memoryD1();
  const dir = await mkdtemp(join(tmpdir(), 'price-runtime-'));
  let now = Date.parse(stamp);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('DEAL_PRICE_VERIFICATION', '1');
  vi.stubEnv('AGAMAJUNG_API_URL', 'https://site.test');
  vi.stubEnv('INGEST_TOKEN', 'runtime-ingest-fixture-key');
  const env: Env = { DB: site.db, IMAGES: {} as R2Bucket,
    INGEST_TOKEN: 'runtime-ingest-fixture-key', ADMIN_TOKEN: 'runtime-admin-fixture-key' };
  const call = (path: string, data?: unknown) => handleApi(new Request('https://site.test/api/v1/' + path, {
    method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + (path.startsWith('admin') ? env.ADMIN_TOKEN : env.INGEST_TOKEN) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }), path.split('?')[0].split('/'), env);
  try {
    await migrate(site.db);
    await site.db.prepare("UPDATE models SET brand='Stokke',name='Tripp Trapp',official_price=999000,verify_level='page_body' WHERE id='model-1'").run();
    const config = loadDeepSeekWebConfig();
    const draft = loadRegistrySeed().find(entry => entry.source_id === 'official:stokke:www.stokke.com')!;
    const entry = { ...draft, source_id: source.id, origin: source.origin, scope_hosts: ['gear.example.org'],
      allowed_path_prefixes: ['/products/'], path_patterns: ['^/products/tripp-trapp$'],
      reevaluate_at: '2026-12-01T00:00:00.000Z', permission: {
        robots: { status: 'allowed' as const, checked_at: '2026-10-22T00:00:00.000Z', evidence: 'fixture robots' },
        terms: { status: 'allowed' as const, checked_at: '2026-10-22T00:00:00.000Z', evidence: 'fixture terms' },
      },
    };
    initializeSourceRegistry(linux.store, [entry]);
    const registry = new SourceRegistryStore(linux.store, [source]);
    registry.approveRevision({ source_id: source.id, base_revision: entry.revision, entry: { ...entry, revision: entry.revision + 1 },
      decided_by: 'fixture', evidence: 'Approved offline official fixture', approved_at: '2026-10-23T00:00:00.000Z',
      expires_at: '2026-11-30T00:00:00.000Z' });
    config.official_sources = [{ id: 'official-chair', registry_id: source.id, url: official, brand: 'Stokke',
      category: 'high_chair', fields: ['official_msrp'], enabled: true, price_variants: variants }];
    config.fetch.min_interval_ms = 0;
    config.fetch.jitter_ms = [0, 0];
    const scopes = priceSourceAuthority(linux.store, config, registry).scopes().map(row => row.scope);
    expect(scopes.map(scope => scope.variant?.id)).toEqual(['chair', 'chair-baby-set']);
    expect((await call('admin/price-sources', { scopes, observed_at: stamp })).status).toBe(200);

    let listPrice = 430000, disagree = false;
    let wanted = '단품';
    const bodies = new Map<string, string>();
    const requests: string[] = [];
    const readings: string[] = [];
    const clients = PRICE_MODELS.map((model, provider) => ({
      complete: async ({ user }: { user: string }) => {
        const officialSide = user.startsWith('Read the manufacturer');
        const { untrusted_source_data: text } = JSON.parse(user.split('\n').at(-1)!);
        readings.push(model + (officialSide ? ':official' : ':offer'));
        return { model, content: JSON.stringify(readFixture(text, officialSide, wanted, disagree && provider === 1)),
          usage: { prompt_tokens: 60, completion_tokens: 60, total_tokens: 120 } };
      },
    })) as unknown as NonNullable<Parameters<typeof runDeepSeekWeb>[0]['priceClients']>;
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.origin === 'https://site.test') return handleApi(new Request(parsed, init), ['ingest'], env);
      if (parsed.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
      expect(parsed.href).toBe(official);
      requests.push(parsed.href);
      return new Response(officialPage(listPrice), { headers: { 'content-type': 'text/html' } });
    };
    const cycle = () => runDeepSeekWeb({ mode: 'daemon_tick', stateDir: dir, store: linux.store, registry,
      loadConfig: () => config, now: () => now, fetchImpl, priceClients: clients,
      fetchPage: async url => {
        const text = bodies.get(url);
        return text ? { ok: true, text, finalUrl: url } : { ok: false, reason: 'robots_or_policy' };
      } });

    async function admit(id: number, html: string, archived = false) {
      const source_url = base + id;
      bodies.set(source_url, html);
      const text = preparedOfferText(preparePage(html, source_url));
      const candidate = await call('ingest', { kind: 'external_listing', source: 'pangpang', source_url, title: '공구 ' + id, text, captured_at: stamp });
      const { data } = await candidate.json<{ data: { id: string } }>();
      const response = await call('admin/candidates/' + data.id, { action: 'promote', request_id: 'fixture-runtime-' + id, model_id: 'model-1',
        seller_id: 'seller-1', ...(archived ? { source_ended: true } : {}) });
      expect(response.status).toBe(200);
      return (await response.json<{ data: { deal_id: string } }>()).data.deal_id;
    }
    async function apply(id: string) {
      const deal = (await adminDeal(site.db, id))!;
      const { id: proof, result } = deal.price_review!;
      const facts = result.facts!;
      const response = await call('admin/deals/' + id, { action: 'correct', expected_version: deal.version,
        request_id: 'apply-price-fixture-' + deal.version, reason: 'Verified complete same-configuration product', title: deal.title,
        model_id: 'model-1', price: facts.deal_price_krw, starts_at: null, ends_at: facts.ends_at,
        price_evidence_id: proof, include_image: false });
      expect(response.status, await response.clone().text()).toBe(200);
      return facts;
    }

    const chair = await admit(7700, offer(wanted, '공구가: 390,000원'));
    const report = await cycle();
    const evidence = (await adminDeal(site.db, chair))?.price_review;
    expect(evidence?.evidence.official_approval?.variant?.id, JSON.stringify({ report, readings, requests, evidence })).toBe('chair');
    expect(evidence?.result.facts).toMatchObject({ deal_price_krw: 390000, list_price_krw: 430000, ends_at: deadline, list_price_source_url: official, orders_open: true });
    expect(readings).toEqual(['deepseek-flash:offer', 'qwen4-max-preview:offer', 'deepseek-flash:official', 'qwen4-max-preview:official']);
    expect(await activeDealCount(site.db, now)).toBe(0);
    await apply(chair);
    const first = (await activeDealPreview(site.db, now))[0];
    expect(first).toMatchObject({ id: chair, starts_at: null, discount_pct: 9 });
    const card = renderToStaticMarkup(createElement(DealCard, { deal: first, nowMs: now }));
    expect(card).toContain('390,000');
    expect(card).toContain('<del>430,000원</del>');
    expect(card.match(/정가보다 9% 싸요/g)).toHaveLength(1);

    async function observe(id: string) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const proof = (await adminDeal(site.db, id))?.price_review;
        if (proof) return proof;
        await cycle();
      }
      throw new Error('The daemon did not observe the eligible fixture target');
    }

    // Keep the first offer scheduled and add an independently reviewed bundle.
    await cycle();
    wanted = '베이비 세트';
    const bundle = await admit(7701, offer(wanted, '공구가: 450,000원'));
    const bundleProof = await observe(bundle);
    expect(bundleProof?.evidence.official_approval?.variant?.id).toBe('chair-baby-set');
    expect(bundleProof?.result.facts).toMatchObject({ deal_price_krw: 450000, list_price_krw: 560000, ends_at: deadline });
    // Bundle contents are supplied at the independent content review.
    await site.db.prepare('INSERT INTO deal_bundle_items(id,deal_id,position,product_name) VALUES (?,?,0,?)').bind('bundle-fixture', bundle, wanted).run();
    await apply(bundle);
    expect((await modelDealSummaries(site.db, ['model-1'], now)).get('model-1')).toMatchObject({ active_count: 2, lowest_price: 390000 });

    // An undisclosed chair price cannot borrow the accessory's labeled amount.
    await cycle();
    wanted = '단품';
    const accessory = await admit(7702, offer(wanted, '공구가는 별도 문의'));
    expect((await observe(accessory)).result.outcome).toBe('unsupported_offer_price');

    const ambiguous = await admit(7704, offer(wanted, '공구가: 390,000원').replace('구성: 단품', '선택 구성 미기재'));
    expect((await observe(ambiguous)).result.outcome).toBe('configuration_mismatch');
    expect((await activeDealPreview(site.db, now)).some(deal => deal.id === ambiguous)).toBe(false);

    // A second dependent deal can be archived, and it loses the old badge too.
    await cycle();
    const archive = await admit(7703, offer(wanted, '공구가: 390,000원'), true);
    await observe(archive);
    await apply(archive);
    expect(await endedDealCount(site.db, now)).toBe(1);
    const original = Array.from(bodies.values());
    listPrice = 450000;
    now += config.selection.official_recheck_ms + 1;
    for (let cycleNo = 0; cycleNo < 4 && (await activeDealPreview(site.db, now)).some(row => row.id === chair); cycleNo++) await cycle();
    expect(Array.from(bodies.values())).toEqual(original);
    expect((await activeDealPreview(site.db, now)).some(row => row.id === chair)).toBe(false);
    expect(await endedDealCount(site.db, now)).toBe(0);
    expect(requests.length).toBeGreaterThan(1);
    for (const id of [chair, archive]) {
      for (let attempt = 0; attempt < 8; attempt++) {
        if ((await adminDeal(site.db, id))?.price_review?.result.facts?.list_price_krw === 450000) break;
        await cycle();
      }
      await apply(id);
    }
    expect((await activeDealPreview(site.db, now)).find(row => row.id === chair)?.discount_pct).toBe(13);
    expect(await endedDealCount(site.db, now)).toBe(1);

    disagree = true;
    now += config.selection.official_recheck_ms + 1;
    for (let attempt = 0; attempt < 8 && (await activeDealPreview(site.db, now)).some(row => row.id === chair); attempt++) await cycle();
    expect((await activeDealPreview(site.db, now)).some(row => row.id === chair)).toBe(false);
    expect(await endedDealCount(site.db, now)).toBe(0);

    disagree = false;
    now += config.selection.official_recheck_ms + 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      if ((await activeDealPreview(site.db, now)).some(row => row.id === chair) && await endedDealCount(site.db, now) === 1) break;
      await cycle();
    }
    expect((await activeDealPreview(site.db, now)).find(row => row.id === chair)?.discount_pct).toBe(13);
    expect(await endedDealCount(site.db, now)).toBe(1);
    expect((await activeDealPreview(site.db, Date.parse(deadline))).some(row => row.id === chair)).toBe(true);
    expect((await activeDealPreview(site.db, Date.parse(deadline) + 1)).some(row => row.id === chair)).toBe(false);
    expect(await endedDealCount(site.db, now + 86_400_000)).toBe(0);

    expect((await call('admin/price-sources', { scopes: [], observed_at: new Date(now).toISOString() })).status).toBe(200);
    expect(await activeDealCount(site.db, now)).toBe(0);
    expect(await endedDealCount(site.db, now)).toBe(0);
  } finally {
    site.close();
    linux.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('the daemon revisits an admitted Threads post across restarts and respects the interval', async () => {
  const { registerThreadsPost } = await import('../crawler/src/deal-prices/threads-schedule');
  const { threadsRegistry } = await import('../crawler/src/deal-prices/threads');
  const { productText } = await import('../crawler/src/deal-prices/verify');
  const { mockReading, offerHtml } = await import('./helpers/verified-deal-prices');
  const { readdir, readFile } = await import('node:fs/promises');
  const linux = fixture(), site = memoryD1();
  const dir = await mkdtemp(join(tmpdir(), 'threads-runtime-'));
  const permalink = 'https://www.threads.net/@fixture/post/item-id';
  let now = Date.parse(stamp), currentBody = productText(offerHtml, 'https://example.org/offer').split('\n').slice(1);
  let visits = 0, wall = false;
  vi.stubEnv('DEAL_PRICE_VERIFICATION', '1');
  vi.stubEnv('AGAMAJUNG_API_URL', 'https://site.test');
  vi.stubEnv('INGEST_TOKEN', 'threads-ingest-fixture-only');
  const env: Env = { DB: site.db, IMAGES: {} as R2Bucket, INGEST_TOKEN: 'threads-ingest-fixture-only', ADMIN_TOKEN: 'threads-admin-fixture-only' };
  try {
    await migrate(site.db);
    const source = loadRegistrySeed().find(entry => entry.origin === new URL(permalink).origin)!;
    initializeSourceRegistry(linux.store, [source]);
    const { source_id, revision } = source;
    const registry = threadsRegistry(linux.store);
    await expect(registerThreadsPost(dir, registry, permalink)).rejects.toThrow('threads_source_not_admitted');
    registry.approveRevision({ source_id, base_revision: revision, decided_by: 'fixture', evidence: 'Exact Threads fixture path and source body',
      approved_at: '2026-10-23T00:00:00.000Z', expires_at: '2026-11-30T00:00:00.000Z',
      entry: { ...source, revision: revision + 1, path_patterns: ['^/@fixture/post/item-id$'], reevaluate_at: '2026-11-30T00:00:00.000Z',
        permission: {
          robots: { status: 'allowed', checked_at: '2026-10-22T00:00:00.000Z', evidence: 'fixture robots' },
          terms: { status: 'allowed', checked_at: '2026-10-22T00:00:00.000Z', evidence: 'fixture terms' },
        },
      },
    });
    await registerThreadsPost(dir, registry, permalink);
    const config = loadDeepSeekWebConfig();
    const clients = PRICE_MODELS.map(model => ({
      complete: async ({ user }: { user: string }) => {
        const { untrusted_source_data: text } = JSON.parse(user.split('\n').at(-1)!);
        return { model, content: JSON.stringify(mockReading(text, false)), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      },
    })) as unknown as NonNullable<Parameters<typeof runDeepSeekWeb>[0]['priceClients']>;
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.origin === 'https://site.test') return handleApi(new Request(parsed, init), ['ingest'], env);
      expect(parsed.href).toBe(permalink);
      visits++;
      const body = '<article data-post-id="item-id" data-author="@fixture"><div data-post-body>' +
        currentBody.map(line => '<p>' + line + '</p>').join('') + '</div></article>';
      return new Response(wall ? '<main data-login-wall>' + body + '</main>' : body, { headers: { 'content-type': 'text/html' } });
    };
    const cycle = () => runDeepSeekWeb({ mode: 'daemon_tick', stateDir: dir, store: linux.store, now: () => now,
      loadConfig: () => config, priceClients: clients, fetchImpl,
      fetchPage: async () => ({ ok: false, reason: 'robots_or_policy' }) });
    await cycle();
    expect(visits).toBe(1);
    const item = () => site.db.prepare('SELECT id,status,text FROM ingested_items WHERE source_url = ?')
      .bind(permalink).first<{ id: string; status: string; text: string }>();
    const first = (await item())!;
    expect(first).toMatchObject({ status: 'pending', text: expect.stringContaining('390,000') });
    now += 3_599_999;
    currentBody = currentBody.map(line => line.replace('390,000', '400,000'));
    await cycle();
    expect(visits).toBe(1);
    expect(await item()).toEqual(first);
    linux.reopen();
    now++;
    await cycle();
    expect(visits).toBe(2);
    expect(await item()).toMatchObject({ id: first.id, status: 'pending', text: expect.stringContaining('400,000') });
    const taskDir = join(dir, 'threads-posts');
    const state = (await readdir(taskDir)).find(file => /^[0-9a-f]{64}\.json$/.test(file))!;
    expect(JSON.parse(await readFile(join(taskDir, state), 'utf8'))).toMatchObject({
      receipt: { id: first.id, status: 'pending', price_evidence_id: expect.any(String), revision: expect.any(String) },
    });
    now += 3_600_000;
    wall = true;
    await cycle();
    expect(visits).toBe(3);
    expect(await item()).toMatchObject({ id: first.id, text: expect.stringContaining('400,000') });
  } finally {
    linux.close();
    site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
