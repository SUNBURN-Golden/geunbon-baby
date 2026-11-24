import { readFile } from 'node:fs/promises';
import {
  CLOSE_OFFER, INVALIDATE_OFFER, OFFER_FRESHNESS_MS, OFFER_KIND, offerCandidateId, offerDigestFields, offerHash, offerKeyFields, PROMOTE_OFFER,
  type FailedOffer, type OfferAck, type OfferClaim, type OfferPayload, type OfferReceipt, type VerifiedOffer,
} from '../../../shared/verified-offer';
import type { CollectorStore } from '../store';
import { hash } from './evidence';
import { offerEvent } from './metrics';
import type { OfferTransport } from './transport';

const INGEST_TOKEN = '/home/box/.secrets/agamajung_ingest_token';
const ADMIN_TOKEN = '/home/box/.secrets/agamajung_admin_token';
export function siteOrigin(value = process.env.AGAMAJUNG_API_URL ?? process.env.COLLECTOR_SITE_URL) {
  if (!value) throw new Error('offer_site_origin_missing');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) throw new Error('offer_site_origin_invalid');
  return url.origin;
}

type SiteResponse = { status: number; data: unknown };
export type SiteClient = (path: string, method: 'POST' | 'GET', input: unknown, signal?: AbortSignal) => Promise<SiteResponse>;
export function publicationClient(origin: string, transport: OfferTransport, readToken = async (path: string) => (await readFile(path, 'utf8')).trim()): SiteClient {
  const base = siteOrigin(origin);
  return async (path, method, data, signal) => {
    const url = new URL(path, base);
    const ingest = method === 'POST' && url.pathname === '/api/v1/ingest' && !url.search;
    const admin = url.pathname === '/api/v1/admin/price-sources' && !url.search || /^\/api\/v1\/admin\/candidates\/verified-[a-f0-9]{64}(?:\/receipt)?$/.test(url.pathname)
      && (method === 'GET' ? url.pathname.endsWith('/receipt') : !url.search && !url.pathname.endsWith('/receipt'));
    if (url.origin !== base || url.hash || !(ingest || admin)) throw new Error('offer_endpoint_invalid');
    const token = await readToken(ingest ? INGEST_TOKEN : ADMIN_TOKEN);
    if (token.length < 24 || /\s/.test(token)) throw new Error('offer_token_invalid');
    const result = await transport(url.href, { lane: 'service', method, signal, timeout: 20_000, maxBytes: 48_000,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(data) : undefined });
    if (result.status >= 300 && result.status < 400) return { status: result.status, data: undefined };
    let response: { data?: unknown };
    try { response = JSON.parse(result.body); } catch { response = {}; }
    return { status: result.status, data: response?.data };
  };
}

export async function offerKeys(facts: VerifiedOffer['facts'], locator: string) {
  const keys = offerKeyFields(facts.seller_url, facts.model_id, facts.configuration, facts.source_url, locator, facts.starts_at);
  return { campaign_key: await offerHash(keys.campaign), offer_key: await offerHash(keys.offer), provisional: await offerHash(keys.provisional) };
}

type Identity = { id: string; revision: number; published_version: number; deal_id: string | null; published_at: string | null };
type Row = { request_id: string; offer_id: string; revision: number; body: string; claim: string; candidate_id: string | null; sent: number; due_at: number; state: string; receipt: string | null };
type DraftFields = 'kind' | 'digest' | 'offer_id' | 'revision' | 'expected_version';
type Draft = Omit<VerifiedOffer, DraftFields> | Omit<FailedOffer, DraftFields>;
export function identityFor(store: CollectorStore, keys: Pick<OfferPayload, 'offer_key' | 'campaign_key'>, provisional?: string) {
  const identities = store.db.prepare(`SELECT DISTINCT i.* FROM offer_alias a JOIN offer_identity i ON i.id=a.offer_id
    WHERE a.key IN (?, ?)
    OR a.key=? AND NOT EXISTS (SELECT 1 FROM offer_outbox o WHERE o.offer_id=i.id AND json_extract(o.body,'$.facts.starts_at') IS NOT NULL AND o.state<>'cancelled')`)
    .all(keys.offer_key, keys.campaign_key, provisional ?? null) as Identity[];
  if (identities.length > 1) return 'collision';
  return identities[0] ?? null;
}

