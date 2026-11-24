import { expect, test } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { scopeSnapshot, syncPriceSources } from '../crawler/src/deal-prices/source-sync';
import { models } from '../seed/models.json';
import { checkedAt } from './helpers/verified-deal-prices';
import { verifiedFixture } from './helpers/verified-offer';

test('enabled Stokke variants bind separately to existing site model IDs and exact URLs', () => {
  const config = loadDeepSeekWebConfig();
  const variants = config.official_sources.filter(source => source.enabled).flatMap(source =>
    source.price_variants?.map(variant => ({ source, variant })) ?? []);
  expect(variants.map(({ variant }) => variant.site_model_id)).toEqual(['model-1','model-2']);
  for (const { source, variant } of variants) {
    const seed = models[Number(variant.site_model_id?.slice(6)) - 1];
    expect(variant.configuration.model).toBe(seed.model);
    expect(source.url).toBe(seed.source_url);
    expect(source.fields).toContain('official_msrp');
  }
});

test('empty scope sync fails before a POST and snapshot receipt binds site, revision, digest and count', async () => {
  const endpoint = new URL('https://fixture.example.com/');
  await expect(syncPriceSources('/unread-fixture-state', endpoint, 'fixture-token', [], true)).rejects.toThrow('price_sources_not_ready');
  const { scope } = await verifiedFixture();
  const now = Date.parse(checkedAt);
  const snapshot = await scopeSnapshot([scope], endpoint.origin, now);
  expect(snapshot.receipt).toMatchObject({ site: endpoint.origin, revision: checkedAt, scopes: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect((await scopeSnapshot([],endpoint.origin,now)).receipt.digest).not.toBe(snapshot.receipt.digest);
});
