import { join } from 'node:path';
import { digest, type OfficialPriceScope } from '../../../shared/deal-price-evidence';
import { atomicState, readState } from '../deepseek-web/atomic-state';

type Receipt = { site: string; revision: string; digest: string; scopes: number };
const receiptPath = (dir: string) => join(dir, 'official-price-source-receipt.json');

export async function scopeSnapshot(scopes: OfficialPriceScope[], site: string, now = Date.now()) {
  const observed_at = new Date(now).toISOString();
  const body = { observed_at, scopes };
  const receipt = { site, revision: observed_at, digest: await digest(JSON.stringify(scopes)), scopes: scopes.length };
  return { body, receipt };
}

export async function syncPriceSources(dir: string, endpoint: URL, token: string, scopes: OfficialPriceScope[], write: boolean) {
  const url = new URL('/api/v1/admin/price-sources', endpoint);
  if (!token || endpoint.username || endpoint.password || url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('price_sources_endpoint');
  const { body: snapshot, receipt: expected } = await scopeSnapshot(scopes, url.origin);
  if (!scopes.length || scopes.some(scope => scope.expires_at <= snapshot.observed_at)) throw new Error('price_sources_not_ready');
  const previous = write ? null : JSON.parse(readState(receiptPath(dir))) as Receipt;
  if (!write && (!previous || !scopes.length || scopes.some(scope => scope.expires_at <= snapshot.observed_at))) {
    throw new Error('price_sources_not_ready');
  }
  const options = { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000), redirect: 'error' as const };
  const response = await fetch(url, write ? { ...options, method: 'POST', body: JSON.stringify(snapshot) } : options);
  if (!response.ok || response.redirected) throw new Error('price_sources_sync_failed');
  const { data } = await response.json() as { data: Receipt };
  if (data?.site !== expected.site || data.digest !== expected.digest || data.scopes !== expected.scopes ||
      data.revision !== (write ? snapshot.observed_at : previous?.revision)) throw new Error('price_sources_receipt_mismatch');
  if (write) atomicState(receiptPath(dir), data);
  return data;
}