export async function newOffer(store: CollectorStore, draft: Draft, preferredId?: string | null, provisional?: string): Promise<OfferPayload | 'collision' | null> {
  const match = identityFor(store, draft, provisional);
  if (match === 'collision' || preferredId && match && preferredId !== match.id) return 'collision';
  const existing = match ?? (preferredId ? store.db.prepare('SELECT * FROM offer_identity WHERE id=?').get(preferredId) as Identity | undefined : undefined);
  if ('closure' in draft && !existing?.deal_id) return null;
  const pending = existing && store.db.prepare("SELECT 1 FROM offer_outbox WHERE offer_id=? AND state='pending' AND sent=1").get(existing.id);
  if (pending) return null;
  const offer = { ...draft, kind: OFFER_KIND,
    offer_id: existing?.id ?? preferredId ?? hash(['offer', draft.offer_key]), revision: (existing?.revision ?? 0) + 1,
    expected_version: existing?.published_version ?? 0 } satisfies Omit<OfferPayload, 'digest'>;
  return { ...offer, digest: await offerHash(offerDigestFields(offer)) };
}
export async function stageOffer(store: CollectorStore, offer: OfferPayload) {
  const action = 'failure' in offer ? INVALIDATE_OFFER : offer.closure ? CLOSE_OFFER : PROMOTE_OFFER;
  const claim: OfferClaim = { action, request_id: await offerHash([action, offer.offer_id, offer.revision, offer.digest]),
    offer_key: offer.offer_key, revision: offer.revision, digest: offer.digest, expected_version: offer.expected_version };
  return () => {
    store.db.prepare('INSERT OR IGNORE INTO offer_identity(id) VALUES (?)').run(offer.offer_id);
    const result = store.db.prepare('UPDATE offer_identity SET revision=? WHERE id=? AND revision=? AND published_version=?')
      .run(offer.revision, offer.offer_id, offer.revision - 1, offer.expected_version);
    if (result.changes !== 1) throw new Error('offer_revision_conflict');
    store.db.prepare("UPDATE offer_outbox SET state='cancelled' WHERE offer_id=? AND state='pending' AND sent=0")
      .run(offer.offer_id);
    if (!('failure' in offer)) {
      for (const key of [offer.campaign_key, offer.offer_key])
        store.db.prepare('INSERT OR IGNORE INTO offer_alias(key,offer_id) VALUES (?,?)').run(key, offer.offer_id);
      if (identityFor(store, offer) === 'collision') throw new Error('offer_identity_conflict');
    }
    store.db.prepare(`INSERT INTO offer_outbox(request_id,offer_id,revision,body,claim,due_at,state)
      VALUES (?,?,?,?,?,?,'pending')`).run(claim.request_id, offer.offer_id, offer.revision, JSON.stringify(offer), JSON.stringify(claim), store.now());
  };
}

const exactAck = (value: unknown, offer: OfferPayload): value is OfferAck => {
  const a = value as Partial<OfferAck> | null;
  return !!a && a.kind === OFFER_KIND && a.id === offerCandidateId(offer.offer_id) && a.offer_key === offer.offer_key
    && a.digest === offer.digest && a.revision === offer.revision && ('failure' in offer ? a.state === 'review' : a.state === 'eligible' || a.state === 'published');
};
function exactReceipt(value: unknown, claim: OfferClaim, candidate: string, version: number): value is OfferReceipt {
  const r = value as Partial<OfferReceipt> | null;
  if (!r || r.kind !== OFFER_KIND || r.candidate_id !== candidate || r.promotion_id !== claim.request_id
    || !Object.entries(claim).every(([key, val]) => r[key as keyof OfferClaim] === val)
    || typeof r.committed_at !== 'string' || !Number.isFinite(Date.parse(r.committed_at))) return false;
  return claim.action !== INVALIDATE_OFFER || version > 0
    ? r.deal_id === `deal-${candidate}` && r.committed_revision === version + 1 && r.created === (claim.action === PROMOTE_OFFER && version === 0)
    : r.deal_id === null && r.committed_revision === null && r.created === false;
}

