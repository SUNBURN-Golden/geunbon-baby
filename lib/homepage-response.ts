function acceptsJson(accept: string) {
  return accept.split(',').some(entry => {
    const [media, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => /^\s*q\s*=/.test(parameter))?.split('=')[1];
    return media.trim() === 'application/json' && (quality === undefined || Number(quality) > 0);
  });
}

export async function homepageResponse(request: Request, render: (request: Request) => Response | Promise<Response>) {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/') return render(request);
  if (!acceptsJson(request.headers.get('accept') ?? '')) {
    const response = await render(request);
    const headers = new Headers(response.headers);
    if (!headers.get('vary')?.split(',').some(value => ['accept', '*'].includes(value.trim().toLowerCase()))) {
      headers.append('Vary', 'Accept');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  const headers = new Headers(request.headers);
  headers.set('Accept', 'text/html');
  for (const name of ['if-none-match', 'if-modified-since', 'range']) headers.delete(name);
  const failure = () => Response.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store', Vary: 'Accept' } });
  try {
    const response = await render(new Request(request, { headers }));
    const reader = response.body?.getReader();
    if (!reader) return failure();
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/html') {
      void reader.cancel().catch(() => {});
      return failure();
    }
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        void reader.cancel().catch(() => {});
        return failure();
      }
    }
    if (!size) return failure();
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store', Vary: 'Accept' } });
  } catch {
    return failure();
  }
}
