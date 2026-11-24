import { Agent, request } from 'node:https';

const agent = new Agent({ keepAlive: true });
const responseLimit = 2 * 1024 * 1024;

// Provider clients pin the destination. This transport uses its own TLS agent
// rather than the process-wide fetch dispatcher or environment proxy.
export function directHttps(url: string, init: RequestInit) {
  return new Promise<Response>((resolve, reject) => {
    const failed = () => reject(new Error('provider_transport_failed'));
    const req = request(url, {
      agent, method: 'POST', signal: init.signal ?? undefined, headers: Object.fromEntries(new Headers(init.headers)),
    }, incoming => {
      const status = incoming.statusCode ?? 502;
      if (status < 200 || status > 299) {
        incoming.destroy();
        resolve(new Response(null, { status: status >= 200 && status <= 599 ? status : 502 }));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= responseLimit) chunks.push(chunk);
        else {
          incoming.destroy();
          // Preserve successful HTTP acknowledgement for usage accounting.
          resolve(new Response(null, { status }));
        }
      });
      incoming.on('error', failed);
      incoming.on('end', () => {
        const body = status === 204 || status === 205 ? null : Buffer.concat(chunks).toString('utf8');
        resolve(new Response(body, { status }));
      });
    });
    req.on('error', failed);
    req.end(typeof init.body === 'string' ? init.body : undefined);
  });
}
