import type { Env } from './db';

export const PROVIDERS = ['google', 'kakao'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const SESSION_COOKIE = 'agamajung_session';
export const STATE_COOKIE = 'agamajung_oauth';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const STATE_SECONDS = 600;
const DEFAULT_ORIGIN = 'https://agamajoong.soulbound.co.kr';
type AuthEnv = Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'KAKAO_REST_KEY' | 'KAKAO_CLIENT_SECRET' | 'AUTH_ORIGIN'>;
export type Identity = { provider: Provider; providerUserId: string; email: string };
export type Session = { userId: string; email: string; createdAt: string; newsletterOptIn: boolean; consentedAt: string | null; withdrawnAt: string | null; providers: Provider[] };

const ENDPOINTS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email',
  },
  kakao: {
    authorize: 'https://kauth.kakao.com/oauth/authorize', token: 'https://kauth.kakao.com/oauth/token',
    userinfo: 'https://kapi.kakao.com/v2/user/me', scope: 'account_email',
  },
} as const;

export function configuredProviders(env: AuthEnv): Provider[] {
  const ready: Record<Provider, boolean> = { google: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET, kakao: !!env.KAKAO_REST_KEY };
  return PROVIDERS.filter(p => ready[p]);
}
const isProvider = (value: string | undefined): value is Provider => !!value && (PROVIDERS as readonly string[]).includes(value);
const origin = (env: AuthEnv) => (env.AUTH_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
export const redirectUri = (env: AuthEnv, provider: Provider) => `${origin(env)}/api/auth/callback/${provider}`;
const secure = (env: AuthEnv) => origin(env).startsWith('https://');

// ── 인코딩·암호 도우미 ──────────────────────────────────────────────────────
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const sha256Hex = async (value: string) => [...await sha256(value)].map(b => b.toString(16).padStart(2, '0')).join('');
export async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return x.reduce((n, v, i) => n | (v ^ y[i]), 0) === 0;
}

