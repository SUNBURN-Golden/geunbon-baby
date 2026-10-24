import { CollectorError, CollectorStore, requireThat } from './store';
import type { Snapshot } from '../../shared/collection-schema';

export function parseStatusAck(value: unknown, snapshot: Snapshot): { worker_id: string; version: number } {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'sync_receipt', 502);
  const data = (value as Record<string, unknown>).data;
  requireThat(data && typeof data === 'object' && !Array.isArray(data), 'sync_receipt', 502);
  const { worker_id, version } = data as Record<string, unknown>;
  requireThat(typeof worker_id === 'string' && worker_id === snapshot.worker_id, 'sync_worker_mismatch', 502);
  requireThat(Number.isSafeInteger(version) && (version as number) >= snapshot.version, 'sync_version_regressed', 502);
  return { worker_id: worker_id as string, version: version as number };
}

async function readAck(response: Response): Promise<unknown> {
  requireThat(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json', 'sync_content_type', 502);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!response.body) throw new CollectorError('sync_body', 502);
    reader = response.body.getReader();
  } catch { throw new CollectorError('sync_body', 502); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { throw new CollectorError('sync_body', 502); }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) {
        try { await reader.cancel(); } catch { /* Discard transport diagnostics. */ }
        throw new CollectorError('sync_oversized', 502);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new CollectorError('sync_receipt', 502); }
}

export async function syncStatus(store: CollectorStore, endpoint: string, token: string, send: typeof fetch = fetch) {
  const url = new URL('/api/v1/collector/status', endpoint);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && token.length >= 24, 'sync_config');
  const snapshots = store.list<Snapshot>('sync_outbox').sort((a, b) => a.version - b.version);
  const result: { sent: number; site_version_ahead?: true; site_version?: number } = { sent: snapshots.length };
  for (const snapshot of snapshots) {
    let response: Response;
    try {
      response = await send(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshot), redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch { throw new CollectorError('sync_transport', 502); }
    requireThat(!response.redirected && response.type !== 'opaqueredirect' && (response.status < 300 || response.status >= 400), 'sync_redirect', 502);
    requireThat(response.status === 200, 'sync_failed', 502);
    const ack = parseStatusAck(await readAck(response), snapshot);
    store.transaction(() => store.db.prepare('DELETE FROM sync_outbox WHERE id=?').run(String(snapshot.version)));
    // A restored local counter can lag the site's monotonic version. Delivery still succeeded.
    if (ack.version > (store.get<number>('collector_meta', 'version') ?? 0)) {
      result.site_version_ahead = true;
      result.site_version = Math.max(result.site_version ?? 0, ack.version);
    }
  }
  return result;
}
