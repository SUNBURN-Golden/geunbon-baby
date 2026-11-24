import seeds from '../../config/accounts.json';
import { randomUUID } from 'node:crypto';
import { offerUrl } from '../../../shared/verified-offer';
import type { CollectorStore } from '../store';
import { parseRobots, robotsAllows } from '../../lib/external/robots';
import { sourceLimits, type OfferConfig } from './config';
import { sourceLane, isAccessPath, TransportError, type OfferTransport } from './transport';

export type FrontierJob = { url: string; source: string; category: string; lane: 'public' | 'threads' | 'instagram'; depth: number;
  due_at: number; cursor: number; content_digest: string | null; lease: string };

export function enqueueSource(store: CollectorStore, config: OfferConfig, input: {
  destination: string; parent: string; relation: string; locator: string; depth: number; source: string; category: string;
}) {
  const url = offerUrl(input.destination);
  if (!url || isAccessPath(url)) return;
  const { max_queue_urls, max_depth } = sourceLimits(config, input.source);
  store.db.prepare('INSERT OR IGNORE INTO offer_discovery_edges(parent,destination,relation,locator,observed_at) VALUES (?,?,?,?,?)')
    .run(input.parent, url, input.relation, input.locator, store.now());
  if (max_depth !== null && input.depth > max_depth) return;
  const active = max_queue_urls !== null && (store.db.prepare('SELECT count(*) n FROM offer_frontier WHERE source=? AND gone=0')
    .get(input.source) as { n: number }).n >= max_queue_urls;
  // Admission limits defer work durably with the same discovery provenance.
  store.db.prepare(`INSERT INTO offer_frontier(url,source,lane,category,depth,due_at,gone) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET depth=min(offer_frontier.depth,excluded.depth)`)
    .run(url, input.source, sourceLane(url), input.category, input.depth, store.now(), active ? 2 : 0);
}
export function enqueueConfigured(store: CollectorStore, config: OfferConfig, configuredSources: string[] = []) {
  const urls = [...config.seed_urls, ...configuredSources,
    ...seeds.seed_accounts.map(account => `https://www.instagram.com/${account.handle}`)];
  store.transaction(() => {
    for (const destination of urls) {
      const url = offerUrl(destination);
      if (!url) continue;
      enqueueSource(store, config, { destination: url, parent: '', relation: 'seed', locator: 'seed',
        depth: 0, source: new URL(url).hostname, category: '' });
    }
  });
}

export const offerCycle = (now: number) => String(Math.floor(now / 3_600_000));
export const nextOfferCycle = (now: number) => (Math.floor(now / 3_600_000) + 1) * 3_600_000;

export function reserveDetail(store: CollectorStore, cycle: string, source: string, limit: number | null) {
  return store.db.prepare(`INSERT INTO offer_work_counters(cycle,source,details) SELECT ?,?,1 WHERE ? IS NULL OR ?>0
    ON CONFLICT(cycle,source) DO UPDATE SET details=details+1 WHERE ? IS NULL OR details<?`)
    .run(cycle, source, limit, limit, limit, limit).changes === 1;
}

