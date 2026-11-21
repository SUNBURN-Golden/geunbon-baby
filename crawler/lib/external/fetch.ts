import { safeEtag, safeModified } from '../../src/agamajung/http-validators';
// 외부 사이트용 공손한 HTTP 클라이언트: 호스트별 직렬 큐로 요청 간격을 보장하고,
// 모든 GET 직전에 robots.txt와 하드 금지 경로 판정(decide)을 거친다. 쿠키·로그인·Instagram 세션을 쓰지 않는다.
import { ALLOW_ALL, DENY_ALL, decide, parseRobots, USER_AGENT, type DecisionReason, type Robots } from './robots';

export type RequestStage = 'robots' | 'page';
export type FetchFailure = {
  stage: RequestStage;
  hostname: string;
  url: string;
} & (
  | { kind: 'http'; status: number; retryAt: number | null }
  | { kind: 'timeout' | 'transport'; phase: 'request' | 'body' }
  | { kind: 'invalid_response' }
);
export class ExternalFetchError extends Error {
  constructor(message: string, readonly failure: FetchFailure) {
    super(message);
  }
}
export type PoliteOptions = { min_interval_ms: number; jitter_ms: [number, number]; timeout_ms: number; max_bytes?: number; max_redirects?: number };
export type FetcherDeps = { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number; random: () => number };
export type BlockInfo = { source: string; reason: DecisionReason | 'websocket'; resource_type: string; path: string };
export type ConditionalRequest = { fetch_url: string; etag: string | null; last_modified: string | null };
export type FetchContext = { origin: string; source: string; conditional?: ConditionalRequest; allowNotModified?: boolean; reportRobotsFailure?: boolean; beforeRequest?: (url: string, stage: RequestStage) => void; signal?: AbortSignal };
export type FetchResult = { status: number; url: string; text: string; etag?: string | null; last_modified?: string | null };
type RobotsResult = { rules: Robots; error?: ExternalFetchError };
type RobotsCacheEntry = { result: Promise<RobotsResult>; retryAt?: number };
export const REQUEST_REPRESENTATION = JSON.stringify({ user_agent: USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', language: 'ko-KR,ko;q=0.9', version: 1 });
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_HOST_BACKOFF_MS = 10 * 60 * 1000;
const HTTP_DATE = /^(?:[a-z]{3}, \d{2} [a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[a-z]{6,9}, \d{2}-[a-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[a-z]{3} [a-z]{3} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/i;

function retryDeadline(value: string | null, now: number): number {
  const fallback = now + DEFAULT_HOST_BACKOFF_MS;
  if (!value) return fallback;
  const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000
    : HTTP_DATE.test(value)
      ? Date.parse(value + (/GMT$/i.test(value) ? '' : ' GMT')) : NaN;
  return Number.isSafeInteger(deadline) && deadline > now && deadline <= 8.64e15 ? deadline : fallback;
}

function requestSite(url: URL, stage: RequestStage) {
  return { url: url.href, hostname: url.hostname, stage };
}

export class PoliteFetcher {
  private tails = new Map<string, Promise<unknown>>();
  private lastAt = new Map<string, number>();
  private robots = new Map<string, RobotsCacheEntry>();
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
    return this.robotsResult({ origin, source: 'robots', beforeRequest }).then(result => result.rules, () => DENY_ALL);
  }

  private robotsResult(ctx: FetchContext): Promise<RobotsResult> {
    const cached = this.robots.get(ctx.origin);
    if (cached && (!ctx.reportRobotsFailure || cached.retryAt === undefined || this.deps.now() < cached.retryAt)) {
      if (ctx.reportRobotsFailure) ctx.beforeRequest?.(new URL('/robots.txt', ctx.origin).href, 'robots');
      return cached.result;
    }
    // An in-flight lookup has no deadline, so callers share the replacement.
    const entry: RobotsCacheEntry = {
      result: this.loadRobots(ctx).then(result => {
        const failure = result.error?.failure;
        if (failure?.kind === 'http' && failure.retryAt !== null) entry.retryAt = failure.retryAt;
        return result;
      }, error => {
        this.robots.delete(ctx.origin);
        throw error;
      }),
    };
    this.robots.set(ctx.origin, entry);
    return entry.result;
  }

  private async loadRobots(ctx: FetchContext): Promise<RobotsResult> {
    try {
      const result = await this.follow(new URL('/robots.txt', ctx.origin).href, { ...ctx, source: 'robots' }, null, 'robots');
      if (!result) return { rules: DENY_ALL };
      if (result.status === 404 || result.status === 410) return { rules: ALLOW_ALL };
      return { rules: parseRobots(result.text) };
    } catch (error) {
      if (error instanceof ExternalFetchError) return { rules: DENY_ALL, error };
      if (ctx.reportRobotsFailure) throw error;
      return { rules: DENY_ALL };
    }
  }

  // 차단되면 요청 없이 null. 전송·상태 오류는 ExternalFetchError.
  async get(target: string, ctx: FetchContext): Promise<FetchResult | null> {
    ctx.signal?.throwIfAborted();
    if (!decide(target, ctx.origin).allowed) return this.blocked(target, ctx.origin, ctx.source);
    if (!ctx.reportRobotsFailure) ctx.beforeRequest?.(new URL('/robots.txt', ctx.origin).href, 'robots');
    const robots = await this.robotsResult(ctx.reportRobotsFailure ? ctx : { origin: ctx.origin, source: 'robots' });
    ctx.signal?.throwIfAborted();
    if (ctx.reportRobotsFailure && robots.error) throw robots.error;
    return this.follow(target, ctx, robots.rules, 'page');
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

  private async follow(start: string, ctx: FetchContext, robots: Robots | null, stage: RequestStage): Promise<FetchResult | null> {
    let current = start;
    for (let hop = 0; hop <= (this.options.max_redirects ?? MAX_REDIRECTS); hop++) {
      ctx.signal?.throwIfAborted();
      if (!decide(current, ctx.origin, robots).allowed) return this.blocked(current, ctx.origin, ctx.source, robots);
      const conditional = stage === 'page' && hop === 0 && start === ctx.conditional?.fetch_url ? ctx.conditional : undefined;
      const response = await this.request(current, stage, ctx, conditional);
      if (response.location !== null) {
        try { current = new URL(response.location, current).href; }
        catch { throw new ExternalFetchError('잘못된 리디렉트', { ...requestSite(new URL(current), stage), kind: 'invalid_response' }); }
        continue;
      }
      return { status: response.status, url: current, text: response.text, etag: response.etag, last_modified: response.last_modified };
    }
    throw new ExternalFetchError('리디렉트 횟수 초과', { ...requestSite(new URL(start), stage), kind: 'invalid_response' });
  }

  private request(target: string, stage: RequestStage, ctx: FetchContext, conditional?: ConditionalRequest) {
    const url = new URL(target);
    return this.pace(url.host, async () => {
      ctx.signal?.throwIfAborted();
      ctx.beforeRequest?.(target, stage);
      const site = requestSite(url, stage);
      const timeout = AbortSignal.timeout(this.options.timeout_ms);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      let phase: 'request' | 'body' = 'request';
      try {
        const response = await this.deps.fetch(url.href, {
          method: 'GET',
          redirect: 'manual',
          headers: { ...(conditional && url.pathname !== '/robots.txt' ? { ...(safeEtag(conditional.etag) ? { 'if-none-match': conditional.etag! } : {}), ...(safeModified(conditional.last_modified) ? { 'if-modified-since': conditional.last_modified! } : {}) } : {}), 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'accept-language': 'ko-KR,ko;q=0.9' },
          signal,
        });
        signal.throwIfAborted();
        const { status } = response;
        const location = status >= 300 && status < 400 && status !== 304 ? response.headers.get('location') : null;
        const validators = { etag: safeEtag(response.headers.get('etag')), last_modified: safeModified(response.headers.get('last-modified')) };
        if (status < 200 || status >= 300) {
          const retryAt = status === 403 || status === 429 ? retryDeadline(response.headers.get('retry-after'), this.deps.now()) : null;
          void response.body?.cancel().catch(() => {});
          const allowedStatus = stage === 'robots' ? status === 404 || status === 410 : ctx.allowNotModified && status === 304;
          if (location !== null || allowedStatus) return { status, location, text: '', ...validators };
          const message = stage === 'page' && status >= 300 && status < 400 && status !== 304 ? '리디렉트 응답 오류' : `외부 사이트 응답 오류(${status})`;
          throw new ExternalFetchError(message, { ...site, kind: 'http', status, retryAt });
        }
        if (!response.body) return { status, location, text: '', ...validators };
        const type = response.headers.get('content-type') ?? '';
        if (type && !/text|html|xml/i.test(type)) {
          void response.body.cancel().catch(() => {});
          throw new ExternalFetchError('텍스트가 아닌 응답', { ...site, kind: 'invalid_response' });
        }
        phase = 'body';
        const text = await this.read(response, site);
        signal.throwIfAborted();
        return { status, location, text, ...validators };
      } catch (error) {
        ctx.signal?.throwIfAborted();
        if (error instanceof ExternalFetchError) throw error;
        const kind = timeout.aborted || error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport';
        throw new ExternalFetchError('외부 사이트 네트워크 오류', { ...site, kind, phase });
      }
    });
  }
  private async read(response: Response, site: ReturnType<typeof requestSite>): Promise<string> {
    const limit = this.options.max_bytes ?? MAX_BYTES;
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new ExternalFetchError('응답 본문 크기 초과', { ...site, kind: 'invalid_response' });
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}
