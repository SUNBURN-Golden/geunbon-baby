import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { once } from 'node:events';
import { validatedAddresses } from '../scheduler';
import type { CollectorStore } from '../store';
import { detectExplicit } from '../../engine/restricted';
import { USER_AGENT } from '../../lib/external/robots';
import { isGlobalEmergencyStop, isHostDomainStopped } from '../deepseek-web/domain-policy';
import { offerEvent, kstMidnight, exportOfferMetrics } from './metrics';

export type Lane = 'public' | 'threads' | 'instagram' | 'service';
export type TransportResponse = { status: number; headers: Record<string, string>; cookies: string[]; bytes: Buffer; body: string; finalUrl: string };
export class TransportError extends Error {
  constructor(readonly code: string, readonly retryAt?: number) { super(code); }
}
export type RequestOptions = {
  lane: Lane; signal?: AbortSignal; maxBytes?: number; headers?: Record<string, string>;
  method?: string; body?: string | Buffer; timeout?: number;
};
export function sourceLane(raw: string): Exclude<Lane, 'service'> {
  const host = new URL(raw).hostname;
  if (/(?:^|\.)(?:instagram\.com|cdninstagram\.com|fbcdn\.net)$/.test(host)) return 'instagram';
  if (/(?:^|\.)threads\.(?:net|com)$/.test(host)) return 'threads';
  return 'public';
}

export async function lockHost(dir: string, host: string, signal: AbortSignal) {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const file = join(dir, createHash('sha256').update(host).digest('hex'));
  // flock holds the inode while its command reads the parent pipe. Process death
  // closes that pipe even on SIGKILL. The lock files must keep their inode.
  const child = spawn('flock', ['--exclusive', file, 'sh', '-c', 'printf x; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const closed = once(child, 'close').catch(() => []);
  const abort = () => child.stdin.end();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const acquired = await Promise.race([once(child.stdout, 'data').then(() => true), closed.then(() => false)]);
    if (!acquired || signal.aborted) throw new TransportError('request_cancelled');
    signal.removeEventListener('abort', abort);
    return async () => {
      child.stdin.end();
      await closed;
      signal.removeEventListener('abort', abort);
    };
  } catch {
    child.kill();
    signal.removeEventListener('abort', abort);
    throw new TransportError('host_lock_unavailable');
  }
}

const headerValues = (headers: IncomingHttpHeaders) => Object.fromEntries(
  Object.entries(headers).filter(([name]) => name !== 'set-cookie').map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? '']),
);
const isProxySetupFailure = (error: unknown) => error instanceof TransportError && error.code === 'proxy_setup_failed';

function proxyTunnel(proxy: URL, address: string, port: number, signal: AbortSignal): Promise<Duplex> {
  const target = `${address.includes(':') ? `[${address}]` : address}:${port}`;
  return new Promise((resolve, reject) => {
    const proxyHeaders: Record<string, string> = { host: target, 'user-agent': USER_AGENT };
    if (proxy.username || proxy.password) {
      proxyHeaders['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    }
    const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxy.hostname, port: proxy.port || undefined, method: 'CONNECT', path: target,
      headers: proxyHeaders, signal, agent: false,
    });
    request.on('error', (error: NodeJS.ErrnoException) => reject(new TransportError(
      ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code ?? '')
        ? 'proxy_setup_failed' : 'proxy_connection_ambiguous',
    )));
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) {
        socket.destroy();
        // A proxy authentication or policy denial is a restriction, even if
        // the proxy has yet to contact the origin.
        reject(new TransportError([502,503,504].includes(response.statusCode ?? 0) && !head.length ?
          'proxy_setup_failed' : 'proxy_tunnel_denied'));
      } else resolve(socket);
    });
    request.end();
  });
}

function tlsPeer(url: URL, address: string, tunnel: Duplex | undefined, signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port: Number(url.port || '443'), servername: url.hostname, socket: tunnel, rejectUnauthorized: true });
    const abort = () => socket.destroy(new TransportError('request_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => reject(new TransportError('origin_connection_failed')));
    socket.once('close', () => {
      signal.removeEventListener('abort', abort);
      reject(new TransportError('origin_connection_failed'));
    });
    if (signal.aborted) abort();
    socket.once('secureConnect', () => {
      if (!tunnel && socket.remoteAddress !== address) {
        socket.destroy();
        reject(new TransportError('origin_peer_mismatch'));
      } else resolve(socket);
    });
  });
}

async function requestOrigin(url: URL, socket: TLSSocket, options: RequestOptions, signal: AbortSignal): Promise<TransportResponse> {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  try {
    return await new Promise((resolve, reject) => {
      const headers = { accept: '*/*', ...options.headers, 'user-agent': USER_AGENT, 'accept-encoding': 'identity' };
      const request = httpsRequest(url, { agent, headers, signal, method: options.method ?? 'GET' }, response => {
        const chunks: Buffer[] = [];
        let count = 0;
        response.on('data', (chunk: Buffer) => {
          count += chunk.length;
          if (count > (options.maxBytes ?? 1_048_576)) {
            reject(new TransportError('response_size'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => reject(new TransportError('origin_response_failed')));
        response.on('close', () => { if (!response.complete) reject(new TransportError('origin_response_failed')); });
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: response.statusCode ?? 500, headers: headerValues(response.headers), cookies: response.headers['set-cookie'] ?? [], bytes, body: bytes.toString('utf8'), finalUrl: url.href });
        });
      });
      request.on('error', () => reject(new TransportError('origin_request_failed')));
      request.end(options.body);
    });
  } finally {
    agent.destroy();
    if (!socket.closed) { socket.destroy(); await closed; }
  }
}

