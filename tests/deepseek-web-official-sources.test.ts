import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalUrl } from '../shared/privacy-rules';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { loadMemory } from '../crawler/src/deepseek-web/memory';
import { runDeepSeekWeb } from '../crawler/src/deepseek-web/runner';
import { admitOfficial, effectiveRecheckMs, enabledOfficialSources, officialCandidatesByCategory, officialDue, officialLegacySources } from '../crawler/src/deepseek-web/official-sources';
import { loadRegistrySeed } from '../crawler/src/source-registry/seed';
import { staticEntryReason, registryUrl } from '../crawler/src/source-registry/policy';
import { SourceRegistryStore } from '../crawler/src/source-registry/store';
import type { DeepSeekWebConfig } from '../crawler/src/deepseek-web/types';
import { fixture } from './helpers/collector';

const ORIGINS = ['official:stokke:www.stokke.com', 'official:bugaboo:www.bugaboo.com', 'official:babybjorn:www.babybjorn.kr'];
const dirs: string[] = [];
const stores: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of stores.splice(0)) f.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsw-official-'));
  dirs.push(dir);
  return dir;
}
function testConfig(enabled?: string[], selection: Partial<DeepSeekWebConfig['selection']> = {}): DeepSeekWebConfig {
  const config = structuredClone(loadDeepSeekWebConfig());
  for (const source of config.official_sources) source.enabled = enabled ? enabled.includes(source.id) : true;
  Object.assign(config.selection, { max_pages_per_cycle: 1, category_quota_per_cycle: 1, legacy_budget_per_cycle: 0, official_recheck_ms: 21600000 }, selection);
  config.fetch.min_interval_ms = 0;
  config.fetch.jitter_ms = [0, 0];
  return config;
}
function sourceById(config: DeepSeekWebConfig, id: string) {
  const source = config.official_sources.find(s => s.id === id);
  if (!source) throw new Error(`missing fixture source ${id}`);
  return source;
}
function approvedRegistry(f: ReturnType<typeof fixture>, config: DeepSeekWebConfig, ids: string[] = ORIGINS) {
  const registry = new SourceRegistryStore(f.store, [...f.settings.sources, ...officialLegacySources(config, loadRegistrySeed())]);
  for (const id of ids) {
    const base = registry.get(id);
    if (!base) throw new Error(`missing seed registry entry ${id}`);
    registry.approveRevision({
      source_id: id,
      base_revision: base.revision,
      entry: {
        ...base,
        revision: base.revision + 1,
        permission: {
          robots: { status: 'allowed', checked_at: '2026-10-22T00:00:00Z', evidence: 'fixture robots' },
          terms: { status: 'allowed', checked_at: '2026-10-22T00:00:00Z', evidence: 'fixture terms' },
        },
        reevaluate_at: '2027-01-01T00:00:00Z',
      },
      decided_by: 'fixture-reviewer',
      evidence: 'synthetic fixture approval',
      approved_at: '2026-10-22T00:00:00Z',
      expires_at: '2027-01-01T00:00:00Z',
    });
  }
  return registry;
}
const stubFetch = (handler: (url: string) => Response) => (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
const allowRobots = (url: string) => new URL(url).pathname === '/robots.txt'
  ? new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } })
  : new Response('<html><body>official page</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const approvalCount = (f: ReturnType<typeof fixture>) => (f.store.db.prepare('SELECT count(*) AS n FROM source_registry_approvals').get() as { n: number }).n;
const outcomeRows = (dir: string) => readFileSync(join(dir, 'outcomes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { outcome: string; url: string; detail?: Record<string, unknown> });

describe('official source configuration', () => {
  test('is derived from the seed models, disabled by default, and excludes only canonical-rejected rows', () => {
    type SeedModel = { verify_level?: string; source_url?: string };
    const config = loadDeepSeekWebConfig();
    const seed = loadRegistrySeed();
    const models = (JSON.parse(readFileSync(join(process.cwd(), 'seed/models.json'), 'utf8')) as { models: SeedModel[] }).models;
    const pageModels = models.filter(model => model.verify_level === 'page_body' && typeof model.source_url === 'string' && model.source_url.length > 0);
    const derived: string[] = [];
    const rejected: SeedModel[] = [];
    for (const model of pageModels) {
      try { canonicalUrl(model.source_url!); derived.push(model.source_url!); } catch { rejected.push(model); }
    }
    expect(rejected).toHaveLength(1);
    expect(rejected[0].source_url).toContain('dthrone');
    expect(new Set(config.official_sources.map(source => source.url))).toEqual(new Set(derived));
    expect(config.official_sources.every(source => !source.enabled)).toBe(true);
    expect(config.official_sources.filter(source => source.enabled).length).toBe(0);
    expect(officialCandidatesByCategory(enabledOfficialSources({ ...config, official_sources: config.official_sources.map(s => ({ ...s, enabled: true })) })))
      .toMatchObject({ high_chair: expect.any(Array), stroller: expect.any(Array), bouncer: expect.any(Array), carrier: expect.any(Array) });
    for (const source of config.official_sources) {
      const url = registryUrl(source.url);
      const entry = seed.find(candidate => candidate.origin === url.origin && staticEntryReason(candidate, url, source.fields) === undefined);
      expect(entry, source.id).toBeTruthy();
      expect(source.registry_id).toBe(entry!.source_id);
      expect(source.fields.every(field => entry!.collectable_fields.includes(field as never))).toBe(true);
    }
    expect(config.official_sources.some(source => source.url.includes('dthrone'))).toBe(false);
    expect(JSON.stringify(config.official_sources)).not.toMatch(/instagram|threads|momcalendar/);
    expect(config.prohibited_hosts).toContain('momcalendar.com');
  });

  test('D.THRONE is excluded because canonical identity rejects the idx query', () => {
    expect(() => canonicalUrl('https://www.dthrone.com/102/?idx=58')).toThrow();
  });

  test('BabyBjörn keeps the raw trailing-slash URL and a slash-free canonical identity', () => {
    const sources = loadDeepSeekWebConfig().official_sources.filter(source => source.registry_id.includes('babybjorn'));
    expect(sources).toHaveLength(5);
    for (const source of sources) {
      expect(source.url.endsWith('/')).toBe(true);
      expect(registryUrl(source.url).pathname.endsWith('/')).toBe(true);
      expect(canonicalUrl(source.url).endsWith('/')).toBe(false);
    }
  });

  type RawOfficial = { id: string; registry_id: string; url: string; brand: string; category: string; fields: string[]; enabled: boolean; recheck_ms?: number };
  type RawConfig = { official_sources: RawOfficial[]; selection: { official_recheck_ms: number } };
  test.each<[string, (raw: RawConfig) => void]>([
    ['hard-forbidden host', raw => { raw.official_sources[0].url = 'https://www.instagram.com/p/abc/'; }],
    ['threads.net host', raw => { raw.official_sources[0].url = 'https://www.threads.net/@brand/post'; }],
    ['facebook.com host', raw => { raw.official_sources[0].url = 'https://www.facebook.com/brand/posts/1'; }],
    ['momcalendar.com host', raw => { raw.official_sources[0].url = 'https://momcalendar.com/event/1'; }],
    ['registry origin mismatch', raw => { raw.official_sources[0].url = 'https://www.bugaboo.com/kr-ko/%EC%8A%A4%ED%8A%B8%EB%A1%A4%EB%9F%AC/foo-PM000001.html'; }],
    ['blocked registry path', raw => { raw.official_sources[0].url = 'https://www.stokke.com/KOR/ko-kr/article/hidden.html'; }],
    ['uncollectable field', raw => { raw.official_sources[0].fields = ['clue_price']; }],
    ['duplicate source id', raw => { raw.official_sources[1].id = raw.official_sources[0].id; }],
    ['non-https URL', raw => { raw.official_sources[0].url = raw.official_sources[0].url.replace('https:', 'http:'); }],
    ['URL credentials', raw => { raw.official_sources[0].url = raw.official_sources[0].url.replace('https://', 'https://user:pass@'); }],
    ['unsupported registry scope (Cybex)', raw => { raw.official_sources[0] = { id: 'cybex-fixture', registry_id: 'official:cybex:www.cybex-online.com', url: 'https://www.cybex-online.com/en/car-seats/', brand: 'Cybex', category: 'car_seat', fields: ['official_msrp'], enabled: false }; }],
    ['unsupported registry scope (Nuna)', raw => { raw.official_sources[0] = { id: 'nuna-fixture', registry_id: 'official:nuna:nunababy.com', url: 'https://nunababy.com/strollers', brand: 'Nuna', category: 'stroller', fields: ['official_msrp'], enabled: false }; }],
    ['per-source recheck below one hour', raw => { raw.official_sources[0].recheck_ms = 600000; }],
    ['global recheck below one hour', raw => { raw.selection.official_recheck_ms = 600000; }],
    ['D.THRONE idx identity', raw => { raw.official_sources.push({ id: 'dthrone-idx', registry_id: 'official:dthrone:www.dthrone.com', url: 'https://www.dthrone.com/102/?idx=58', brand: 'D.THRONE', category: 'carrier', fields: ['official_msrp'], enabled: false }); }],
  ])('rejects %s at load time', (_name, mutate) => {
    const dir = stateDir();
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'crawler/deepseek-web/config.json'), 'utf8'));
    mutate(raw);
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(raw));
    expect(() => loadDeepSeekWebConfig(file)).toThrow('invalid_deepseek_web_config');
  });
});

