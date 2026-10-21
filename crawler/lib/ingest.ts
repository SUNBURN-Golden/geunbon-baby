// /api/v1/ingest 클라이언트. 원문 + 자동 추출 제안을 검수 대기열로 보낸다.
// 응답 본문·토큰은 기록하지 않고 상태코드만 상태 로그에 남긴다.
import { health } from './health';

export class IngestError extends Error {}

export type IngestItem = { source_url: string; account: string; kind: 'post' | 'story'; text: string; captured_at: string; image_url?: string | null; suggestions?: unknown };

export async function sendItem(api: URL, token: string, item: IngestItem): Promise<void> {
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
  if (!response.ok) {
    health('api_error', { status: response.status });
    throw new IngestError(`수집 API 요청 실패(${response.status})`);
  }
  health(item.kind === 'story' ? 'story_seen' : 'post_sent', { account: item.account, status: response.status });
}
