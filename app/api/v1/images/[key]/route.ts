import { environment } from '../../../../../lib/db';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp|avif)$/.test(key)) return new Response('Not found', { status: 404 });
  const object = await environment().IMAGES.get(`public/${key}`);
  if (!object) return new Response('Not found', { status: 404 });
  const ext = key.split('.').pop();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext;
  return new Response(object.body, { headers: { 'Content-Type': `image/${type}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600', ETag: object.httpEtag } });
}
