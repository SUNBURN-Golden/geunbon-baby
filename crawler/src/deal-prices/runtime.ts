import { assessPriceEvidence, identityToken, isOfficialPriceScope, matchingVariant, type SourceReadings, type OfficialPriceScope, type PriceEvidence } from '../../../shared/deal-price-evidence';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { config as collectorConfig } from '../source-policy';
import type { CollectorStore } from '../store';
import { SourceRegistryStore } from '../source-registry/store';
import { loadRegistrySeed } from '../source-registry/seed';
import { loadGeunbonCatalog } from '../deepseek-web/catalog';
import { loadDeepSeekWebConfig } from '../deepseek-web/config';
import type { OfficialSourceConfig } from '../deepseek-web/types';
import { preparePage } from '../deepseek-web/page-content';
import { evaluateUrlDomainPolicy } from '../deepseek-web/domain-policy';
import { enabledOfficialSources, officialLegacySources } from '../deepseek-web/official-sources';
import { createPublicFetcher, fetchPublicText } from '../deepseek-web/public-fetch';
import { createPriceVerifier, preparedOfferText, productText, type PriceCompletion } from './verify';

export function priceSourceAuthority(store?: CollectorStore, config = loadDeepSeekWebConfig(), suppliedRegistry?: SourceRegistryStore) {
  const registry = suppliedRegistry ?? (store ? new SourceRegistryStore(store, [
    ...collectorConfig.sources, ...officialLegacySources(config, loadRegistrySeed()),
  ]) : null);
  const domainAllowed = (url: string) => !evaluateUrlDomainPolicy(store, url, config).blocked;
  const approvedScope = (source: OfficialSourceConfig, url: string) => {
    if (!registry || !source.fields.includes('official_msrp') || !domainAllowed(url) ||
        canonicalUrl(url) !== canonicalUrl(source.url)) return null;
    const decision = registry.decide(source.registry_id, url, ['official_msrp']);
    if (!decision.allowed || decision.revision === null || !decision.approval || registry.get(source.registry_id, decision.revision)?.kind !== 'manufacturer_importer') return null;
    const scope = { ...decision.approval, revision: decision.revision, url: canonicalUrl(source.url),
      brand: identityToken(source.brand) };
    return scope;
  };
  const catalog = loadGeunbonCatalog();
  const scopes = () => enabledOfficialSources(config).flatMap(source => {
    const approval = approvedScope(source, source.url);
    if (!approval) return [];
    return (source.price_variants ?? []).flatMap(mapping => {
      const product = catalog.products.find(entry => entry.id === mapping.catalog_id);
      if (!product || identityToken(product.brand) !== approval.brand ||
          identityToken(mapping.configuration.brand) !== approval.brand) return [];
      const brand_aliases = product.brand_aliases;
      const model_aliases = [...new Set([product.product_line, ...product.ko_aliases, ...product.en_aliases])]
        .filter(alias => !brand_aliases.some(brand => identityToken(alias) === identityToken(brand)));
      const scope: OfficialPriceScope = { ...approval, model: identityToken(mapping.configuration.model),
        variant: { ...mapping, brand_aliases, model_aliases } };
      return isOfficialPriceScope(scope) ? [{ source, scope }] : [];
    });
  });
  const approved = (evidence: PriceEvidence) => {
    if (!evidence.official) return true;
    const { url, observed_at } = evidence.official.source;
    const config = assessPriceEvidence(evidence).facts?.configuration;
    return scopes().some(({ scope }) => scope.url === url && scope.id === evidence.official_approval?.id &&
      scope.revision === evidence.official_approval.revision &&
      JSON.stringify(scope.variant) === JSON.stringify(evidence.official_approval.variant) && scope.approved_at <= observed_at && observed_at < scope.expires_at &&
      (!config || scope.brand === identityToken(config.brand) && scope.model === identityToken(config.model)));
  };
  const uncovered = () => {
    const covered = new Set(scopes().map(({ source, scope }) => source.id + '/' + scope.variant?.id));
    return config.official_sources.flatMap(source => source.price_variants?.length ?
      source.price_variants.map(variant => source.id + '/' + variant.id) : [source.id]).filter(id => !covered.has(id));
  };
  return { domainAllowed, scopes, approvedScope, approved, uncovered };
}

export function priceRuntime(complete: PriceCompletion, store?: CollectorStore, config = loadDeepSeekWebConfig(), suppliedRegistry?: SourceRegistryStore,
  deps?: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; beforeRequest?: (url: string) => void; fetcher?: ReturnType<typeof createPublicFetcher> }) {
  const { domainAllowed, scopes, approvedScope } = priceSourceAuthority(store, config, suppliedRegistry);
  const fetcher = deps?.fetcher ?? createPublicFetcher(config, deps);
  const now = deps?.now ?? Date.now;
  const fetchedPages = new Map<string, { text: string; at: string; expires: number }>();
  const publicOffer = async (url: string) => {
    if (!domainAllowed(url)) return null;
    const response = await fetchPublicText(fetcher, url, {
      beforeRequest(next) {
        if (!domainAllowed(next)) throw new Error('source_denied');
      },
    }).catch(() => null);
    if (!response?.ok || canonicalUrl(response.finalUrl) !== canonicalUrl(url)) return null;
    const page = preparePage(response.text, url);
    const text = preparedOfferText(page);
    return text ? { text, contentHash: page.content_hash } : null;
  };
  const verify = createPriceVerifier({ complete, official: async (offer: SourceReadings, beforeRequest?: (url: string) => void) => {
    const authority = scopes();
    const admitted = authority.filter(({ scope }) => scope.variant && matchingVariant(offer, scope.variant));
    if (admitted.length !== 1) return admitted.length || authority.some(({ scope: { variant } }) =>
      variant && offer.readings.some(reading => reading?.configuration &&
        [variant.configuration.model, ...variant.model_aliases].some(alias => identityToken(alias) === identityToken(reading.configuration!.model))))
      ? 'configuration_mismatch' : null;
    const { source, scope } = admitted[0];
    const allowed = (url: string) => {
      const current = approvedScope(source, url);
      return current?.id === scope.id && current.revision === scope.revision;
    };
    const representationKey = JSON.stringify([source.url, scope.id, scope.revision]);
    let page = fetchedPages.get(representationKey);
    if (!page || page.expires <= now()) {
      const response = await fetchPublicText(fetcher, source.url, {
        beforeRequest(next, stage) {
          if (!domainAllowed(next) || stage !== 'robots' && !allowed(next)) throw new Error('source_denied');
          // Charge every hop (robots, redirects, the page itself) to both the
          // daemon's eligibility budget and the caller's per-task request budget.
          deps?.beforeRequest?.(next);
          beforeRequest?.(next);
        },
      }).catch(() => null);
      if (!response?.ok || !allowed(response.finalUrl)) return 'source_inaccessible';
      const text = productText(response.text, response.finalUrl);
      if (!text) return 'source_inaccessible';
      page = { text, at: new Date(now()).toISOString(), expires: now() + 60_000 };
      fetchedPages.set(representationKey, page);
    }
    return { url: scope.url, text: page.text, observedAt: page.at,
      approval: { id: scope.id, revision: scope.revision, variant: scope.variant }, approvedAt: scope.approved_at };
  } });
  const recheckInterval = (url: string | null, variant?: string) =>
    scopes().find(({ scope }) => scope.url === url && scope.variant?.id === variant)?.source.recheck_ms ??
    config.selection.official_recheck_ms;
  return { verify, publicOffer, recheckInterval, scopes };

}
