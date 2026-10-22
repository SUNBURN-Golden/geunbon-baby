import { expect, test, vi } from 'vitest';
import { chromium } from 'playwright';
import { handleRoute, renderPage, routeDecision, type RenderContext } from '../crawler/lib/external/render';
import { ALLOW_ALL, DENY_ALL, parseRobots } from '../crawler/lib/external/robots';

const origin = 'https://buyg.kr';
const robots = parseRobots('User-agent: *\nDisallow: /private/');

test.each(['document', 'xhr', 'fetch', 'script', 'stylesheet', 'other'])('%s requests to /api/ are aborted as hard blocks', type => {
  expect(routeDecision({ url: 'https://buyg.kr/api/v1/products?page=1', resourceType: type }, origin, ALLOW_ALL)).toEqual({ action: 'abort', reason: 'hard_block' });
});

test.each(['script', 'xhr', 'fetch', 'document'])('%s requests to another origin are aborted', type => {
  expect(routeDecision({ url: 'https://cdn.example.invalid/app.js', resourceType: type }, origin, ALLOW_ALL)).toEqual({ action: 'abort', reason: 'cross_origin' });
});

test('images, media and fonts are always aborted without counting as blocks', () => {
  for (const type of ['image', 'media', 'font']) {
    expect(routeDecision({ url: 'https://buyg.kr/static/a.png', resourceType: type }, origin, ALLOW_ALL)).toEqual({ action: 'abort', reason: 'resource_type' });
  }
});

test('same-origin allowed paths continue for any data resource type', () => {
  for (const type of ['document', 'xhr', 'fetch', 'script', 'stylesheet']) {
    expect(routeDecision({ url: 'https://buyg.kr/list?page=2', resourceType: type }, origin, robots)).toEqual({ action: 'continue' });
  }
});

test('robots-disallowed paths are aborted regardless of resource type; deny-all policy blocks everything', () => {
  for (const type of ['document', 'xhr', 'script']) {
    expect(routeDecision({ url: 'https://buyg.kr/private/data', resourceType: type }, origin, robots)).toEqual({ action: 'abort', reason: 'robots' });
  }
  expect(routeDecision({ url: 'https://buyg.kr/list', resourceType: 'document' }, origin, DENY_ALL)).toEqual({ action: 'abort', reason: 'robots' });
});

test('login paths and gonggumoa are never requested by the page', () => {
  expect(routeDecision({ url: 'https://buyg.kr/login', resourceType: 'document' }, origin, ALLOW_ALL)).toEqual({ action: 'abort', reason: 'hard_block' });
  expect(routeDecision({ url: 'https://gonggumoa.com/', resourceType: 'xhr' }, origin, ALLOW_ALL)).toEqual({ action: 'abort', reason: 'denylist' });
});

test('non-network data: and blob: URLs are not blocked', () => {
  expect(routeDecision({ url: 'data:text/plain,hi', resourceType: 'other' }, origin, ALLOW_ALL)).toEqual({ action: 'continue' });
});

function fakeRoute(url: string, resourceType: string, calls: string[]) {
  return {
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    abort: async () => { calls.push('abort'); },
    continue: async () => { calls.push('continue'); },
  };
}
function context(calls: string[]) {
  const onBlock = vi.fn();
  const ctx: RenderContext = {
    origin, source: 'buyg', robots, item_selector: '', timeout_ms: 1000,
    pace: async host => { calls.push(`pace:${host}`); },
    onBlock,
  };
  return { ctx, onBlock };
}

test.each(['document', 'xhr', 'fetch', 'script', 'stylesheet', 'other'])('allowed %s requests wait in the host queue before going out', async type => {
  const calls: string[] = [];
  const { ctx } = context(calls);
  expect(await handleRoute(fakeRoute('https://buyg.kr/assets/app.js', type, calls), ctx)).toBe(false);
  expect(calls).toEqual(['pace:buyg.kr', 'continue']);
});

test('blocked requests are never paced, are reported with reason and resource type, and count as blocks', async () => {
  const calls: string[] = [];
  const { ctx, onBlock } = context(calls);
  expect(await handleRoute(fakeRoute('https://buyg.kr/api/items', 'script', calls), ctx)).toBe(true);
  expect(calls).toEqual(['abort']);
  expect(onBlock).toHaveBeenCalledWith({ source: 'buyg', reason: 'hard_block', resource_type: 'script', path: '/api/items' });
});

test('images are aborted silently without pacing or counting as blocks', async () => {
  const calls: string[] = [];
  const { ctx, onBlock } = context(calls);
  expect(await handleRoute(fakeRoute('https://buyg.kr/a.png', 'image', calls), ctx)).toBe(false);
  expect(calls).toEqual(['abort']);
  expect(onBlock).not.toHaveBeenCalled();
});

test('data: URLs continue without waiting in the host queue', async () => {
  const calls: string[] = [];
  const { ctx } = context(calls);
  await handleRoute(fakeRoute('data:text/plain,hi', 'other', calls), ctx);
  expect(calls).toEqual(['continue']);
});

test('renderPage closes WebSocket connections without connecting to the server and counts them as blocks', async () => {
  let wsHandler: ((ws: { url: () => string; close: () => Promise<void> }) => void) | undefined;
  const closed = vi.fn(async () => {});
  const fakeContext = {
    route: vi.fn(async () => {}),
    routeWebSocket: vi.fn(async (_pattern: RegExp, handler: typeof wsHandler) => { wsHandler = handler; }),
    newPage: async () => ({
      goto: async () => { wsHandler?.({ url: () => 'wss://buyg.kr/socket/live', close: closed }); },
      waitForLoadState: async () => {},
      content: async () => '<html></html>',
    }),
  };
  vi.mocked(chromium.launch).mockResolvedValueOnce({ newContext: async () => fakeContext, close: async () => {} } as never);
  const calls: string[] = [];
  const { ctx, onBlock } = context(calls);
  const result = await renderPage('https://buyg.kr/', ctx);
  expect(fakeContext.routeWebSocket).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledOnce();
  expect(result.blocked).toBe(1);
  expect(onBlock).toHaveBeenCalledWith({ source: 'buyg', reason: 'websocket', resource_type: 'websocket', path: '/socket/live' });
});
