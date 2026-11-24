import type { BrowserContext, Route } from 'playwright';
import { USER_AGENT } from '../../lib/external/robots';
import type { CollectorStore } from '../store';
import { instagramStopped, sourceLane, type OfferTransport } from './transport';

// Chromium has no usable egress outside intercepted routes. Node owns the
// real connection, including TLS and the host lock.
export const isolatedBrowser = {
  proxy: { server: 'http://127.0.0.1:9' },
  args: ['--proxy-bypass-list=<-loopback>', '--disable-background-networking', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=NetworkPrediction,PreconnectToSearch,SpeculationRulesPrefetch'],
};
export const isolatedContext = { userAgent: USER_AGENT, serviceWorkers: 'block' as const, acceptDownloads: false };
const IG_ORIGIN = /^https:\/\/(?:www\.)?instagram\.com$/i;

type Cookie = Parameters<BrowserContext['addCookies']>[0][number];
function responseCookie(raw: string, url: URL): Cookie | null {
  const [pair, ...fields] = raw.split(';');
  const equals = pair.indexOf('=');
  if (equals < 1) return null;
  const cookie: Cookie = { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1), url: url.href, secure: true };
  const cookies = new Map(fields.map(field => {
    const [key, ...value] = field.trim().split('=');
    return [key.toLowerCase(), value.join('=')];
  }));
  const domain = cookies.get('domain')?.replace(/^\./, '').toLowerCase();
  if (domain && (!['instagram.com', 'www.instagram.com'].includes(domain) || url.hostname !== domain && !url.hostname.endsWith('.' + domain))) return null;
  const path = cookies.get('path');
  if (domain || path?.startsWith('/')) {
    delete cookie.url;
    cookie.domain = domain && domain !== url.hostname ? '.' + domain : url.hostname;
    cookie.path = path?.startsWith('/') ? path : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  }
  cookie.httpOnly = cookies.has('httponly');
  const sameSite = cookies.get('samesite')?.toLowerCase();
  if (sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none') cookie.sameSite = { lax: 'Lax', strict: 'Strict', none: 'None' }[sameSite] as Cookie['sameSite'];
  const age = cookies.get('max-age'), expires = Date.parse(cookies.get('expires') ?? '');
  if (age && /^-?\d+$/.test(age)) cookie.expires = Number(age) <= 0 ? 1 : Math.round(Date.now() / 1000) + Number(age);
  else if (Number.isFinite(expires)) cookie.expires = Math.max(1, Math.round(expires / 1000));
  return cookie;
}

function requestHeaders(headers: Record<string, string>, session: boolean) {
  const allowed = new Set(['accept', 'accept-language', 'content-type', 'range']);
  if (session) for (const name of ['cookie', 'origin', 'referer', 'x-csrftoken', 'x-ig-app-id', 'x-requested-with']) allowed.add(name);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => allowed.has(name)));
}
type BrowserOptions = { store: CollectorStore; dir: string; transport: OfferTransport; lane: 'instagram' | 'public';
  readOnly?: boolean; publicOrigin?: string; signal?: AbortSignal; onRedirect?: (source: string, destination: string) => void;
  read?: (url: string, headers: Record<string, string>, signal?: AbortSignal) => ReturnType<OfferTransport> };
export async function mediateBrowser(context: BrowserContext, options: BrowserOptions) {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([cancelled.signal, ...(options.signal ? [options.signal] : [])]);
  const { store, transport, lane } = options;
  await context.routeWebSocket('**/*', socket => { void socket.close(); });
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      if (url.protocol !== 'https:' || url.username || url.password || url.port) { await route.abort(); return; }
      const session = lane === 'instagram' && IG_ORIGIN.test(url.origin);
      if (sourceLane(url.href) !== lane || lane === 'public' && url.origin !== options.publicOrigin ||
        signal.aborted || lane === 'instagram' && instagramStopped(store)
        || (!session || options.readOnly) && !['GET', 'HEAD'].includes(request.method())) {
        await route.abort();
        return;
      }
      const headers = requestHeaders(await request.allHeaders(), session);
      const result = options.read ? await options.read(url.href, headers, signal)
        : await transport(url.href, { lane, headers, method: request.method(), body: request.postDataBuffer() ?? undefined,
          signal, maxBytes: ['media', 'image'].includes(request.resourceType()) ? 4_194_304 : 2_097_152 });
      if (lane === 'instagram' && instagramStopped(store)) {
        cancelled.abort();
        await route.abort();
        return;
      }
      if (result.status >= 300 && result.status < 400 && result.status !== 304) {
        const location = result.headers.location;
        const next = location && new URL(location, url);
        // Each allowed redirect becomes a new browser-intercepted request;
        // external destinations are transferred without browser headers.
        if (!next || (lane === 'public' ? next.origin !== options.publicOrigin : !IG_ORIGIN.test(next.origin) || !session)) {
          if (next) options.onRedirect?.(url.href, next.href);
          await route.abort();
          return;
        }
      }
      if (session) {
        const cookies = result.cookies.map(cookie => responseCookie(cookie, url)).filter((cookie): cookie is Cookie => !!cookie);
        if (cookies.length) await context.addCookies(cookies);
      }
      const outgoing = Object.fromEntries(Object.entries(result.headers).filter(([key]) => !['connection', 'transfer-encoding', 'content-length', 'alt-svc', 'link', 'refresh', 'nel', 'report-to'].includes(key)));
      await route.fulfill({ status: result.status, headers: outgoing, body: result.bytes });
    } catch { await route.abort().catch(() => {}); }
  });
}
