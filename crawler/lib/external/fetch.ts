import { safeEtag, safeModified } from '../../src/agamajung/http-validators';
// 외부 사이트용 공손한 HTTP 클라이언트: 호스트별 직렬 큐로 요청 간격을 보장하고,
// 모든 GET 직전에 robots.txt와 하드 금지 경로 판정(decide)을 거친다. 쿠키·로그인·Instagram 세션을 쓰지 않는다.
import { ALLOW_ALL, DENY_ALL, decide, parseRobots, USER_AGENT, type DecisionReason, type Robots } from './robots';

export class ExternalFetchError extends Error {}
export type PoliteOptions = { min_interval_ms: number; jitter_ms: [number, number]; timeout_ms: number; max_bytes?: number; max_redirects?: number };
export type FetcherDeps = { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number; random: () => number };
export type BlockInfo = { source: string; reason: DecisionReason | 'websocket'; resource_type: string; path: string };
export type ConditionalRequest = { fetch_url: string; etag: string | null; last_modified: string | null };
export type FetchContext = { origin: string; source: string; conditional?: ConditionalRequest; allowNotModified?: boolean; beforeRequest?: (url: string) => void };
export type FetchResult = { status: number; url: string; text: string; etag?: string | null; last_modified?: string | null };
export const REQUEST_REPRESENTATION = JSON.stringify({ user_agent: USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', language: 'ko-KR,ko;q=0.9', version: 1 });
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class PoliteFetcher {
  private tails = new Map<string, Promise<unknown>>();
  private lastAt = new Map<string, number>();
  private robots = new Map<string, Promise<Robots>>();
  /** Most recent blocked request, for callers that need to classify the block after `get()` returns null. */
  lastBlock: BlockInfo | null = null;
  constructor(private options: PoliteOptions, private deps: FetcherDeps, private onBlock: (info: BlockInfo) => void = () => {}) {}

  // 같은 호스트의 요청 시작 시점을 직렬화한다. 렌더링 중 브라우저의 데이터 요청도 이 큐를 쓴다.
  pace<T>(host: string, task: () => Promise<T> = async () => undefined as T): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const last = this.lastAt.get(host);
      if (last !== undefined) {
        const [low, high] = this.options.jitter_ms;
        const wait = last + this.options.min_interval_ms + low + this.deps.random() * (high - low) - this.deps.now();
        if (wait > 0) await this.deps.sleep(wait);
      }
      try { return await task(); } finally { this.lastAt.set(host, this.deps.now()); }
    });
    this.tails.set(host, run);
    return run;
  }

  robotsFor(origin: string, beforeRequest?: (url: string) => void): Promise<Robots> {
    let cached = this.robots.get(origin);
    if (!cached) {
      cached = this.loadRobots(origin, beforeRequest);
      this.robots.set(origin, cached);
    }
    return cached;
  }
  private async loadRobots(origin: string, beforeRequest?: (url: string) => void): Promise<Robots> {
    try {
      const result = await this.follow(new URL('/robots.txt', origin).href, origin, 'robots', null, true, { origin, source: 'robots', beforeRequest });
      if (!result) return DENY_ALL;
      if (result.status === 404 || result.status === 410) return ALLOW_ALL;
      if (result.status >= 200 && result.status < 300) return parseRobots(result.text);
      return DENY_ALL;
    } catch { return DENY_ALL; }
  }

  // 차단되면 요청 없이 null. 전송·상태 오류는 ExternalFetchError.
  async get(target: string, ctx: FetchContext): Promise<FetchResult | null> {
    if (!decide(target, ctx.origin).allowed) return this.blocked(target, ctx.origin, ctx.source);
    // The robots URL itself is policy-checked here; `follow()` would check it a
    // second time, so it is not passed through as well.
    ctx.beforeRequest?.(new URL('/robots.txt', ctx.origin).href);
    const robots = await this.robotsFor(ctx.origin);
    const result = await this.follow(target, ctx.origin, ctx.source, robots, false, ctx);
    if (result && (result.status < 200 || result.status >= 300 && !(ctx.allowNotModified && result.status === 304))) throw new ExternalFetchError(`외부 사이트 응답 오류(${result.status})`);
    return result;
  }

  private blocked(target: string, origin: string, source: string, robots: Robots | null = null): null {
    const decision = decide(target, origin, robots);
    let path = '';
    try { path = new URL(target).pathname; } catch { /* 경로를 알 수 없음 */ }
    if (!decision.allowed) {
      this.lastBlock = { source, reason: decision.reason, resource_type: 'document', path };
      this.onBlock(this.lastBlock);
    }
    return null;
  }

  private async follow(start: string, origin: string, source: string, robots: Robots | null, allowStatus: boolean, ctx?: FetchContext): Promise<FetchResult | null> {
    let current = start;
    for (let hop = 0; hop <= (this.options.max_redirects ?? MAX_REDIRECTS); hop++) {
      if (!decide(current, origin, robots).allowed) return this.blocked(current, origin, source, robots);
      ctx?.beforeRequest?.(current);
      const conditional = hop === 0 && current === ctx?.conditional?.fetch_url ? ctx.conditional : undefined;
      const response = await this.request(new URL(current), conditional);
      if (response.location !== null) {
        try { current = new URL(response.location, current).href; } catch { throw new ExternalFetchError('잘못된 리디렉트'); }
        continue;
      }
      if (!allowStatus && !(ctx?.allowNotModified && response.status === 304) && response.status >= 300 && response.status < 400) throw new ExternalFetchError('리디렉트 응답 오류');
      return { status: response.status, url: current, text: response.text, etag: response.etag, last_modified: response.last_modified };
    }
    throw new ExternalFetchError('리디렉트 횟수 초과');
  }

  private request(url: URL, conditional?: ConditionalRequest): Promise<{ status: number; location: string | null; text: string; etag: string | null; last_modified: string | null }> {
    return this.pace(url.host, async () => {
      let response: Response;
      try {
        response = await this.deps.fetch(url.href, {
          method: 'GET',
          redirect: 'manual',
          headers: { ...(conditional && url.pathname !== '/robots.txt' ? { ...(safeEtag(conditional.etag) ? { 'if-none-match': conditional.etag! } : {}), ...(safeModified(conditional.last_modified) ? { 'if-modified-since': conditional.last_modified! } : {}) } : {}), 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'accept-language': 'ko-KR,ko;q=0.9' },
          signal: AbortSignal.timeout(this.options.timeout_ms),
        });
      } catch { throw new ExternalFetchError('외부 사이트 네트워크 오류'); }
      const location = response.status !== 304 && response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      const validators = { etag: safeEtag(response.headers.get('etag')), last_modified: safeModified(response.headers.get('last-modified')) };
      const type = response.headers.get('content-type') ?? '';
      if (location !== null || response.status < 200 || response.status >= 300 || !response.body) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, location, text: '', ...validators };
      }
      if (type && !/text|html|xml/i.test(type)) { await response.body.cancel().catch(() => {}); throw new ExternalFetchError('텍스트가 아닌 응답'); }
      return { status: response.status, location: null, text: await this.read(response), ...validators };
    });
  }
  private async read(response: Response): Promise<string> {
    const limit = this.options.max_bytes ?? MAX_BYTES;
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new ExternalFetchError('응답 본문 크기 초과'); }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}
