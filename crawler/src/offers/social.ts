import type { Page } from 'playwright';
import { filterText } from '../../../shared/privacy-rules';
import { offerUrl } from '../../../shared/verified-offer';
import { isImageUrl } from '../../../lib/image-url';
import { assertHuman, HaltError } from '../../lib/browser';
import { ocrStory, pauseReadyStory, readCaption, verifiedPost, postAuthor, type SocialItem } from '../../lib/collect';
import type { Settings } from '../../lib/config';
import { selectMedia } from '../../lib/media';
import { profileLink } from '../../lib/selectors';
import { canonicalPost } from '../../lib/util';
import type { CollectorStore } from '../store';
import { claimSource, enqueueSource, finishSource } from './frontier';
import { hash, relevant, type CatalogSnapshot } from './evidence';
import type { OfferConfig } from './config';
import { loadGeunbonCatalog } from '../deepseek-web/catalog';
import { offerEvent } from './metrics';
import { instagramStopped } from './transport';

function socialEvidence(text: string) {
  return text.split(/[\r\n]+/).map(line => filterText(line, 6000)).filter(line => !!line && !line.includes('[redacted]')).join('\n').slice(0, 6000);
}
export async function assertOfficialAccount(page: Page) {
  await assertHuman(page);
  if (await profileLink(page) !== 'agamajung') throw new HaltError('challenge');
}
export function recordSocial(store: CollectorStore, item: SocialItem) {
  const url = offerUrl(item.source_url);
  const seller = item.account.toLowerCase();
  const evidence = socialEvidence(item.text);
  if (!url || new URL(url).hostname !== 'www.instagram.com' || !/^[a-z0-9._]{1,30}$/.test(seller) || !evidence) throw new Error('invalid_social_handoff');
  const path = new URL(url).pathname;
  if (item.kind === 'story' ? !path.startsWith(`/stories/${seller}/`) || !/^\/stories\/[a-z0-9._]+\/\d+$/.test(path)
    : !canonicalPost(url)) throw new Error('invalid_social_handoff');
  const at = Date.parse(item.captured_at);
  if (!Number.isFinite(at)) throw new Error('invalid_social_handoff');
  const image = isImageUrl(item.image_url) ? item.image_url : null;
  const digest = hash([url, seller, evidence]);
  const id = hash([url, seller, item.kind, digest]);
  store.transaction(() => {
    store.db.prepare('INSERT OR IGNORE INTO offer_social_observations(id,url,kind,seller,evidence,image_url,observed_at,digest) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, url, item.kind, seller, evidence, image, at, digest);
  });
  return id;
}
function recordScan(store: CollectorStore, url: string, at: number) {
  offerEvent(store, hash(['ig-scan', url, at]), 'scan', {}, at);
}
export async function checkSocial(store: CollectorStore, page: Page, settings: Settings, crawlerDir: string) {
  const row = store.db.prepare(`SELECT c.id,o.url,o.seller,o.kind FROM offer_social_checks c
    JOIN offer_social_observations o ON o.id=c.observation_id WHERE c.completed_at IS NULL ORDER BY c.requested_at,c.id LIMIT 1`).get() as
    { id: string; url: string; seller: string; kind: 'post' | 'story' } | undefined;
  if (!row || instagramStopped(store)) return false;
  await assertOfficialAccount(page);
  let evidence = '';
  await page.goto(row.url, { waitUntil: 'domcontentloaded' });
  await assertHuman(page);
  if (row.kind === 'post') {
    const canonical = canonicalPost(row.url);
    if (canonical && await verifiedPost(page, canonical, row.seller)) {
      evidence = socialEvidence(await readCaption(page));
      if (!await verifiedPost(page, canonical, row.seller)) evidence = '';
    }
  } else if (offerUrl(page.url()) === row.url) {
    const ready = await pauseReadyStory(page, row.seller, null).catch(() => false);
    if (ready && offerUrl(page.url()) === row.url) {
      const media = await selectMedia(page, 'story');
      if (media) evidence = socialEvidence((await ocrStory(page, media.element, crawlerDir, settings, false)).text);
      if (offerUrl(page.url()) !== row.url) evidence = '';
    }
  }
  await assertHuman(page);
  if (instagramStopped(store)) throw new HaltError('blocked');
  const now = store.now();
  store.transaction(() => {
    const digest = evidence ? hash([row.url, row.seller, evidence]) : null;
    const status = evidence ? 'live' : 'unavailable';
    store.db.prepare('UPDATE offer_social_checks SET completed_at=?,status=?,identity=?,digest=? WHERE id=? AND completed_at IS NULL')
      .run(now, status, evidence ? row.seller : null, digest, row.id);
    if (evidence) recordScan(store, row.url, now);
  });
  if (evidence) recordSocial(store, { account: row.seller, kind: row.kind, source_url: row.url, text: evidence, captured_at: new Date(now).toISOString() });
  return true;
}

export async function discoverSocial(store: CollectorStore, config: OfferConfig, page: Page) {
  if (instagramStopped(store)) return false;
  const job = claimSource(store, 'instagram', config);
  if (!job) return false;
  try {
    await assertOfficialAccount(page);
    const target = new URL(job.url);
    if (!['www.instagram.com', 'instagram.com'].includes(target.hostname)) { finishSource(store, job, { delay: 0, gone: true }); return true; }
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await assertHuman(page);
    const actual = offerUrl(page.url());
    if (!actual || new URL(actual).pathname !== target.pathname) { finishSource(store, job, { delay: 60_000 }); return true; }
    const canonical = canonicalPost(actual);
    if (canonical) {
      const seller = await postAuthor(page);
      if (seller && await verifiedPost(page, canonical, seller)) {
        const evidence = await readCaption(page);
        if (socialEvidence(evidence) && await verifiedPost(page, canonical, seller)) recordSocial(store, {
          source_url: canonical, account: seller, kind: 'post', text: evidence, captured_at: new Date(store.now()).toISOString(),
        });
      }
    }
    const links = await page.locator('main a[href], article a[href]').evaluateAll(elements => elements.flatMap((link, index) => {
      const href = link.getAttribute('href');
      if (!href) return [];
      // Instagram wraps profile destinations in its public outbound link.
      let target = new URL(href, location.href);
      if (target.hostname === 'l.instagram.com' && target.pathname === '/') {
        const destination = target.searchParams.get('u');
        if (!destination) return [];
        try { target = new URL(destination); } catch { return []; }
      }
      return [{ destination: target.href, locator: `anchor:${index + 1}`, label: link.textContent?.slice(0, 200) ?? '' }];
    }));
    const catalog = store.db.prepare('SELECT body FROM offer_catalog_snapshot WHERE singleton=1').get() as { body: string } | undefined;
    const snapshot = catalog ? JSON.parse(catalog.body) as CatalogSnapshot : null;
    const discovery = loadGeunbonCatalog();
    const profile = /^\/[a-z0-9._]+$/i.test(target.pathname);
    store.transaction(() => {
      recordScan(store, job.url, store.now());
      for (const link of links) {
        const url = offerUrl(link.destination);
        if (!url || url === actual) continue;
        const to = new URL(url);
        const social = /(?:^|\.)instagram\.com$/.test(to.hostname);
        const recognized = canonicalPost(url) || /^\/(?:explore\/tags\/[^/]+|[a-z0-9._]+)$/i.test(to.pathname);
        if (social ? !recognized : !profile && !relevant(link.label, snapshot, discovery)) continue;
        enqueueSource(store, config, { ...link, parent: actual, relation: profile && !social ? 'profile_link' : canonicalPost(url) ? 'post' : 'mention',
          depth: job.depth + 1, source: job.source, category: job.category });
      }
      finishSource(store, job, { delay: 60_000 });
    });
  } catch (error) {
    finishSource(store, job, { delay: 60_000 });
    if (error instanceof HaltError) throw error;
  }
  return true;
}
