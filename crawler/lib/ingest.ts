// /api/v1/ingest 클라이언트. 원문 + 자동 추출 제안을 검수 대기열로 보낸다.
// 응답 본문·토큰은 기록하지 않고 상태코드와 고정된 실패 사유만 남긴다.
import { health } from './health';
import type { ExternalPayload } from './external/filter';

export class IngestError extends Error {
  // 진단용 HTTP 상태코드. crawler/index.ts는 모든 IngestError에서 사이클을 중단한다.
  constructor(message: string, readonly status?: number) { super(message); }
}

export type InstagramItem = { source_url: string; account: string; kind: 'post' | 'story'; text: string; captured_at: string; image_url?: string | null; suggestions?: unknown };
export type IngestItem = InstagramItem | ExternalPayload;
export type IngestReceipt = { id: string; status: string };

export function parseIngestReceipt(value: unknown, kind: IngestItem['kind']): IngestReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { id, status } = data as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
  const allowed = kind === 'external_listing' ? ['candidate', 'dismissed'] : ['pending', 'approved', 'rejected'];
  if (typeof status !== 'string' || !allowed.includes(status)) return null;
  return { id, status };
}

type ReceiptFailure = 'redirect' | 'status' | 'content_type' | 'oversized' | 'body' | 'json' | 'invalid';
async function readReceipt(response: Response, fail: (reason: ReceiptFailure) => never): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  if (!response.body) return fail('body');
  try {
    reader = response.body.getReader();
  } catch { return fail('body'); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { return fail('body'); }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) {
        try { await reader.cancel(); } catch { /* Discard transport diagnostics. */ }
        return fail('oversized');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('json'); }
}

export async function sendItem(api: URL, token: string, item: IngestItem): Promise<IngestReceipt> {
  let response: Response;
  try {
    response = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(item),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
  } catch {
    health('api_error', { status: 'network' });
    throw new IngestError('수집 API 네트워크 오류');
  }
  const fail = (reason: ReceiptFailure): never => {
    health('api_error', { status: response.status, receipt: reason });
    throw new IngestError('수집 API 응답 확인 실패');
  };
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) fail('redirect');
  if (!response.ok) {
    health('api_error', { status: response.status });
    throw new IngestError(`수집 API 요청 실패(${response.status})`, response.status);
  }
  if (response.status !== 202) fail('status');
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('content_type');
  const receipt = parseIngestReceipt(await readReceipt(response, fail), item.kind);
  if (!receipt) return fail('invalid');
  if (item.kind === 'external_listing') health('external_item', { source: item.source, status: response.status, model_match: item.model_match });
  else health(item.kind === 'story' ? 'story_seen' : 'post_sent', { account: item.account, status: response.status, price_found: Boolean((item.suggestions as { price?: unknown } | undefined)?.price) });
  return receipt;
}