describe('official registry admission', () => {
  test('fails closed while permissions are unknown and never mutates approvals', () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(['stokke-tripp-trapp-1001']);
    const registry = new SourceRegistryStore(f.store, [...f.settings.sources, ...officialLegacySources(config, loadRegistrySeed())]);
    const source = sourceById(config, 'stokke-tripp-trapp-1001');
    const before = approvalCount(f);
    const revision = registry.get(source.registry_id)!.revision;
    expect(admitOfficial(registry, source)).toMatchObject({ allowed: false, reason: 'permission_unknown' });
    expect(admitOfficial(registry, { ...source, registry_id: 'official:unknown:none' })).toMatchObject({ allowed: false, reason: 'unknown_source' });
    expect(approvalCount(f)).toBe(before);
    expect(registry.get(source.registry_id)!.revision).toBe(revision);
  });

  test('a synthetic out-of-band approval allows only the approved scope', () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(['stokke-tripp-trapp-1001']);
    const registry = approvedRegistry(f, config, ['official:stokke:www.stokke.com']);
    const source = sourceById(config, 'stokke-tripp-trapp-1001');
    expect(admitOfficial(registry, source)).toMatchObject({ allowed: true, reason: 'approved', revision: 2 });
    expect(approvalCount(f)).toBe(1);
    expect(admitOfficial(registry, { ...source, url: 'https://www.stokke.com/KOR/ko-kr/article/hidden.html', registry_id: source.registry_id })).toMatchObject({ allowed: false, reason: 'blocked_path' });
  });

  test('legacy adapters are in-memory only and do not change collector settings', () => {
    const f = fixture();
    stores.push(f);
    const before = f.settings.sources.length;
    const config = testConfig();
    const adapters = officialLegacySources(config, loadRegistrySeed());
    expect(adapters).toHaveLength(3);
    expect(adapters.every(adapter => adapter.kind === 'manufacturer' && adapter.max_pages === 1 && adapter.enabled)).toBe(true);
    expect(adapters.flatMap(adapter => adapter.official_fields)).toEqual(expect.arrayContaining(['official_msrp', 'bundle_components', 'manual_url']));
    expect(f.settings.sources).toHaveLength(before);
    expect(approvalCount(f)).toBe(0);
  });

  test('due/recheck uses the per-source override and default', () => {
    const config = testConfig();
    const source = sourceById(config, 'stokke-tripp-trapp-1001');
    const rotation = {
      policy_version: 1 as const, category_digest: '', category_cursor: 0, legacy_cursor: 0, search_cursor: {}, official_cursor: {}, last_cycle: null,
      official_visits: { [source.id]: { source_id: source.id, url: source.url, canonical_url: canonicalUrl(source.url), last_at: '2026-10-23T01:00:00Z', next_due_at: '2026-10-23T02:00:00Z', outcome: 'fetched' as const, reason: null } },
    };
    expect(officialDue(rotation, source, Date.parse('2026-10-23T01:59:00Z'))).toBe(false);
    expect(officialDue(rotation, source, Date.parse('2026-10-23T02:00:00Z'))).toBe(true);
    expect(effectiveRecheckMs({ ...source, recheck_ms: 3600000 }, config)).toBe(3600000);
  });
});