// ── 쿠키 ───────────────────────────────────────────────────────────────────
function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
const cookie = (env: AuthEnv, name: string, value: string, path: string, maxAge: number) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure(env) ? '; Secure' : ''}`;
type StateCookie = { state: string; verifier: string | null; newsletter: boolean };
const encodeState = (value: StateCookie) => b64url(new TextEncoder().encode(JSON.stringify(value)));
function decodeState(raw: string | undefined): StateCookie | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromB64url(raw ?? ''))) as Partial<StateCookie>;
    if (typeof value.state !== 'string' || !value.state || typeof value.newsletter !== 'boolean') return null;
    return { state: value.state, verifier: typeof value.verifier === 'string' ? value.verifier : null, newsletter: value.newsletter };
  } catch { return null; }
}

// ── 응답 ───────────────────────────────────────────────────────────────────
export function noStore(response: Response) { response.headers.set('Cache-Control', 'no-store'); return response; }
const notFound = () => noStore(new Response('Not found', { status: 404 }));
function redirect(location: string, cookies: string[]) {
  const headers = new Headers({ Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return noStore(new Response(null, { status: 302, headers }));
}

// ── 공급자 통신 (액세스 토큰은 userinfo 호출에만 쓰고 저장하지 않는다) ───────────
async function exchange(env: AuthEnv, provider: Provider, code: string, verifier: string | null): Promise<Identity | 'provider' | 'email'> {
  const endpoint = ENDPOINTS[provider];
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(env, provider) });
  if (provider === 'google') { body.set('client_id', env.GOOGLE_CLIENT_ID!); body.set('client_secret', env.GOOGLE_CLIENT_SECRET!); if (verifier) body.set('code_verifier', verifier); }
  else { body.set('client_id', env.KAKAO_REST_KEY!); if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET); }
  try {
    const tokenResponse = await fetch(endpoint.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (!tokenResponse.ok) return 'provider';
    const token = (await tokenResponse.json()) as { access_token?: unknown };
    if (typeof token.access_token !== 'string' || !token.access_token) return 'provider';
    const infoResponse = await fetch(endpoint.userinfo, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
    if (!infoResponse.ok) return 'provider';
    return parseUserinfo(provider, await infoResponse.json());
  } catch { return 'provider'; }
}
const cleanEmail = (value: unknown) => typeof value === 'string' && value.trim().length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim() : null;
const cleanId = (value: unknown) => typeof value === 'string' && value && value.length <= 128 ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
// 이메일·공급자 id·검증 여부만 읽는다.
export function parseUserinfo(provider: Provider, value: unknown): Identity | 'provider' | 'email' {
  if (!value || typeof value !== 'object') return 'provider';
  const info = value as Record<string, unknown>;
  if (provider === 'google') {
    const id = cleanId(info.sub); if (!id) return 'provider';
    const email = cleanEmail(info.email);
    return email && info.email_verified === true ? { provider, providerUserId: id, email } : 'email';
  }
  const id = cleanId(info.id); if (!id) return 'provider';
  const account = info.kakao_account;
  if (!account || typeof account !== 'object') return 'email';
  const a = account as Record<string, unknown>;
  const email = cleanEmail(a.email);
  return email && a.is_email_valid === true && a.is_email_verified === true ? { provider, providerUserId: id, email } : 'email';
}

// ── 사용자·세션 (D1) ────────────────────────────────────────────────────────
const findIdentity = (db: D1Database, identity: Identity) =>
  db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?').bind(identity.provider, identity.providerUserId).first<{ user_id: string }>();
export async function findOrCreateUser(db: D1Database, identity: Identity, newsletter: boolean, now: Date) {
  const existing = await findIdentity(db, identity);
  if (existing) return existing.user_id; // 재로그인은 뉴스레터 값을 바꾸지 않는다.
  const id = crypto.randomUUID(); const at = now.toISOString();
  try {
    await db.batch([
      db.prepare('INSERT INTO users (id, email, created_at, newsletter_opt_in, newsletter_consented_at) VALUES (?, ?, ?, ?, ?)').bind(id, identity.email, at, newsletter ? 1 : 0, newsletter ? at : null),
      db.prepare('INSERT INTO user_identities (provider, provider_user_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(identity.provider, identity.providerUserId, id, identity.email, at),
    ]);
    return id;
  } catch (error) {
    const raced = await findIdentity(db, identity); // 같은 공급자 id의 동시 콜백
    if (raced) return raced.user_id;
    throw error;
  }
}
export async function createSession(db: D1Database, userId: string, now: Date) {
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString()).run();
  return token;
}
export async function readSession(db: D1Database, token: string | undefined, now = new Date()): Promise<Session | null> {
  if (!token || token.length > 256) return null;
  const id = await sha256Hex(token);
  const row = await db.prepare('SELECT s.expires_at, u.id, u.email, u.created_at, u.newsletter_opt_in, u.newsletter_consented_at, u.newsletter_withdrawn_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .bind(id).first<{ expires_at: string; id: string; email: string; created_at: string; newsletter_opt_in: number; newsletter_consented_at: string | null; newsletter_withdrawn_at: string | null }>();
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) { await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run(); return null; }
  const identities = (await db.prepare('SELECT provider FROM user_identities WHERE user_id = ? ORDER BY created_at').bind(row.id).all<{ provider: Provider }>()).results;
  return { userId: row.id, email: row.email, createdAt: row.created_at, newsletterOptIn: row.newsletter_opt_in === 1, consentedAt: row.newsletter_consented_at, withdrawnAt: row.newsletter_withdrawn_at, providers: identities.map(i => i.provider) };
}
export async function deleteSession(db: D1Database, token: string | undefined) {
  if (token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}
export async function setNewsletter(db: D1Database, userId: string, optIn: boolean, now: Date) {
  const at = now.toISOString();
  if (optIn) await db.prepare('UPDATE users SET newsletter_opt_in = 1, newsletter_consented_at = ?, newsletter_withdrawn_at = NULL WHERE id = ? AND newsletter_opt_in = 0').bind(at, userId).run();
  else await db.prepare('UPDATE users SET newsletter_opt_in = 0, newsletter_withdrawn_at = ? WHERE id = ? AND newsletter_opt_in = 1').bind(at, userId).run();
}

// ── 라우트: GET login/{provider}, GET callback/{provider} ─────────────────────
export async function handleAuth(request: Request, parts: string[], env: Env, now = new Date()): Promise<Response> {
  const [action, name] = parts;
  if (parts.length !== 2 || (action !== 'login' && action !== 'callback') || request.method !== 'GET') return notFound();
  if (!isProvider(name) || !configuredProviders(env).includes(name)) return notFound();
  const url = new URL(request.url);
  const clear = cookie(env, STATE_COOKIE, '', '/api/auth/callback', 0);

  if (action === 'login') {
    const state = randomToken();
    const verifier = name === 'google' ? randomToken() : null;
    const endpoint = ENDPOINTS[name];
    const target = new URL(endpoint.authorize);
    target.searchParams.set('client_id', name === 'google' ? env.GOOGLE_CLIENT_ID! : env.KAKAO_REST_KEY!);
    target.searchParams.set('redirect_uri', redirectUri(env, name));
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', endpoint.scope);
    target.searchParams.set('state', state);
    if (verifier) { target.searchParams.set('code_challenge', b64url(await sha256(verifier))); target.searchParams.set('code_challenge_method', 'S256'); }
    const saved = cookie(env, STATE_COOKIE, encodeState({ state, verifier, newsletter: url.searchParams.has('newsletter') }), '/api/auth/callback', STATE_SECONDS);
    return redirect(target.toString(), [saved]);
  }

  const fail = (code: 'state' | 'denied' | 'email' | 'provider') => redirect(`${origin(env)}/login?error=${code}`, [clear]);
  const saved = decodeState(readCookie(request, STATE_COOKIE));
  const state = url.searchParams.get('state');
  if (!saved || !state || !await safeEqual(state, saved.state)) return fail('state');
  if (url.searchParams.has('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code) return fail('provider');
  const identity = await exchange(env, name, code, saved.verifier);
  if (typeof identity === 'string') return fail(identity);
  const userId = await findOrCreateUser(env.DB, identity, saved.newsletter, now);
  const token = await createSession(env.DB, userId, now);
  return redirect(`${origin(env)}/me`, [clear, cookie(env, SESSION_COOKIE, token, '/', SESSION_SECONDS)]);
}
