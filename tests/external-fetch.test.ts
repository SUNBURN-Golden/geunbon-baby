import { expect, test, vi } from 'vitest';
import { ExternalFetchError, PoliteFetcher, type BlockInfo } from '../crawler/lib/external/fetch';
import { USER_AGENT } from '../crawler/lib/external/robots';

const ORIGIN = 'https://09pangpang.com';
function harness(routes: Record<string, () => Response>, options: { min_interval_ms?: number; jitter_ms?: [number, number]; max_bytes?: number } = {}) {
  let clock = 1_000_000;
  const calls: { url: string; at: number; init: RequestInit }[] = [];
  const blocks: BlockInfo[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, at: clock, init: init ?? {} });
    const route = routes[href];
    if (!route) throw new Error(`unexpected ${href}`);
    return route();
  });
  const fetcher = new PoliteFetcher(
    { min_interval_ms: options.min_interval_ms ?? 1500, jitter_ms: options.jitter_ms ?? [0, 0], timeout_ms: 1000, max_bytes: options.max_bytes },
    { fetch: fetchMock as unknown as typeof fetch, sleep: async ms => { clock += ms; }, now: () => clock, random: () => 0.5 },
    info => blocks.push(info),
  );
  return { fetcher, calls, blocks, fetchMock, clock: () => clock, advance: (ms: number) => { clock += ms; } };
}
const html = (body = '<p>ok</p>') => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const robotsTxt = (body = 'User-agent: *\nDisallow: /private/') => () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

