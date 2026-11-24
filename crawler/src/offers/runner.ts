import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import accounts from '../../config/accounts.json';
import { PROMOTE_OFFER, offerRegionDigest, offerUrl, type OfferPayload, type VerifiedOffer } from '../../../shared/verified-offer';
import { digest, identityToken, matchingVariant, type OfficialPriceScope } from '../../../shared/deal-price-evidence';
import { priceSourceAuthority } from '../deal-prices/runtime';
import { createPriceVerifier, productText } from '../deal-prices/verify';
import { scopeSnapshot } from '../deal-prices/source-sync';
import { atomicState, safePath } from '../deepseek-web/atomic-state';
import { catalogSearchUrls, loadGeunbonCatalog } from '../deepseek-web/catalog';
import { stateDir } from '../deepseek-web/config';
import { openRuntimeCollectorStore } from '../deepseek-web/runtime-store';
import { acquireWriter } from '../deepseek-web/writer-ownership';
import { identity } from '../process-identity';
import type { CollectorStore } from '../store';
import { offerConfig, sourceLimits, type OfferConfig } from './config';
import { deliverOffer, identityFor, newOffer, offerKeys, publicationClient, siteOrigin, stageOffer, type SiteClient } from './delivery';
import {
  catalogMatch, catalogSnapshot, discoveryLinks, evaluateProduct, hash, prepareProductRegions, relevant, socialRegion, type CatalogSnapshot, type ProductRegion,
} from './evidence';
import { activateDeferred, claimSource, enqueueSource, finishSource, nextOfferCycle, offerCycle, publicReader, reserveDetail, type FrontierJob } from './frontier';
import { exportOfferMetrics, offerEvent } from './metrics';
import { providerClient, readMetadata } from './providers';
import { instagramReader } from './instagram';
import { offerTransport, sourceLane, TransportError, type OfferTransport } from './transport';

const REFRESH_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const PRODUCT_BATCH = 1;
const noSignal = new AbortController().signal;
export type ProviderClients = ReturnType<typeof providerClient>;
type Dependencies = { store: CollectorStore; config: OfferConfig; dir: string; transport: OfferTransport; site: SiteClient; origin: string;
  complete?: ProviderClients };
type Prior = { offer_id: string | null; content_digest: string; catalog_revision: string; failures: string; body: string | null };

export class OfferRunner {
  private readonly discovery = loadGeunbonCatalog();
  private readonly read: ReturnType<typeof publicReader>;
  private readonly complete: ProviderClients;
  private catalog: CatalogSnapshot | null = null;
  private catalogDue = 0;
  private metricDue = 0;
  private maintenanceDue = 0;
  private scopeDue = 0;
  private scopeRevision = '';
  private readyScopes: OfficialPriceScope[] = [];
  private readonly authority: ReturnType<typeof priceSourceAuthority>;
  private readonly run = randomUUID();
  private cycle: string;

  constructor(private readonly deps: Dependencies) {
    this.cycle = offerCycle(deps.store.now());
    this.read = publicReader(deps.store, deps.config, deps.transport);
    this.complete = deps.complete ?? providerClient(deps.store, deps.config, deps.transport);
    this.authority = priceSourceAuthority(deps.store);
  }

  private async catalogRefresh(signal: AbortSignal) {
    const { store, origin, transport } = this.deps;
    if (store.now() < this.catalogDue) return;
    this.catalogDue = store.now() + RETRY_MS;
    if (!this.catalog) {
      const previous = store.db.prepare('SELECT body FROM offer_catalog_snapshot WHERE singleton=1').get() as { body: string } | undefined;
      if (previous) this.catalog = JSON.parse(previous.body) as CatalogSnapshot;
    }
    try {
      const response = await transport(new URL('/api/v1/models', origin).href, { lane: 'service', signal });
      const next = response.status === 200 && catalogSnapshot(JSON.parse(response.body).data);
      if (!next) return;
      const updated = next.revision !== this.catalog?.revision;
      this.catalog = next;
      store.transaction(() => {
        store.db.prepare(`INSERT INTO offer_catalog_snapshot(singleton,revision,body,checked_at) VALUES (1,?,?,?)
          ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,body=excluded.body,checked_at=excluded.checked_at`)
          .run(next.revision, JSON.stringify(next), store.now());
        if (updated) store.db.prepare("UPDATE offer_frontier SET due_at=?,cursor=0 WHERE gone=0 AND url IN (SELECT DISTINCT url FROM offer_product_revisions WHERE catalog_revision<>?)")
          .run(store.now(), next.revision);
      });
      this.seed();
      this.catalogDue = store.now() + REFRESH_MS;
    } catch { /* Keep the last successfully validated snapshot. */ }
  }

