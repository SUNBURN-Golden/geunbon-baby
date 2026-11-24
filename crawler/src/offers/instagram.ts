import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HaltError, launchBrowser } from '../../lib/browser';
import { loadConfig } from '../../lib/config';
import type { CollectorStore } from '../store';
import { mediateBrowser, isolatedBrowser, isolatedContext } from './browser';
import type { OfferConfig } from './config';
import { enqueueSource } from './frontier';
import { assertOfficialAccount, checkSocial, discoverSocial } from './social';
import { instagramStopped, lockHost, stopInstagram, type OfferTransport } from './transport';

const crawlerDir = fileURLToPath(new URL('../../', import.meta.url));

export function instagramReader(store: CollectorStore, dir: string, config: OfferConfig, transport: OfferTransport) {
  let ready: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  let release: Awaited<ReturnType<typeof lockHost>> | null = null;
  let retryAt = 0;
  const stop = async () => {
    const session = ready;
    ready = null;
    if (session) await session.browser.close().catch(() => {});
    await release?.();
    release = null;
  };
  const tick = async (signal: AbortSignal) => {
    if (signal.aborted || instagramStopped(store)) { await stop(); return false; }
    if (store.now() < retryAt) return false;
    const now = store.now();
    if (!store.db.prepare(`SELECT 1 FROM offer_social_checks WHERE completed_at IS NULL
      UNION ALL SELECT 1 FROM offer_frontier WHERE lane='instagram' AND gone=0 AND due_at<=? AND lease_until<=? LIMIT 1`).get(now, now)) {
      await stop();
      return false;
    }
    try {
      const { settings } = await loadConfig(crawlerDir);
      if (!ready) {
        release = await lockHost(join(dir, 'host-locks'), 'instagram-session-owner', AbortSignal.any([signal, AbortSignal.timeout(1000)]));
        const guard = () => { if (signal.aborted || instagramStopped(store)) throw new HaltError('blocked'); };
        ready = await launchBrowser(crawlerDir, guard, {
          launch: isolatedBrowser, context: isolatedContext,
          install: context => mediateBrowser(context, { store, dir, transport, lane: 'instagram', readOnly: true, signal,
            onRedirect: (parent, destination) => {
              store.transaction(() => enqueueSource(store, config, { parent, destination, source: 'instagram', category: '',
                relation: 'redirect', locator: 'location', depth: 1 }));
            },
          }),
        });
        await ready.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
        await assertOfficialAccount(ready.page);
      }
      const result = await checkSocial(store, ready.page, settings, crawlerDir) || await discoverSocial(store, config, ready.page);
      // The scheduled v2 owner can take the session between discrete reads.
      await stop();
      return result;
    } catch (error) {
      if (error instanceof HaltError && error.reason === 'challenge') stopInstagram(store, dir, 'identity');
      await stop();
      retryAt = store.now() + (error instanceof HaltError && error.reason === 'login' ? 60_000 : 1000);
      return false;
    }
  };
  return { tick, stop };
}
