import { expect, test, vi } from 'vitest';
import { PoliteFetcher, type ConditionalRequest } from '../crawler/lib/external/fetch';
const origin = 'https://shop.example';
const conditional: ConditionalRequest = { fetch_url: origin + '/a', etag: '"v1"', last_modified: 'Tue, 10 Nov 2026 00:00:00 GMT' };
function setup(reply: (url: string) => Response) {
  const fetch = vi.fn(async (target: string | URL | Request) => reply(String(target)));
  const fetcher = new PoliteFetcher({ min_interval_ms: 0, jitter_ms: [0, 0], timeout_ms: 1000 }, { fetch: fetch as typeof globalThis.fetch, now: Date.now, random: () => 0, sleep: async () => {} });
  return { fetcher, fetch };
}
test('compatible conditional headers never reach robots or redirected paths', async () => {
  const { fetcher, fetch } = setup(url => url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /') : url.endsWith('/a') ? new Response(null, { status: 302, headers: { location: '/b' } }) : new Response('product', { headers: { etag: '"v2"' } }));
  expect(await fetcher.get(origin + '/a', { origin, source: 'test', conditional, allowNotModified: true })).toMatchObject({ status: 200, url: origin + '/b', etag: '"v2"' });
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(new Headers(calls[0][1].headers).get('if-none-match')).toBeNull();
  expect(new Headers(calls[1][1].headers).get('if-none-match')).toBe('"v1"');
  expect(new Headers(calls[1][1].headers).get('if-modified-since')).toBe(conditional.last_modified);
  expect(new Headers(calls[2][1].headers).get('if-none-match')).toBeNull();
});
test('304 has no parsed body and no redirect; default callers still reject 304', async () => {
  const { fetcher } = setup(url => url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /') : new Response(null, { status: 304, headers: { location: '/wrong', etag: '"v1"' } }));
  expect(await fetcher.get(origin + '/a', { origin, source: 'test', conditional, allowNotModified: true })).toMatchObject({ status: 304, text: '', url: origin + '/a' });
  await expect(fetcher.get(origin + '/a', { origin, source: 'test' })).rejects.toThrow();
});
test('unsafe validators are dropped unchanged, exact fetch URLs are required, cross-origin redirects remain refused', async () => {
  const { fetcher, fetch } = setup(url => url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /') : new Response(null, { status: 302, headers: { location: 'https://other.example/c' } }));
  expect(await fetcher.get(origin + '/a', { origin, source: 'test', conditional: { ...conditional, etag: '"api_key=secret-fixture"', last_modified: 'bad date' }, allowNotModified: true })).toBeNull();
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls).toHaveLength(2); expect(new Headers(calls[1][1].headers).get('if-none-match')).toBeNull(); expect(new Headers(calls[1][1].headers).get('if-modified-since')).toBeNull();
});
