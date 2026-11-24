import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { kstMidnight } from '../crawler/src/offers/metrics';
import { offerTransport, TransportError, type TransportResponse } from '../crawler/src/offers/transport';
import { temporaryOfferStore } from './helpers/offer-store';

const body = (url: URL, text = 'Fixture HTML', status = 200): TransportResponse => ({ finalUrl: url.href, status,
  body: text, bytes: Buffer.from(text), cookies: [], headers: { 'content-type': 'text/html' } });
const addresses = async () => [{ address: '93.184.216.34', family: 4 }];

test('proxy setup failure gets one direct socket; Threads stays direct and origin denials never retry', async () => {
  const f = temporaryOfferStore(() => Date.parse('2026-11-23T23:30:00+09:00'));
  try {
    const tunnel = vi.fn(async () => { throw new TransportError('proxy_setup_failed'); });
    const request = vi.fn(async (url: URL) => body(url, 'Denied', url.hostname === 'seller.example.com' ? 403 : 200));
    const transport = offerTransport(f.store, f.dir, 'http://proxy.example.com:8080', { addresses, tunnel, request });
    const response = await transport('https://seller.example.com/deal', { lane: 'public' });
    expect(response.status).toBe(403);
    expect(tunnel).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    await expect(transport('https://seller.example.com/other', { lane: 'public' })).rejects.toThrow('source_backoff');
    await transport('https://www.threads.net/@account/post/1', { lane: 'threads' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(tunnel).toHaveBeenCalledOnce();
  } finally { f.close(); }
});

test.each([200, 429])('Instagram HTTP %s opens no waiting socket and resumes only at the next KST midnight', async status => {
  let now = Date.parse('2026-11-23T23:30:00+09:00');
  const f = temporaryOfferStore(() => now);
  try {
    let complete!: () => void, arrive!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const hold = new Promise<void>(resolve => { complete = resolve; });
    const request = vi.fn(async (url: URL) => {
      if (!url.hostname.endsWith('instagram.com')) return body(url);
      arrive();
      await hold;
      return body(url, status === 200 ? '<html><h1>Checkpoint required</h1></html>' : 'Rate limited', status);
    });
    const first = offerTransport(f.store, f.dir, '', { addresses, request });
    const second = offerTransport(f.store, f.dir, '', { addresses, request });
    const pending = first('https://www.instagram.com/p/abc', { lane: 'instagram' });
    await arrived;
    const waiting = expect(second('https://cdninstagram.com/image.jpg', { lane: 'instagram' })).rejects.toThrow('instagram_stopped');
    complete();
    await pending;
    await waiting;
    expect(request).toHaveBeenCalledOnce();
    f.reopen();
    const restarted = offerTransport(f.store, f.dir, '', { addresses, request });
    await expect(restarted('https://www.instagram.com/p/def', { lane: 'instagram' })).rejects.toThrow('instagram_stopped');
    await restarted('https://seller.example.com/deal', { lane: 'public' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(f.dir, 'metrics-hourly.jsonl'), 'utf8').match(/"type":"instagram_stop"/g)).toHaveLength(1);
    now = kstMidnight(now);
    request.mockImplementationOnce(async url => body(url));
    expect((await restarted('https://www.instagram.com/p/def', { lane: 'instagram' })).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(3);
  } finally { f.close(); }
});