export function claimSource(store: CollectorStore, lane: 'web' | 'instagram', config: OfferConfig, cycle = offerCycle(store.now())) {
  return store.transaction(() => {
    const now = store.now(), token = randomUUID();
    const job = store.db.prepare(`WITH due AS (
        SELECT f.url FROM offer_frontier f WHERE f.lane ${lane === 'web' ? '<>' : '='} 'instagram' AND f.gone=0
          AND f.due_at<=? AND f.lease_until<=?
          AND coalesce((SELECT pages FROM offer_work_counters w WHERE w.cycle=? AND w.source=f.source),0) <
          coalesce(CASE WHEN EXISTS (SELECT 1 FROM json_each(?) s, json_each(s.value) field
            WHERE s.key=f.source AND field.key='max_pages')
            THEN (SELECT json_extract(s.value,'$.max_pages') FROM json_each(?) s WHERE s.key=f.source)
            ELSE ? END,9007199254740991)
        ORDER BY coalesce((SELECT max(last_claimed) FROM offer_frontier x WHERE x.source=f.source AND x.category=f.category),0),
          coalesce(f.last_claimed,0),f.due_at,f.url LIMIT 1
      )
      UPDATE offer_frontier SET lease=?,lease_until=?,last_claimed=? WHERE url IN (SELECT url FROM due) RETURNING *`)
      .get(now, now, cycle, JSON.stringify(config.source_limits), JSON.stringify(config.source_limits), config.limits.max_pages, token, now + 180_000, now) as FrontierJob | undefined;
    if (job) store.db.prepare(`INSERT INTO offer_work_counters(cycle,source,pages) VALUES (?,?,1)
      ON CONFLICT(cycle,source) DO UPDATE SET pages=pages+1`).run(cycle, job.source);
    return job;
  });
}
export function finishSource(store: CollectorStore, job: FrontierJob, input: { delay: number; cursor?: number; digest?: string; gone?: boolean }) {
  store.db.prepare(`UPDATE offer_frontier SET lease=NULL,lease_until=0,due_at=?,cursor=?,content_digest=?,gone=? WHERE url=? AND lease=?`)
    .run(store.now() + input.delay, input.cursor ?? 0, input.digest ?? job.content_digest, input.gone ? 1 : 0, job.url, job.lease);
}
export function activateDeferred(store: CollectorStore, config: OfferConfig) {
  store.transaction(() => {
    const rows = store.db.prepare('SELECT url,source FROM offer_frontier WHERE gone=2 ORDER BY due_at,url LIMIT 100').all() as Pick<FrontierJob, 'url' | 'source'>[];
    for (const row of rows) {
      const limit = sourceLimits(config, row.source).max_queue_urls;
      const active = (store.db.prepare('SELECT count(*) n FROM offer_frontier WHERE source=? AND gone=0').get(row.source) as { n: number }).n;
      if (limit === null || active < limit) store.db.prepare('UPDATE offer_frontier SET gone=0 WHERE url=?').run(row.url);
    }
  });
}

export function publicReader(store: CollectorStore, config: OfferConfig, transport: OfferTransport) {
  const robots = new Map<string, ReturnType<typeof parseRobots>>();
  return async ({ url, lane }: Pick<FrontierJob, 'url' | 'lane'>, signal?: AbortSignal, allow: (url: string) => boolean = () => true) => {
    if (lane === 'instagram') throw new TransportError('wrong_reader');
    const visited = new Set<string>();
    for (let hop = 0; hop < 8; hop++) {
      const safe = offerUrl(url);
      if (!safe || !allow(safe) || isAccessPath(safe) || visited.has(safe)) throw new TransportError('unsafe_redirect');
      visited.add(safe);
      const reader = sourceLane(safe);
      if (reader !== lane) return { dispatch: safe } as const;
      const target = new URL(safe);
      const press = config.press[target.hostname];
      if (press) {
        const key = `press:${target.hostname}`;
        const last = store.db.prepare('SELECT value FROM offer_runtime WHERE key=?').get(key) as { value: string } | undefined;
        if (last && Number(last.value) + press.interval_ms > store.now()) throw new TransportError('press_interval', Number(last.value) + press.interval_ms);
        if (!robots.has(target.origin)) {
          const response = await transport(new URL('/robots.txt', target).href, { lane: reader, signal });
          if (response.status !== 200 && response.status !== 404) throw new TransportError('robots_unavailable');
          robots.set(target.origin, parseRobots(response.status === 404 ? '' : response.body));
        }
        if (!robotsAllows(robots.get(target.origin)!, target.pathname + target.search)) throw new TransportError('robots_denied');
        store.db.prepare('INSERT INTO offer_runtime(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(store.now()));
      }
      const response = await transport(safe, { lane: reader, signal });
      if (response.status < 300 || response.status >= 400) return { response } as const;
      if (!response.headers.location) throw new TransportError('unsafe_redirect');
      url = new URL(response.headers.location, safe).href;
    }
    throw new TransportError('redirect_limit');
  };
}