  seed() {
    const { store, config } = this.deps;
    const base = config.seed_urls.map(url => ({ url, category: '' }));
    const search = catalogSearchUrls(this.discovery);
    const catalog = (this.catalog?.models ?? []).flatMap(row => [
      { url: `https://09pangpang.com/search/r/${encodeURIComponent(`${row.brand} ${row.name}`)}`, category: row.category },
      ...(row.source_url ? [{ url: row.source_url, category: row.category }, { url: new URL(row.source_url).origin, category: row.category }] : []),
    ]);
    const social = accounts.seed_accounts.flatMap(account => [
      { url: `https://www.instagram.com/${account.handle}`, category: '' },
      { url: `https://www.threads.net/@${account.handle}`, category: '' },
    ]);
    const hashtags = Object.values(accounts.discovery.hashtags).flat().flatMap(tag => [
      { url: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag.replace(/^#/, ''))}`, category: '' },
      { url: `https://www.threads.net/search?q=${encodeURIComponent(tag.replace(/^#/, ''))}`, category: '' },
    ]);
    store.transaction(() => {
      for (const item of [...base, ...search, ...catalog, ...social, ...hashtags]) {
        enqueueSource(store, config, { destination: item.url, parent: '', relation: 'seed', locator: 'seed', depth: 0,
          source: new URL(item.url).hostname, category: item.category });
      }
    });
  }

  private recoverDiscovery() {
    const { store, config } = this.deps;
    const row = store.db.prepare("SELECT value FROM offer_runtime WHERE key='discovery_cursor'").get() as { value: string } | undefined;
    const items = store.db.prepare(`SELECT p.rowid AS offset,p.depth,e.locator,e.relation,e.source_url,c.canonical_url FROM source_discovery_paths p
      JOIN source_candidate_evidence e ON e.id=p.evidence_id JOIN source_candidates c ON c.id=e.candidate_id
      WHERE p.rowid>? AND p.deferred_reason='approval_required' AND c.identity='preserved' AND c.canonical_url IS NOT NULL ORDER BY p.rowid LIMIT 200`)
      .all(Number(row?.value) || 0) as { offset: number; depth: number; locator: string; relation: string; source_url: string; canonical_url: string }[];
    if (!items.length) return;
    store.transaction(() => {
      for (const item of items) {
        const url = offerUrl(item.canonical_url);
        if (!url || item.relation === 'attachment') continue;
        enqueueSource(store, config, { destination: url, parent: item.source_url, relation: item.relation,
          locator: item.locator, depth: item.depth, source: new URL(url).hostname, category: '' });
      }
      store.db.prepare("INSERT INTO offer_runtime(key,value) VALUES ('discovery_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(items.at(-1)!.offset));
    });
  }

  private async refreshScopes(signal: AbortSignal) {
    const { store, site, origin } = this.deps;
    if (store.now() < this.scopeDue) return;
    this.scopeDue = store.now() + RETRY_MS;
    const scopes = this.authority.scopes().map(({ scope }) => scope).filter(scope =>
      !!scope.variant?.site_model_id && Date.parse(scope.expires_at) > store.now());
    this.readyScopes = this.readyScopes.filter(scope => scopes.some(current => JSON.stringify(current) === JSON.stringify(scope)));
    if (!scopes.length) return;
    const snapshot = await scopeSnapshot(scopes, origin, store.now());
    try {
      let result = await site('/api/v1/admin/price-sources', 'GET', undefined, signal);
      let receipt = result.data as Partial<typeof snapshot.receipt> | null;
      if (result.status === 200 && receipt?.scopes === 0) { this.readyScopes = []; return; }
      if (result.status !== 200 || receipt?.digest !== snapshot.receipt.digest) {
        result = await site('/api/v1/admin/price-sources', 'POST', snapshot.body, signal);
        receipt = result.data as Partial<typeof snapshot.receipt> | null;
        if (receipt?.revision !== snapshot.receipt.revision) return;
      }
      if (result.status !== 200 || receipt?.site !== origin || receipt.digest !== snapshot.receipt.digest ||
        receipt.scopes !== scopes.length || typeof receipt.revision !== 'string' || !Number.isFinite(Date.parse(receipt.revision))) return;
      this.readyScopes = scopes;
      if (this.scopeRevision !== receipt.digest) {
        this.scopeRevision = receipt.digest;
        store.db.prepare(`UPDATE offer_frontier SET due_at=?,cursor=0 WHERE gone=0 AND url IN (
          SELECT url FROM offer_product_revisions WHERE failures LIKE '%missing_official_coverage%')`).run(store.now());
      }
      this.scopeDue = store.now() + REFRESH_MS;
    } catch { /* Retry authority synchronization without blocking discovery. */ }
  }

  private async product(region: ProductRegion, observedAt: string,
    check: () => Promise<{ live: 'live' | 'changed' | 'unavailable'; at: string; region?: ProductRegion }>, signal: AbortSignal) {
    const { store } = this.deps;
    if (signal.aborted) return;
    const catalog = this.catalog;
    const catalogRevision = catalog?.revision ?? hash('catalog_unavailable');
    const previous = store.db.prepare(`SELECT r.offer_id,r.content_digest,r.catalog_revision,r.failures,
      (SELECT body FROM offer_outbox o WHERE o.offer_id=r.offer_id AND o.state='acked'
        ORDER BY revision DESC LIMIT 1) body
      FROM offer_product_revisions r WHERE url=? AND locator=? ORDER BY observed_at DESC,rowid DESC LIMIT 1`)
      .get(region.source, region.locator) as Prior | undefined;
    if (!region.text || !previous && !relevant(`${region.title} ${region.text}`, catalog, this.discovery)) return;
    const prior = previous?.body ? JSON.parse(previous.body) as OfferPayload : null;
    const old = prior && 'facts' in prior ? prior : null;
    const scope = { run: this.run, cycle: this.cycle };
    const checkedAt = () => new Date(store.now()).toISOString();
    let intent: Awaited<ReturnType<typeof newOffer>> = null;
    let gates: string[] = [];
    let priceEvidence = null;
    let extraction = null, verification = null;
    const identity = { locator: region.locator, catalog_revision: catalogRevision, content_digest: region.digest };
    const liveness = async (facts: VerifiedOffer['facts'], at: string) => {
      const observed = { url: facts.source_url, seller_url: facts.seller_url, locator: region.locator, availability_badge: region.badge };
      return { ...observed, checked_at: at, product_digest: await offerRegionDigest(region.text, observed, facts.image_url) };
    };
    if (region.badge?.value === 'closed' && old && !old.closure && old.facts.source_url === region.source) {
      const live = await check();
      if (live.live === 'live') {
        const facts = { ...old.facts, availability: 'closed' as const };
        const proof = await liveness(facts, live.at);
        intent = await newOffer(store, { ...identity, content_digest: proof.product_digest, checked_at: live.at, facts,
          offer_key: old.offer_key, campaign_key: old.campaign_key, metadata: old.metadata,
          price_evidence: old.price_evidence, liveness: proof,
          closure: { text: region.text, hash: await digest(region.text) },
        }, old.offer_id);
      } else gates.push('source_unavailable');
    } else if (old?.closure && previous?.content_digest === region.digest) return;
    else {
      extraction = await readMetadata(this.complete, 'extraction', region, catalog, scope, signal);
      verification = await readMetadata(this.complete, 'verification', region, catalog, scope, signal);
      const matched = extraction && catalogMatch(extraction, region, catalog, this.discovery).model;
      const verifier = createPriceVerifier({
        offerUrls: true,
        complete: (i, input) => this.complete(i === 0 ? 'extraction' : 'verification', { ...input, signal }, scope),
        official: async offer => {
          const compatible = this.readyScopes.filter(item => item.variant?.site_model_id === matched?.id &&
            item.variant && Date.parse(item.expires_at) > store.now() && matchingVariant(offer, item.variant));
          if (compatible.length !== 1) return compatible.length ? 'configuration_mismatch' : null;
          const approval = compatible[0];
          const response = await this.read({ url: approval.url, lane: sourceLane(approval.url) }, signal, next => next === approval.url);
          if (!response.response || response.response.status !== 200 || response.response.finalUrl !== approval.url) return 'source_inaccessible';
          return { url: approval.url, text: productText(response.response.body, approval.url), observedAt: checkedAt(),
            approval: { id: approval.id, revision: approval.revision, variant: approval.variant }, approvedAt: approval.approved_at };
        },
      });
      priceEvidence = await verifier(region.source, region.text, observedAt);
      const live = await check();
      const decision = evaluateProduct({ region, extraction, verification, catalog, discovery: this.discovery,
        checkedAt: live.at, live: live.live, now: store.now(), priceEvidence });
      gates = decision.failures;
      const facts = decision.facts;
      if (old && facts && gates.length === 1 && gates[0] === 'ended' && !region.badge &&
        ['deal_price_krw','list_price_krw','ends_at','model_id','starts_at'].every(key => facts[key as keyof typeof facts] === old.facts[key as keyof typeof facts])) return;
      if (facts && !gates.length && extraction && verification) {
        const keys = await offerKeys(facts, region.locator);
        const sameCampaign = old && old.campaign_key === keys.campaign_key;
        const material = old && (old.facts.starts_at === facts.starts_at || sameCampaign) && (
          ['deal_price_krw','list_price_krw','ends_at','model_id','starts_at','orders_open'] as const
        ).some(field => old.facts[field] !== facts[field]);
        const changedConfiguration = old && old.facts.starts_at === facts.starts_at &&
          Object.entries(facts.configuration).some(([part, value]) => identityToken(old.facts.configuration[part as keyof typeof facts.configuration]) !== identityToken(value));
        if (material || changedConfiguration) gates.push('material_change');
        else {
          const { provisional, ...canonical } = keys;
          const alias = old && facts.starts_at && facts.starts_at > old.facts.ends_at ? undefined : provisional;
          const existing = identityFor(store, canonical, alias);
          const prefer = !existing && prior && 'failure' in prior && prior.expected_version === 0 ? prior.offer_id : null;
          const proof = await liveness(facts, live.at);
          intent = await newOffer(store, { ...canonical, ...identity, content_digest: proof.product_digest, checked_at: live.at, facts,
            metadata: [extraction, verification], price_evidence: priceEvidence, liveness: proof }, prefer, alias);
          if (intent === 'collision') gates.push('campaign_collision');
        }
      }
    }
    if (signal.aborted) return;
    const productId = hash([region.source, region.locator]);
    const previousGates = previous ? JSON.parse(previous.failures) as string[] : [];
    if (gates.length && (old || !prior || region.digest !== previous?.content_digest || JSON.stringify(gates) !== JSON.stringify(previousGates))) {
      const provisional = hash(['private', region.source, region.locator]);
      const previousProof = old?.digest ?? null;
      intent = await newOffer(store, { ...identity, offer_key: prior?.offer_key ?? provisional, campaign_key: prior?.campaign_key ?? provisional,
        checked_at: checkedAt(), previous_digest: previousProof, failure: { title: region.title || old?.facts.title || '공구 관찰',
          source_url: region.source, gates, retry_at: new Date(store.now() + REFRESH_MS).toISOString(), evidence: region.text } },
      previous?.offer_id ?? null);
    }
    const offerId = intent && intent !== 'collision' ? intent.offer_id : previous?.offer_id ?? null;
    const stage = intent && intent !== 'collision' ? await stageOffer(store, intent) : null;
    const revisionId = hash([productId, region.digest, catalogRevision, intent && intent !== 'collision' ? intent.digest : null, gates, observedAt]);
    store.transaction(() => {
      stage?.();
      if (offerId) store.db.prepare('INSERT OR IGNORE INTO offer_provenance(offer_id,url,locator) VALUES (?,?,?)').run(offerId, region.source, region.locator);
      const row = store.db.prepare(`INSERT OR IGNORE INTO offer_product_revisions(id,product_id,url,locator,content_digest,catalog_revision,observed_at,evidence,failures,extraction,verification,offer_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(revisionId, productId, region.source, region.locator, region.digest, catalogRevision, store.now(),
          JSON.stringify({ text: region.text, priceEvidence }), JSON.stringify(gates), JSON.stringify(extraction), JSON.stringify(verification), offerId);
      if (row.changes) {
        offerEvent(store, `product:${revisionId}`, 'product', { product: productId });
        if (gates.length) offerEvent(store, `reject:${revisionId}`, 'rejected', { product: productId, gates });
        else if (stage) offerEvent(store, `verify:${revisionId}`, 'verified', { product: productId });
      }
    });
  }

  private async failedFetch(url: string, signal: AbortSignal, present = new Set<string>()) {
    const { store } = this.deps;
    const rows = store.db.prepare(`SELECT o.body FROM offer_outbox o
      WHERE o.state='acked' AND json_extract(o.body,'$.facts.source_url')=? AND json_extract(o.claim,'$.action')=?
      AND o.revision=(SELECT max(p.revision) FROM offer_outbox p WHERE p.offer_id=o.offer_id AND p.state='acked')`).all(url, PROMOTE_OFFER) as { body: string }[];
    for (const row of rows) {
      const prior = JSON.parse(row.body) as VerifiedOffer;
      if (present.has(prior.locator)) continue;
      const now = new Date(store.now()).toISOString();
      const draft = await newOffer(store, { offer_key: prior.offer_key, campaign_key: prior.campaign_key, checked_at: now,
        locator: prior.locator, catalog_revision: prior.catalog_revision, content_digest: hash([url, now]),
        previous_digest: prior.digest, failure: { title: prior.facts.title, source_url: url, gates: ['source_unavailable'],
          retry_at: new Date(store.now() + REFRESH_MS).toISOString(), evidence: '' } }, prior.offer_id);
      if (draft && draft !== 'collision') {
        const stage = await stageOffer(store, draft);
        store.transaction(stage);
        await deliverOffer(store, this.deps.site, signal);
      }
    }
  }

  private async web(job: FrontierJob, signal: AbortSignal) {
    const { store, config } = this.deps;
    try {
      const caps = sourceLimits(config, job.source);
      if (caps.max_pages === 0) {
        finishSource(store, job, { delay: RETRY_MS, cursor: job.cursor });
        return;
      }
      const fetched = await this.read(job, signal);
      if (fetched.dispatch) {
        store.transaction(() => {
          enqueueSource(store, config, { destination: fetched.dispatch, parent: job.url, relation: 'redirect', locator: 'location',
            depth: job.depth, source: job.source, category: job.category });
          finishSource(store, job, { delay: REFRESH_MS });
        });
        return;
      }
      const { response } = fetched;
      if (!response) return;
      const id = hash([job.url, job.lease, 'scan']);
      offerEvent(store, id, 'scan', {});
      if ([404, 410].includes(response.status)) { await this.failedFetch(job.url, signal); finishSource(store, job, { delay: 0, gone: true }); return; }
      if (response.status !== 200 || signal.aborted) { finishSource(store, job, { delay: signal.aborted ? 0 : RETRY_MS, cursor: job.cursor }); return; }
      const source = response.finalUrl;
      const observedAt = new Date(store.now()).toISOString();
      const links = discoveryLinks(response.body, source);
      store.transaction(() => {
        for (const link of links) {
          const targetLane = sourceLane(link.destination);
          if (targetLane === 'public' && !/\/(?:notice|deals?|products?|offer|shop)(?:[/?]|$)/i.test(link.destination) && !relevant(`${link.label} ${link.destination}`, this.catalog, this.discovery)
            && !/(?:^|\.)(?:linktr\.ee|linktree\.com|kakao\.com|smartstore\.naver\.com|naver\.me)$/.test(new URL(link.destination).hostname)
            && !/linktr\.ee|linktree\.com/.test(new URL(source).hostname) && link.relation === 'link') continue;
          enqueueSource(store, config, { ...link, parent: source, source: job.source, depth: job.depth + 1, category: job.category });
        }
      });
      const regions = prepareProductRegions(response.body, source);
      const locators = new Set(regions.map(region => region.locator));
      await this.failedFetch(source, signal, locators);
      const digest = hash(regions.map(region => region.digest));
      const cursor = job.content_digest === digest ? job.cursor : 0;
      const count = PRODUCT_BATCH;
      let capped = false;
      let offset = cursor;
      for (; offset < Math.min(cursor + count, regions.length) && !signal.aborted; offset++) {
        if (!reserveDetail(store, this.cycle, job.source, caps.max_details_per_cycle)) { capped = true; break; }
        const region = regions[offset];
        await this.product(region, observedAt, async () => {
          const at = () => new Date(store.now()).toISOString();
          try {
            const live = await this.read({ url: source, lane: sourceLane(source) }, signal);
            if (!live.response || live.response.status !== 200) return { live: 'unavailable', at: at() };
            const rechecked = prepareProductRegions(live.response.body, live.response.finalUrl).find(item => item.locator === region.locator);
            return { live: rechecked?.digest === region.digest && rechecked.source === region.source ? 'live' : 'changed', at: at(), region: rechecked };
          } catch { return { live: 'unavailable', at: at() }; }
        }, signal);
        if (!signal.aborted) {
          store.db.prepare('UPDATE offer_frontier SET cursor=?,content_digest=?,lease_until=? WHERE url=? AND lease=?')
            .run(offset + 1, digest, store.now() + 180_000, job.url, job.lease);
          await deliverOffer(store, this.deps.site, signal);
        }
      }
      const remaining = offset < regions.length;
      finishSource(store, job, { delay: capped ? nextOfferCycle(store.now()) - store.now() : remaining ? 0 : REFRESH_MS, cursor: remaining ? offset : 0, digest });
    } catch (error) {
      if (!signal.aborted && error instanceof TransportError && ['access_restricted','login_required'].includes(error.code)) {
        await this.failedFetch(job.url, signal);
      }
      const delay = error instanceof TransportError && error.retryAt ? Math.max(1000, error.retryAt - store.now()) : RETRY_MS;
      finishSource(store, job, { delay: signal.aborted ? 0 : delay, cursor: job.cursor });
    }
  }

  private async social(signal: AbortSignal) {
    const { store } = this.deps;
    const row = store.db.prepare(`SELECT o.*, c.requested_at,c.completed_at,c.status,c.identity,c.digest AS checked_digest
      FROM offer_social_observations o LEFT JOIN offer_social_checks c ON c.observation_id=o.id
      LEFT JOIN offer_runtime r ON r.key='social:' || o.id
      WHERE r.key IS NULL AND (c.completed_at IS NOT NULL OR c.id IS NULL) ORDER BY o.observed_at,o.id LIMIT 1`).get() as
      { id: string; url: string; seller: string; evidence: string; image_url: string | null; digest: string; completed_at: number | null; status: string | null; identity: string | null; checked_digest: string | null } | undefined;
    if (!row) return false;
    if (row.completed_at === null) {
      store.db.prepare('INSERT OR IGNORE INTO offer_social_checks(id,observation_id,requested_at) VALUES (?,?,?)')
        .run(hash(['social-check', row.id]), row.id, store.now());
      return true;
    }
    const region = socialRegion(row.url, row.seller, row.evidence, row.image_url);
    await this.product(region, new Date(row.completed_at!).toISOString(), async () => ({
      at: new Date(row.completed_at!).toISOString(),
      live: row.status !== 'live' || row.identity !== row.seller ? 'unavailable' : row.digest === row.checked_digest ? 'live' : 'changed',
    }), signal);
    if (!signal.aborted) store.db.prepare("INSERT OR IGNORE INTO offer_runtime(key,value) VALUES (?,?)").run(`social:${row.id}`, 'processed');
    return true;
  }

  coverage() {
    const ready = new Set(this.readyScopes.filter(scope => Date.parse(scope.expires_at) > this.deps.store.now())
      .map(scope => scope.variant?.site_model_id));
    return { official_scope_revision: this.scopeRevision || null,
      ready_official_variants: [...ready],
      missing_official_coverage: (this.catalog?.models ?? []).filter(model => !ready.has(model.id)).map(model => model.id) };
  }

  async tick(signal = noSignal) {
    const { store, config, dir, site } = this.deps;
    if (signal.aborted) return false;
    this.cycle = offerCycle(store.now());
    await this.catalogRefresh(signal);
    await this.refreshScopes(signal);
    if (store.now() >= this.metricDue) {
      exportOfferMetrics(store, dir);
      this.metricDue = (Math.floor(store.now() / 3_600_000) + 1) * 3_600_000;
    }
    if (store.now() >= this.maintenanceDue) {
      activateDeferred(store, config);
      this.recoverDiscovery();
      this.maintenanceDue = store.now() + 1000;
    }
    const delivered = await deliverOffer(store, site, signal);
    const social = await this.social(signal);
    const job = signal.aborted ? undefined : claimSource(store, 'web', config, this.cycle);
    if (job) await this.web(job, signal);
    return !!job || social || delivered;
  }
}

export async function runOfferDaemon(once = false, urls: string[] = []) {
  safePath(join(stateDir(), 'heartbeat.json'));
  const ownership = acquireWriter(stateDir());
  const abort = new AbortController();
  const stop = () => abort.abort();
  const signal = abort.signal;
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let store: CollectorStore | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let social: ReturnType<typeof instagramReader> | undefined;
  let socialTick: Promise<boolean> | undefined;
  try {
    const config = offerConfig(), origin = siteOrigin(), dir = ownership.dir, interval = config.idle_tick_ms;
    store = openRuntimeCollectorStore();
    const transport = offerTransport(store, dir);
    const runner = new OfferRunner({ store, config, dir, origin, transport, site: publicationClient(origin, transport) });
    runner.seed();
    social = instagramReader(store, dir, config, transport);
    store.transaction(() => {
      for (const destination of urls) {
        const url = offerUrl(destination);
        if (url) enqueueSource(store!, config, { destination: url, parent: '', relation: 'manual', locator: 'cli',
          source: new URL(url).hostname, category: '', depth: 0 });
      }
    });
    const owner = identity();
    const beat = () => {
      const at = Date.now();
      atomicState(join(dir, 'daemon-heartbeat.json'), { identity: owner, at });
      atomicState(join(dir, 'offer-heartbeat.json'), { at, pid: process.pid, idle_tick_ms: interval, ...runner.coverage() });
    };
    beat();
    heartbeat = setInterval(() => { try { beat(); } catch { console.error('offer_heartbeat_unavailable'); } }, 1000);
    heartbeat.unref();
    while (!signal.aborted) {
      let worked = false;
      socialTick ??= social.tick(signal).finally(() => { socialTick = undefined; });
      try { worked = await runner.tick(signal); }
      catch { console.error('offer_tick_failed'); }
      if (once) { await socialTick; break; }
      if (!worked && !signal.aborted) await wait(interval, undefined, { signal }).catch(() => {});
    }
  } finally {
    abort.abort();
    await socialTick?.catch(() => false);
    await social?.stop();
    clearInterval(heartbeat);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store?.close();
    ownership.release();
  }
}