export function stopInstagram(store: CollectorStore, dir: string, reason: 'rate_limited' | 'checkpoint' | 'identity' | 'two_factor') {
  const now = store.now(), until = kstMidnight(now);
  store.transaction(() => {
    store.db.prepare("INSERT INTO offer_network_stops(host,reason,until) VALUES ('instagram',?,?) ON CONFLICT(host) DO UPDATE SET reason=excluded.reason,until=excluded.until")
      .run(reason, until);
    offerEvent(store, `instagram-stop:${until}`, 'instagram_stop', { reason, resume_at: until }, now);
  });
  exportOfferMetrics(store, dir);
}
export function instagramStopped(store: CollectorStore) {
  return !!store.db.prepare("SELECT 1 FROM offer_network_stops WHERE host = 'instagram' AND until > ?").get(store.now());
}
const restrictionPath = /\/(?:accounts\/login|login|checkpoint|challenge|auth_platform\/codeentry|two_factor)(?:\/|$)/i;
type TransportIo = {
  addresses?: typeof validatedAddresses;
  tunnel?: typeof proxyTunnel;
  request?: (url: URL, address: string, tunnel: Duplex | undefined, options: RequestOptions, signal: AbortSignal) => Promise<TransportResponse>;
};
const checkpointPath = /\/(?:checkpoint|challenge|auth_platform\/codeentry|two_factor)(?:\/|$)/i;
function instagramChallenge(result: TransportResponse): 'checkpoint' | 'identity' | 'two_factor' | null {
  const redirected = result.headers.location && new URL(result.headers.location, result.finalUrl).pathname;
  const body = result.body;
  if (/(?:^|\/)two_factor(?:\/|$)/i.test(redirected || '') || /two.factor (?:authentication|verification) required|input[^>]*autocomplete=["']one-time-code/i.test(body)) return 'two_factor';
  if (/identity check required|confirm (?:that )?it.s you|verify your identity|본인 확인/i.test(body)) return 'identity';
  if (checkpointPath.test(redirected || '') || /checkpoint[_ ]required|challenge[_ ]required|security check required|인증 코드|보안 코드/i.test(body)) return 'checkpoint';
  return null;
}
export function offerTransport(store: CollectorStore, dir: string, proxyOverride?: string, io: TransportIo = {}) {
  const proxyValue = proxyOverride ?? process.env.AGAMAJUNG_PUBLIC_PROXY;
  const proxy = proxyValue ? new URL(proxyValue) : null;
  if (proxy && (!['http:', 'https:'].includes(proxy.protocol) || proxy.hash || proxy.search || proxy.pathname !== '/')) throw new TransportError('invalid_proxy');
  return async (raw: string, options: RequestOptions): Promise<TransportResponse> => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new TransportError('unsafe_url');
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeout ?? 30_000), ...(options.signal ? [options.signal] : [])]);
    const lane = sourceLane(raw);
    if (options.lane !== 'service' && options.lane !== lane || options.lane === 'service' && lane !== 'public') throw new TransportError('wrong_reader');
    // Serialize all Instagram resources together, including the session and CDN
    // hosts. A stop applies before the next browser route may open a socket.
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const release = await lockHost(join(dir, 'host-locks'), lane === 'instagram' ? 'instagram' : host, signal);
    try {
      if (signal.aborted) throw new TransportError('request_cancelled');
      if (isGlobalEmergencyStop(store)) throw new TransportError('emergency_stop');
      if (lane === 'instagram' && instagramStopped(store)) throw new TransportError('instagram_stopped');
      if (isHostDomainStopped(store, host)) throw new TransportError('source_blocked');
      const stop = store.db.prepare('SELECT reason,until FROM offer_network_stops WHERE host=?').get(host) as { reason: string; until: number | null } | undefined;
      if (stop && (stop.until === null || stop.until > store.now())) throw new TransportError(stop.reason, stop.until ?? undefined);
      const [selected] = await (io.addresses ?? validatedAddresses)(url);
      let tunnel: Duplex | undefined;
      if (proxy && options.lane === 'public') {
        try { tunnel = await (io.tunnel ?? proxyTunnel)(proxy, selected.address, 443, signal); }
        catch (error) { if (!isProxySetupFailure(error)) throw error; }
      }
      const send = io.request ?? (async (target, address, proxySocket, request, abort) =>
        requestOrigin(target, await tlsPeer(target, address, proxySocket, abort), request, abort));
      const result = await send(url, selected.address, tunnel, options, signal);
      const now = store.now();
      const challenge = lane === 'instagram' ? instagramChallenge(result) : null;
      if (lane === 'instagram' && result.status === 429) stopInstagram(store, dir, 'rate_limited');
      else if (challenge) stopInstagram(store, dir, challenge);
      else if (result.status === 403 || result.status === 429) {
        const raw = result.headers['retry-after'] ?? '';
        const retry = /^\d{1,9}$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
        store.db.prepare('INSERT INTO offer_network_stops(host,reason,until) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET reason=excluded.reason,until=excluded.until')
          .run(host, 'source_backoff', retry > now ? retry : now + 60_000);
      } else if (options.lane !== 'service' && lane !== 'instagram' && /html/i.test(result.headers['content-type'] ?? '')) {
        const body = result.body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
        const restricted = detectExplicit({ ...result, body: body.replace(/reCAPTCHA/gi, '') });
        if (restricted === 'access_restricted') {
          store.db.prepare('INSERT INTO offer_network_stops(host,reason) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET reason=excluded.reason,until=NULL')
            .run(host, restricted);
        }
        if (restricted) throw new TransportError(restricted);
      }
      return result;
    } finally { await release(); }
  };
}
export type OfferTransport = ReturnType<typeof offerTransport>;
export const isAccessPath = (url: string) => restrictionPath.test(new URL(url).pathname);
