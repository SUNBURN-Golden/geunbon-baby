// 렌더링이 필요한 소스용 브라우저. Instagram 세션과 무관한 새 컨텍스트(storageState 없음)만 쓴다.
// 렌더링 중 브라우저가 내보내는 모든 요청(document·XHR·fetch·script 포함)에 fetch.ts와 같은 decide()를 적용한다.
import { chromium } from 'playwright';
import { decide, USER_AGENT, type DecisionReason, type Robots } from './robots';

export type RouteResult = { action: 'continue' } | { action: 'abort'; reason: DecisionReason | 'resource_type' };
const SILENT_ABORT = new Set(['image', 'media', 'font']);

export function routeDecision(request: { url: string; resourceType: string }, origin: string, robots: Robots): RouteResult {
  if (SILENT_ABORT.has(request.resourceType)) return { action: 'abort', reason: 'resource_type' };
  // data:/blob:은 네트워크 요청이 아니다.
  if (/^(data|blob):/i.test(request.url)) return { action: 'continue' };
  const decision = decide(request.url, origin, robots);
  return decision.allowed ? { action: 'continue' } : { action: 'abort', reason: decision.reason };
}

export type BlockReason = DecisionReason | 'websocket';
export type RenderContext = {
  origin: string; source: string; robots: Robots; item_selector: string; timeout_ms: number;
  pace: (host: string) => Promise<void>;
  onBlock: (info: { source: string; reason: BlockReason; resource_type: string; path: string }) => void;
};
export type RenderResult = { html: string; blocked: number };
export type Renderer = (target: string, ctx: RenderContext) => Promise<RenderResult>;

type RouteLike = { request(): { url(): string; resourceType(): string }; abort(): Promise<void>; continue(): Promise<void> };

// 라우트된 요청 하나를 처리한다. 허용된 요청은 리소스 종류와 상관없이(script·stylesheet 포함) 같은 호스트 큐를 거쳐
// 요청 간격 1초 이상을 지킨다. 차단(이미지·미디어·폰트 제외)이면 true를 돌려준다.
export async function handleRoute(route: RouteLike, ctx: RenderContext): Promise<boolean> {
  const request = route.request();
  const url = request.url();
  const result = routeDecision({ url, resourceType: request.resourceType() }, ctx.origin, ctx.robots);
  if (result.action === 'abort') {
    const counted = result.reason !== 'resource_type';
    if (counted) {
      let path = '';
      try { path = new URL(url).pathname; } catch { /* 경로 없음 */ }
      ctx.onBlock({ source: ctx.source, reason: result.reason as BlockReason, resource_type: request.resourceType(), path });
    }
    await route.abort();
    return counted;
  }
  if (!/^(data|blob):/i.test(url)) await ctx.pace(new URL(url).host);
  await route.continue();
  return false;
}

export const renderPage: Renderer = async (target, ctx) => {
  const browser = await chromium.launch({ headless: true });
  let blocked = 0;
  try {
    const context = await browser.newContext({ locale: 'ko-KR', userAgent: USER_AGENT, serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', async route => {
      if (await handleRoute(route, ctx)) blocked++;
    });
    // context.route는 WebSocket을 가로채지 않으므로 서버에 연결하지 않고 닫아 둔다.
    await context.routeWebSocket(/.*/, ws => {
      blocked++;
      let path = '';
      try { path = new URL(ws.url()).pathname; } catch { /* 경로 없음 */ }
      ctx.onBlock({ source: ctx.source, reason: 'websocket', resource_type: 'websocket', path });
      void ws.close();
    });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: ctx.timeout_ms });
    if (ctx.item_selector) await page.waitForSelector(ctx.item_selector, { timeout: ctx.timeout_ms }).catch(() => {});
    else await page.waitForLoadState('networkidle', { timeout: ctx.timeout_ms }).catch(() => {});
    return { html: await page.content(), blocked };
  } finally {
    await browser.close().catch(() => {});
  }
};
