import { alertAnchor, isPlaceholderSeller, type AlertStatus, type AlertTargetType } from './alert-target';
import { homeCopy } from './copy/home.ko';
import { readBoundedBody } from './request-body';

const ALERT_BODY_LIMIT = 32 * 1024;
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function parseEmail(input: unknown) {
  if (typeof input !== 'string') return null;
  const email = input.trim();
  if (email.length > 254) return null;
  const [local, domain, ...rest] = email.split('@');
  if (!local || !domain || rest.length || local.length > 64 ||
      !/^[a-z\d!#$%&'*+\-/=?^_`{|}~.]+$/i.test(local) || /^\.|\.\.|\.$/.test(local) ||
      !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(domain)) return null;
  return { email, key: `${local}@${domain.toLowerCase()}` };
}

function parseTarget(type: unknown, id: unknown): { type: AlertTargetType; id: string } | null {
  if ((type !== 'model' && type !== 'seller') || typeof id !== 'string' ||
      !/^[\p{L}\p{N}._-]{1,200}$/u.test(id) || id === '.' || id === '..' || (type === 'seller' && isPlaceholderSeller(id))) return null;
  return { type, id };
}

function nativeRedirect(type: AlertTargetType, id: string, status: AlertStatus) {
  const query = new URLSearchParams({ alert: status });
  const path = type === 'model' ? `/models/${encodeURIComponent(id)}` : '/sellers';
  if (type === 'seller') query.set('alert_seller', id);
  return new Response(null, {
    status: 303,
    headers: { ...responseHeaders, Location: `${path}?${query}#${encodeURIComponent(alertAnchor(type, id))}` },
  });
}

export async function captureAlert(request: Request, db: D1Database) {
  const media = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const native = media === 'application/x-www-form-urlencoded';
  const respond = (status: AlertStatus, code: number, target?: NonNullable<ReturnType<typeof parseTarget>>) => {
    if (native) {
      if (target) return nativeRedirect(target.type, target.id, status);
      return new Response(homeCopy.alert[status], { status: code, headers: { ...responseHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return Response.json({ result: status }, { status: code, headers: responseHeaders });
  };
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...responseHeaders, Allow: 'POST' } });
  let values: Record<string, unknown>;
  try {
    if (!native && media !== 'application/json') return respond('invalid', 415);
    const body = await readBoundedBody(request, ALERT_BODY_LIMIT);
    if (native) {
      const form = new URLSearchParams(body);
      if (['email', 'target_type', 'target_id'].some(key => form.getAll(key).length !== 1)) return respond('invalid', 400);
      values = Object.fromEntries(form);
    } else {
      values = JSON.parse(body);
      if (!values || typeof values !== 'object' || Array.isArray(values)) return respond('invalid', 400);
    }
  } catch {
    return respond('invalid', 400);
  }
  const target = parseTarget(values.target_type, values.target_id);
  if (!target) return respond('target', 400);
  const address = parseEmail(values.email);
  if (!address) return respond('invalid', 400, target);
  const column = target.type === 'model' ? 'model_id' : 'seller_id';
  const table = target.type === 'model' ? 'models' : 'sellers';
  try {
    // A no-op update returns the same receipt for an existing subscription.
    // INSERT SELECT keeps target validation and the write in the same statement.
    const saved = await db.prepare(`
      INSERT INTO alert_subscriptions(email, email_key, created_at, ${column})
      SELECT ?, ?, ?, id FROM ${table} WHERE id = ?
      ON CONFLICT(${column}, email_key) WHERE ${column} IS NOT NULL
      DO UPDATE SET email_key = excluded.email_key RETURNING id
    `).bind(address.email, address.key, new Date().toISOString(), target.id).all<{ id: number }>();
    if (!saved.success) return respond('retry', 503, target);
    if (!saved.results.length) return respond('target', 404);
    return respond('success', 200, target);
  } catch {
    return respond('retry', 503, target);
  }
}