describe('official lane in the runner', () => {
  const fixedNow = () => Date.parse('2026-10-23T01:00:00Z');

  test('fetches every approved due page, then discards it without model extraction or queueing', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(undefined, { max_pages_per_cycle: 11 });
    const registry = approvedRegistry(f, config);
    const dir = stateDir();
    const requested: string[] = [];
    const complete = vi.fn();
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, registry, loadConfig: () => config,
      now: fixedNow, client: { complete },
      fetchImpl: stubFetch(url => { requested.push(url); return allowRobots(url); }),
    });
    expect(report.outcome).toBe('completed');
    expect(report.coverage!.official).toMatchObject({
      stroller: { due: 3, attempted: 3, fetched: 3, registry_denied: 0 },
      high_chair: { due: 3, attempted: 3, fetched: 3 },
      carrier: { due: 3, attempted: 3, fetched: 3 },
      bouncer: { due: 2, attempted: 2, fetched: 2 },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(report.extractions).toBe(0);
    expect(report.requests_spent).toBe(0);
    const memory = await loadMemory(dir);
    expect(Object.keys(memory.rotation.official_visits)).toHaveLength(11);
    expect(Object.values(memory.rotation.official_visits).every(visit => visit.outcome === 'fetched' && visit.next_due_at > new Date(fixedNow()).toISOString())).toBe(true);
    expect(memory.pending_urls).toEqual([]);
    expect(memory.observed_urls).toEqual([]);
    expect(outcomeRows(dir).filter(row => row.outcome === 'official_visit')).toHaveLength(11);
    expect(outcomeRows(dir).some(row => ['extracted', 'out_of_scope', 'candidate_rejected'].includes(row.outcome))).toBe(false);
    expect(requested.filter(url => !url.endsWith('/robots.txt'))).toHaveLength(11);
    expect(approvalCount(f)).toBe(3);
  }, 15000);

  test('registry denials happen before any fetch or model call', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(undefined, { max_pages_per_cycle: 0 });
    const dir = stateDir();
    const fetchImpl = vi.fn();
    const complete = vi.fn();
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config,
      now: fixedNow, client: { complete }, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.coverage!.official.stroller?.registry_denied).toBe(3);
    expect(report.coverage!.official.carrier?.registry_denied).toBe(3);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(approvalCount(f)).toBe(0);
    const memory = await loadMemory(dir);
    expect(Object.values(memory.rotation.official_visits)).toHaveLength(11);
    expect(Object.values(memory.rotation.official_visits).every(visit => visit.outcome === 'registry_denied' && visit.reason === 'permission_unknown')).toBe(true);
    expect(outcomeRows(dir).filter(row => row.outcome === 'official_registry_denied')).toHaveLength(11);
    for (const id of ORIGINS) expect(registryRevision(f, id)).toBe(1);
  });

  test('robots.txt denial is recorded without requesting the official page', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(['babybjorn-bouncer-bliss']);
    const registry = approvedRegistry(f, config, ['official:babybjorn:www.babybjorn.kr']);
    const dir = stateDir();
    const requested: string[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, registry, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() },
      fetchImpl: stubFetch(url => {
        requested.push(url);
        return new URL(url).pathname === '/robots.txt'
          ? new Response('User-agent: *\nDisallow: /products/\n', { status: 200, headers: { 'content-type': 'text/plain' } })
          : new Response('should not be requested', { status: 200 });
      }),
    });
    expect(report.coverage!.official.bouncer).toMatchObject({ due: 1, attempted: 1, fetched: 0, robots_blocked: 1 });
    expect(requested.some(url => url.includes('/products/'))).toBe(false);
    const visit = (await loadMemory(dir)).rotation.official_visits['babybjorn-bouncer-bliss'];
    expect(visit).toMatchObject({ outcome: 'robots_blocked', reason: 'robots' });
  });

  test('a same-origin redirect into a registry-blocked path is not fetched', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(['stokke-tripp-trapp-1001']);
    const registry = approvedRegistry(f, config, ['official:stokke:www.stokke.com']);
    const dir = stateDir();
    const requested: string[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, registry, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() },
      fetchImpl: stubFetch(url => {
        requested.push(url);
        if (new URL(url).pathname === '/robots.txt') return allowRobots(url);
        return new Response(null, { status: 302, headers: { location: '/KOR/ko-kr/event/hidden.html' } });
      }),
    });
    expect(report.coverage!.official.high_chair).toMatchObject({ due: 1, attempted: 1, fetched: 0, redirect_blocked: 1 });
    expect(requested.some(url => url.includes('/event/'))).toBe(false);
    expect((await loadMemory(dir)).rotation.official_visits['stokke-tripp-trapp-1001']).toMatchObject({ outcome: 'redirect_blocked', reason: 'blocked_path' });
  });

  test('a cross-origin redirect is classified as redirected, not fetched', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(['stokke-tripp-trapp-1001']);
    const registry = approvedRegistry(f, config, ['official:stokke:www.stokke.com']);
    const dir = stateDir();
    const requested: string[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, registry, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() },
      fetchImpl: stubFetch(url => {
        requested.push(url);
        if (new URL(url).pathname === '/robots.txt') return allowRobots(url);
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/official.html' } });
      }),
    });
    expect(report.coverage!.official.high_chair).toMatchObject({ due: 1, attempted: 1, fetched: 0, redirect_blocked: 1 });
    expect(requested.some(url => url.startsWith('https://evil.example'))).toBe(false);
    expect((await loadMemory(dir)).rotation.official_visits['stokke-tripp-trapp-1001']).toMatchObject({ outcome: 'redirect_blocked', reason: 'cross_origin' });
  });

  test('dry runs never visit the official lane or advance its rotation state', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig();
    const dir = stateDir();
    const report = await runDeepSeekWeb({
      mode: 'dry_run', stateDir: dir, store: f.store, urls: ['https://fixture.example/deepseek-web-sample'],
      loadConfig: () => config,
      client: { complete: async () => ({ content: '{"brand":"A","model":"B","category":"정보 없음","gonggu_price":"정보 없음","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":false}', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'deepseek-chat' }) },
    });
    expect(report.outcome).toBe('completed');
    const memory = await loadMemory(dir);
    expect(memory.rotation.official_visits).toEqual({});
    expect(memory.rotation.category_cursor).toBe(0);
    expect(outcomeRows(dir).some(row => row.outcome.startsWith('official_'))).toBe(false);
  });

  test('official pages execute before a categorized backlog while the quota still rotates categories', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig([], { max_pages_per_cycle: 2 });
    // An approved official source exists but stays disabled: enable only the bouncer page.
    config.official_sources = config.official_sources.map(source => ({ ...source, enabled: source.id === 'babybjorn-bouncer-bliss' }));
    const registry = approvedRegistry(f, config, ['official:babybjorn:www.babybjorn.kr']);
    const dir = stateDir();
    await seedBacklog(dir, { stroller: 1, carrier: 0, bouncer: 0 });
    const order: string[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, registry, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() },
      fetchImpl: stubFetch(url => { order.push(`official:${url}`); return allowRobots(url); }),
      fetchPage: async url => { order.push(`detail:${url}`); return { ok: true, text: '<html><body>no deal</body></html>', finalUrl: url }; },
      urls: [],
    });
    expect(report.coverage!.rotation.planned_pages).toBe(2);
    expect(order.findIndex(entry => entry.startsWith('official:'))).toBeLessThan(order.findIndex(entry => entry.startsWith('detail:')));
    const fetched = readFileSync(join(dir, 'outcomes.jsonl'), 'utf8');
    expect(fetched).toContain('official_visit');
  });

  test('a bounded cycle serves one page per backed-up category instead of starving carriers and bouncers', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig([], { max_pages_per_cycle: 3 });
    const dir = stateDir();
    await seedBacklog(dir);
    const calls: string[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() },
      fetchPage: async url => { calls.push(url); return { ok: true, text: '<html><body>no deal</body></html>', finalUrl: url }; },
    });
    expect(report.coverage!.rotation.planned_pages).toBe(3);
    expect(report.coverage!.rotation.served).toEqual(expect.arrayContaining(['stroller', 'high_chair', 'car_seat']));
    expect(calls).toHaveLength(3);
    const memory = await loadMemory(dir);
    const remaining = memory.pending_urls.map(url => memory.pending_catalog_meta[url]?.category);
    expect(remaining.filter(category => category === 'stroller')).toHaveLength(9);
    expect(remaining.filter(category => category === 'carrier')).toHaveLength(2);
    expect(remaining.filter(category => category === 'bouncer')).toHaveLength(2);
  });

  test('a stopped official domain is classified as domain_blocked without a fetch', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig(['stokke-tripp-trapp-1001']);
    const registry = approvedRegistry(f, config, ['official:stokke:www.stokke.com']);
    const dir = stateDir();
    const fetchImpl = vi.fn();
    f.store.put('domain_state', 'stokke.com', { stopped: true, next_at: 0, reason: 'blocked' });
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, registry, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() }, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.outcome).toBe('completed');
    expect(report.coverage!.official.high_chair).toMatchObject({ due: 1, attempted: 1, fetched: 0, domain_blocked: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await loadMemory(dir)).rotation.official_visits['stokke-tripp-trapp-1001']).toMatchObject({ outcome: 'domain_blocked', reason: 'domain_stopped' });
    expect(outcomeRows(dir).filter(row => row.outcome === 'official_domain_blocked')).toHaveLength(1);
  });

  test('orphaned pending details from a removed scope category drain as legacy work', async () => {
    const f = fixture();
    stores.push(f);
    const config = testConfig([], { max_pages_per_cycle: 2 });
    config.scope_categories = config.scope_categories.filter(category => category.id === 'play_gym');
    const dir = stateDir();
    const { emptyMemory, saveMemory } = await import('../crawler/src/deepseek-web/memory');
    const memory = emptyMemory();
    const orphan = 'https://09pangpang.com/post/910199';
    memory.pending_urls.push(orphan);
    memory.pending_catalog_meta[orphan] = { catalog_product_id: 'catalog-bouncer', category: 'bouncer' };
    await saveMemory(dir, memory);
    const calls: string[] = [];
    const report = await runDeepSeekWeb({
      mode: 'once', stateDir: dir, store: f.store, loadConfig: () => config, now: fixedNow,
      client: { complete: vi.fn() },
      fetchPage: async url => { calls.push(url); return { ok: true, text: '<html><body>no deal</body></html>', finalUrl: url }; },
    });
    expect(report.outcome).toBe('completed');
    expect(calls).toContain(orphan);
    expect((await loadMemory(dir)).pending_urls).toEqual([]);
  });
});

function registryRevision(f: ReturnType<typeof fixture>, id: string) {
  return (f.store.db.prepare('SELECT max(revision) AS revision FROM source_registry_revisions WHERE source_id=?').get(id) as { revision: number }).revision;
}

async function seedBacklog(dir: string, counts: Record<'stroller' | 'carrier' | 'bouncer', number> = { stroller: 10, carrier: 2, bouncer: 2 }) {
  const { emptyMemory, saveMemory } = await import('../crawler/src/deepseek-web/memory');
  const memory = emptyMemory();
  let start = 900100;
  for (const category of ['stroller', 'carrier', 'bouncer'] as const) {
    for (let i = 0; i < counts[category]; i++) {
      const url = `https://09pangpang.com/post/${start + i}`;
      memory.pending_urls.push(url);
      memory.pending_catalog_meta[url] = { catalog_product_id: `catalog-${category}`, category };
    }
    start += 100;
  }
  await saveMemory(dir, memory);
}
