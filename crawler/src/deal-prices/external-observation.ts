import { digest, httpsSource, parsePriceEvidence, PRICE_VERIFIER, type PriceEvidence } from '../../../shared/deal-price-evidence';

export type ExternalPriceTarget = {
  id: string; source_url: string; revision: string; capture_hash: string | null;
  official_hash: string | null; authority: string | null; price_checked_at: string | null; prior: string | null;
};
export type PriceSubmission = { kind: 'external_price_observation'; deal_id: string; source_url: string;
  expected_revision: string; request_id: string; price_evidence: PriceEvidence };
export async function priceSubmission(target: ExternalPriceTarget, evidence: PriceEvidence): Promise<PriceSubmission> {
  const request_id = await digest(JSON.stringify([PRICE_VERIFIER, target.id, target.revision, evidence]));
  return { kind: 'external_price_observation', deal_id: target.id, source_url: target.source_url,
    expected_revision: target.revision, request_id, price_evidence: evidence };
}

export async function priorPriceEvidence(target: ExternalPriceTarget) {
  return target.prior ? parsePriceEvidence(JSON.parse(target.prior)) : null;
}

export function externalObservations(endpoint: string | undefined, token: string | undefined, fetchImpl = fetch) {
  if (!endpoint || !token) return null;
  let origin: URL;
  try { origin = new URL(endpoint); } catch { return null; }
  const api = new URL('/api/v1/ingest', origin);
  if (origin.username || origin.password || api.protocol !== 'https:' &&
      !(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname))) return null;
  const options: RequestInit = { headers: { authorization: `Bearer ${token}` }, redirect: 'error' };
  return { api, token,
    async next(cursor: string, relatedTo?: string): Promise<ExternalPriceTarget | null> {
      const url = new URL(api);
      url.searchParams.set('kind', 'external_price_observation');
      url.searchParams.set('cursor', cursor);
      if (relatedTo) url.searchParams.set('related_to', relatedTo);
      const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) });
      if (!response.ok || response.redirected) throw new Error('price_watch_unavailable');
      const { data } = await response.json() as { data: ExternalPriceTarget | null };
      if (data === null) return null;
      if (!data || typeof data.id !== 'string' || !data.id || data.id.length > 200 || !httpsSource(data.source_url) ||
          typeof data.revision !== 'string' || !/^\d+$/.test(data.revision) ||
          data.capture_hash !== null && !/^[a-f0-9]{64}$/.test(data.capture_hash)) throw new Error('price_watch_unavailable');
      return data;
    },
    async submit(submission: PriceSubmission) {
      const response = await fetchImpl(api, {
        ...options, method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify(submission),
      });
      if (response.status === 404 || response.status === 409) {
        const { error } = await response.json() as { error: string };
        if (['superseded', 'target_not_found', 'official_source_not_approved'].includes(error)) return { outcome: error };
      }
      if (response.redirected || response.status !== 202) throw new Error('price_observation_unavailable');
      const { data } = await response.json() as { data: { outcome: string; observation_id?: string; revision?: string } };
      if (!data || typeof data.outcome !== 'string') throw new Error('price_observation_unavailable');
      return data;
    },
  };
}