export async function deliverOffer(store: CollectorStore, client: SiteClient, signal?: AbortSignal) {
  const row = store.db.prepare("SELECT * FROM offer_outbox WHERE state='pending' AND due_at<=? ORDER BY due_at,request_id LIMIT 1")
    .get(store.now()) as Row | undefined;
  if (!row || signal?.aborted) return false;
  const offer = JSON.parse(row.body) as OfferPayload;
  const claim = JSON.parse(row.claim) as OfferClaim;
  let candidate = row.candidate_id;
  const fresh = () => {
    const now = store.now(), checked = Date.parse(offer.checked_at);
    return 'failure' in offer || checked <= now && now - checked <= OFFER_FRESHNESS_MS
      && (!!offer.closure || Date.parse(offer.facts.ends_at) >= now);
  };
  const settle = (result: SiteResponse) => {
    if (result.status !== 200 || !candidate || !exactReceipt(result.data, claim, candidate, offer.expected_version)) return false;
    const receipt = result.data;
    store.transaction(() => {
      store.db.prepare("UPDATE offer_outbox SET state='acked',receipt=? WHERE request_id=?").run(JSON.stringify(receipt), row.request_id);
      if (receipt.deal_id && receipt.committed_revision !== null) {
        store.db.prepare('UPDATE offer_identity SET deal_id=?,published_version=?,published_at=coalesce(published_at,?) WHERE id=? AND published_version < ?')
          .run(receipt.deal_id, receipt.committed_revision, receipt.committed_at, row.offer_id, receipt.committed_revision);
        if (receipt.created) offerEvent(store, `published:${receipt.deal_id}`, 'publication', { committed_at: receipt.committed_at });
      }
    });
    return true;
  };
  const scheduleRetry = () => store.db.prepare('UPDATE offer_outbox SET due_at=? WHERE request_id=?').run(store.now() + 60_000, row.request_id);
  const invalidate = () => store.transaction(() => {
    store.db.prepare("UPDATE offer_outbox SET state='cancelled' WHERE request_id=?").run(row.request_id);
    const url = 'failure' in offer ? offer.failure.source_url : offer.facts.source_url;
    store.db.prepare('UPDATE offer_frontier SET due_at=?,cursor=0 WHERE url=? AND gone=0').run(store.now(), url);
  });
  try {
    if (row.sent && candidate) {
      const query = new URLSearchParams(Object.entries(claim).map(([key, value]) => [key, String(value)]));
      const recovered = await client(`/api/v1/admin/candidates/${candidate}/receipt?${query}`, 'GET', undefined, signal);
      if (settle(recovered)) return true;
      if (recovered.status !== 404) { scheduleRetry(); return true; }
      if (!fresh()) { invalidate(); return true; }
    }
    if (!fresh()) { invalidate(); return true; }
    if (!candidate) {
      const ingested = await client('/api/v1/ingest', 'POST', offer, signal);
      if (ingested.status !== 202 || !exactAck(ingested.data, offer)) {
        if (ingested.status === 409 && !('failure' in offer)) invalidate();
        else if (ingested.status === 409) store.db.prepare("UPDATE offer_outbox SET state='cancelled' WHERE request_id=?").run(row.request_id);
        else scheduleRetry();
        return true;
      }
      candidate = ingested.data.id;
      store.db.prepare('UPDATE offer_outbox SET candidate_id=? WHERE request_id=?').run(candidate, row.request_id);
    }
    if (!fresh()) { invalidate(); return true; }
    store.db.prepare('UPDATE offer_outbox SET sent=1 WHERE request_id=?').run(row.request_id);
    const promoted = await client(`/api/v1/admin/candidates/${candidate}`, 'POST', claim, signal);
    if (!settle(promoted)) {
      if (promoted.status === 409) invalidate();
      else scheduleRetry();
    }
  } catch { scheduleRetry(); }
  return true;
}
