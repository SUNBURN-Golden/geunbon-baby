import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { instagramPriceEvidence } from '../crawler/src/deal-prices/instagram';
import { registerThreadsPost, runThreadsRevisit } from '../crawler/src/deal-prices/threads-schedule';
import { threadsRegistry } from '../crawler/src/deal-prices/threads';
import { unavailablePriceEvidence, type PriceVerifier } from '../crawler/src/deal-prices/verify';
import { initializeSourceRegistry } from '../crawler/src/source-registry/store';
import { loadRegistrySeed } from '../crawler/src/source-registry/seed';
import { fixture } from './helpers/collector';
import { exampleEvidence } from './helpers/verified-deal-prices';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test('Threads official-page requests consume the per-visit request budget', async () => {
  const linux = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'threads-budget-'));
  const permalink = 'https://www.threads.net/@fixture/post/item-id';
  try {
    const source = loadRegistrySeed().find(entry => entry.origin === new URL(permalink).origin)!;
    initializeSourceRegistry(linux.store, [source]);
    const { source_id, revision } = source;
    const registry = threadsRegistry(linux.store);
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
    let postFetches = 0;
    const fetchImpl: typeof fetch = async () => {
      postFetches++;
      return new Response('<article data-post-id="item-id" data-author="@fixture"><div data-post-body><p>공구가: 390,000원</p></div></article>',
        { headers: { 'content-type': 'text/html' } });
    };
    // The verifier tries to spend more official-page requests than the visit
    // allowance. It must be stopped by the same counter as the post fetch.
    let officialAttempts = 0, stoppedAt = 0;
    const verify: PriceVerifier = async (url, _text, _at, _prior, beforeRequest) => {
      for (let i = 1; i <= 20; i++) {
        officialAttempts++;
        try { beforeRequest?.(`https://official.example/p/${i}`); }
        catch (error) { stoppedAt = i; throw error; }
      }
      return unavailablePriceEvidence(url, 'source_inaccessible');
    };
    await runThreadsRevisit(dir, linux.store, { api: new URL('https://ingest.invalid/api/v1/ingest'), token: 'fixture-token',
      verify, now: () => linux.now(), fetchImpl });
    expect(postFetches).toBe(1);
    // One request was the post itself; the remaining seven are the allowance.
    expect(stoppedAt).toBe(8);
    expect(officialAttempts).toBe(8);
    const state = (await readdir(join(dir, 'threads-posts'))).find(file => /^[0-9a-f]{64}\.json$/.test(file))!;
    expect(JSON.parse(await readFile(join(dir, 'threads-posts', state), 'utf8'))).toMatchObject({ outcome: 'collection_retryable' });
  } finally {
    linux.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Instagram verification stops before provider calls and official fetches when its budget is exhausted', async () => {
  vi.stubEnv('DEAL_PRICE_VERIFICATION', '1');
  const url = 'https://www.instagram.com/p/budget/';
  const evidence = await exampleEvidence(url);
  const calls = { provider: 0, fetch: 0 };
  const result = await instagramPriceEvidence(url, evidence.offer!.source.text, evidence.offer!.source.observed_at, {
    provider: () => { calls.provider++; return false; },
    fetch: () => { calls.fetch++; return false; },
  });
  expect(calls).toEqual({ provider: 2, fetch: 0 });
  expect(result?.failed).toBe('provider_retryable');
  expect(result?.offer).toMatchObject({ readings: [null, null] });
});