test('requests to one host are at least min_interval_ms apart, including robots.txt, and carry only the fixed UA', async () => {
  const h = harness({ [`${ORIGIN}/robots.txt`]: robotsTxt(), [`${ORIGIN}/a`]: html(), [`${ORIGIN}/b`]: html() }, { min_interval_ms: 1500, jitter_ms: [0, 1000] });
  await Promise.all([h.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' }), h.fetcher.get(`${ORIGIN}/b`, { origin: ORIGIN, source: 'pangpang' })]);
  expect(h.calls.map(call => call.url)).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/a`, `${ORIGIN}/b`]);
  for (let i = 1; i < h.calls.length; i++) expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(2000);
  for (const call of h.calls) {
    const headers = new Headers(call.init.headers);
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    expect(call.init.redirect).toBe('manual');
  }
});

test('different hosts use independent queues', async () => {
  const other = 'https://momcalendar.com';
  const h = harness({ [`${ORIGIN}/robots.txt`]: robotsTxt(), [`${other}/robots.txt`]: robotsTxt(), [`${ORIGIN}/a`]: html(), [`${other}/a`]: html() });
  await Promise.all([h.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' }), h.fetcher.get(`${other}/a`, { origin: other, source: 'momcalendar' })]);
  const first = h.calls.filter(call => call.url.startsWith(other))[0];
  expect(first.at).toBe(1_000_000);
});

test('robots.txt is fetched before the first GET and cached afterwards', async () => {
  const h = harness({ [`${ORIGIN}/robots.txt`]: robotsTxt(), [`${ORIGIN}/a`]: html(), [`${ORIGIN}/b`]: html() });
  await h.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' });
  await h.fetcher.get(`${ORIGIN}/b`, { origin: ORIGIN, source: 'pangpang' });
  expect(h.calls.filter(call => call.url.endsWith('/robots.txt'))).toHaveLength(1);
  expect(h.calls[0].url).toBe(`${ORIGIN}/robots.txt`);
});

test('disallowed and hard-blocked paths make no request and are reported', async () => {
  const h = harness({ [`${ORIGIN}/robots.txt`]: robotsTxt() });
  expect(await h.fetcher.get(`${ORIGIN}/private/x`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(await h.fetcher.get(`${ORIGIN}/api/v1/list`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(await h.fetcher.get('http://09pangpang.com/a', { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(h.blocks.map(block => block.reason)).toEqual(['robots', 'hard_block', 'scheme']);
  expect(h.calls.map(call => call.url)).toEqual([`${ORIGIN}/robots.txt`]);
  expect(h.blocks.every(block => block.source === 'pangpang' && block.resource_type === 'document')).toBe(true);
});

test.each([404, 410])('robots.txt %i allows', async status => {
  const missing = harness({ [`${ORIGIN}/robots.txt`]: () => new Response('', { status }), [`${ORIGIN}/a`]: html() });
  expect((await missing.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' }))?.text).toBe('<p>ok</p>');
});

test('robots 403/429, 5xx and network errors deny for shared fetcher callers', async () => {
  for (const status of [403, 429]) {
    const h = harness({ [`${ORIGIN}/robots.txt`]: () => new Response(null, { status }) });
    expect(await h.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
    expect(h.calls.map(call => call.url)).toEqual([`${ORIGIN}/robots.txt`]);
  }
  const broken = harness({ [`${ORIGIN}/robots.txt`]: () => new Response('', { status: 503 }), [`${ORIGIN}/a`]: html() });
  expect(await broken.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(broken.blocks[0].reason).toBe('robots');
  expect(broken.calls.some(call => call.url.endsWith('/a'))).toBe(false);
  const offline = harness({});
  expect(await offline.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
});

test('concurrent callers share one expired robots lookup and receive its new deadline', async () => {
  const robotsUrl = `${ORIGIN}/robots.txt`;
  const responses = [
    new Response(null, { status: 403 }),
    new Response(null, { status: 429, headers: { 'retry-after': '2' } }),
    robotsTxt()(),
  ];
  const h = harness({ [robotsUrl]: () => responses.shift()!, [`${ORIGIN}/a`]: html() }, { min_interval_ms: 0 });
  const ctx = { origin: ORIGIN, source: 'deepseek-web', reportRobotsFailure: true };
  const get = (path: string) => h.fetcher.get(`${ORIGIN}${path}`, ctx);
  const firstDeadline = h.clock() + 600_000;
  await expect(get('/a')).rejects.toMatchObject({ failure: { stage: 'robots', status: 403, retryAt: firstDeadline } });
  h.advance(599_999);
  await expect(get('/b')).rejects.toMatchObject({ failure: { retryAt: firstDeadline } });
  expect(h.calls.map(call => call.url)).toEqual([robotsUrl]);

  h.advance(1);
  expect(await h.fetcher.get(`${ORIGIN}/a`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  const secondDeadline = h.clock() + 2_000;
  await Promise.all(['/a', '/b'].map(path => expect(get(path)).rejects.toMatchObject({
    failure: { stage: 'robots', status: 429, retryAt: secondDeadline },
  })));
  expect(h.calls.map(call => call.url)).toEqual([robotsUrl, robotsUrl]);

  h.advance(2_000);
  expect(await get('/a')).toMatchObject({ status: 200, text: '<p>ok</p>' });
  expect(h.calls.map(call => call.url)).toEqual([robotsUrl, robotsUrl, robotsUrl, `${ORIGIN}/a`]);
});

test('same-origin redirects are re-checked against robots and cross-origin redirects are refused', async () => {
  const h = harness({
    [`${ORIGIN}/robots.txt`]: robotsTxt(),
    [`${ORIGIN}/go`]: () => new Response(null, { status: 302, headers: { location: '/list' } }),
    [`${ORIGIN}/list`]: html('<p>list</p>'),
    [`${ORIGIN}/to-private`]: () => new Response(null, { status: 302, headers: { location: '/private/x' } }),
    [`${ORIGIN}/to-api`]: () => new Response(null, { status: 301, headers: { location: '/api/x' } }),
    [`${ORIGIN}/away`]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.invalid/' } }),
  });
  expect((await h.fetcher.get(`${ORIGIN}/go`, { origin: ORIGIN, source: 'pangpang' }))?.url).toBe(`${ORIGIN}/list`);
  expect(await h.fetcher.get(`${ORIGIN}/to-private`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(await h.fetcher.get(`${ORIGIN}/to-api`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(await h.fetcher.get(`${ORIGIN}/away`, { origin: ORIGIN, source: 'pangpang' })).toBeNull();
  expect(h.blocks.map(block => block.reason)).toEqual(['robots', 'hard_block', 'cross_origin']);
  expect(h.calls.some(call => call.url.includes('evil') || call.url.includes('/private/') || call.url.includes('/api/'))).toBe(false);
});

test('redirect loops stop after three hops', async () => {
  const h = harness({ [`${ORIGIN}/robots.txt`]: robotsTxt(), [`${ORIGIN}/loop`]: () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
  await expect(h.fetcher.get(`${ORIGIN}/loop`, { origin: ORIGIN, source: 'pangpang' })).rejects.toBeInstanceOf(ExternalFetchError);
  expect(h.calls.filter(call => call.url.endsWith('/loop'))).toHaveLength(4);
});

test('oversized bodies, non-text responses and error statuses fail without returning content', async () => {
  const h = harness({
    [`${ORIGIN}/robots.txt`]: robotsTxt(), [`${ORIGIN}/big`]: html('x'.repeat(100)),
    [`${ORIGIN}/img`]: () => new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }),
    [`${ORIGIN}/missing`]: () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
  }, { max_bytes: 50 });
  for (const path of ['/big', '/img', '/missing']) await expect(h.fetcher.get(`${ORIGIN}${path}`, { origin: ORIGIN, source: 'pangpang' })).rejects.toBeInstanceOf(ExternalFetchError);
});

test('pace() shares the host queue so rendered data requests respect the same interval', async () => {
  const h = harness({ [`${ORIGIN}/robots.txt`]: robotsTxt() }, { min_interval_ms: 1000 });
  const times: number[] = [];
  await Promise.all([1, 2, 3].map(() => h.fetcher.pace('09pangpang.com', async () => { times.push(h.clock()); })));
  expect(times).toHaveLength(3);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  expect(times[2] - times[1]).toBeGreaterThanOrEqual(1000);
});
