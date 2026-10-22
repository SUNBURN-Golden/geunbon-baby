import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configuredProviders, handleAuth, readSession, createSession, STATE_COOKIE, SESSION_COOKIE, setNewsletter } from '../lib/auth';
import type { Env } from '../lib/db';
import { memoryD1 } from './helpers/sqlite';

const ORIGIN = 'https://agamajoong.soulbound.co.kr';
const SECRETS = ['gsecret-fixture', 'ksecret-fixture'];
const NOW = new Date('2026-10-22T00:00:00.000Z');
let memory: ReturnType<typeof memoryD1>;
let env: Env;
type Mock = ReturnType<typeof vi.fn>;
let fetchMock: Mock;
let userinfo: Record<string, unknown>;
beforeEach(async () => {
  memory = memoryD1();
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) await memory.db.prepare(sql).run();
  }
  env = { DB: memory.db, GOOGLE_CLIENT_ID: 'gid-fixture', GOOGLE_CLIENT_SECRET: SECRETS[0], KAKAO_REST_KEY: 'krest-fixture', KAKAO_CLIENT_SECRET: SECRETS[1] } as Env;
  userinfo = { sub: 'g-1', email: 'a@example.com', email_verified: true };
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'access-fixture', refresh_token: 'refresh-fixture' });
    return Response.json(userinfo);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => memory.close());

const get = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const setCookies = (r: Response) => r.headers.getSetCookie();
const cookieValue = (r: Response, name: string) => setCookies(r).find(c => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);
async function login(provider: string, query = '') {
  const response = await handleAuth(get(`/api/auth/login/${provider}${query}`), ['login', provider], env, NOW);
  const location = new URL(response.headers.get('location')!);
  return { response, location, state: location.searchParams.get('state')!, cookie: `${STATE_COOKIE}=${cookieValue(response, STATE_COOKIE)}` };
}
async function callback(provider: string, params: Record<string, string>, cookie?: string) {
  return handleAuth(get(`/api/auth/callback/${provider}?${new URLSearchParams(params)}`, cookie), ['callback', provider], env, NOW);
}
async function signIn(provider: 'google' | 'kakao', query = '?newsletter=on') {
  const start = await login(provider, query);
  return callback(provider, { code: 'code-fixture', state: start.state }, start.cookie);
}
const count = async (table: string) => (await memory.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const kakaoInfo = (account: Record<string, unknown> | undefined) => ({ id: 777, kakao_account: account });
const goodKakao = { email: 'k@example.com', is_email_valid: true, is_email_verified: true };

test('login redirects to Google with fixed redirect_uri, scope, PKCE S256 and a Lax state cookie', async () => {
  const { response, location } = await login('google', '?newsletter=on');
  expect(response.status).toBe(302);
  expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
  expect(location.searchParams.get('scope')).toBe('openid email');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  expect(location.searchParams.get('code_challenge')).toBeTruthy();
  expect(location.searchParams.has('access_type')).toBe(false);
  expect(location.toString()).not.toContain(SECRETS[0]);
  const cookie = setCookies(response)[0];
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax'); expect(cookie).toContain('Path=/api/auth/callback'); expect(cookie).toContain('Secure');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('login redirects to Kakao with account_email scope and no PKCE', async () => {
  const { location } = await login('kakao');
  expect(`${location.origin}${location.pathname}`).toBe('https://kauth.kakao.com/oauth/authorize');
  expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/kakao`);
  expect(location.searchParams.get('scope')).toBe('account_email');
  expect(location.searchParams.get('client_id')).toBe('krest-fixture');
  expect(location.searchParams.has('code_challenge_method')).toBe(false);
});

test('AUTH_ORIGIN overrides the redirect origin and drops Secure for http', async () => {
  env.AUTH_ORIGIN = 'http://localhost:8787/';
  const { response, location } = await login('kakao');
  expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/auth/callback/kakao');
  expect(setCookies(response)[0]).not.toContain('Secure');
});

test('Google happy path creates one user, identity and session, then redirects to /me', async () => {
  const start = await login('google', '?newsletter=on');
  const response = await callback('google', { code: 'code-fixture', state: start.state }, start.cookie);
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/me`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect([await count('users'), await count('user_identities'), await count('sessions')]).toEqual([1, 1, 1]);
  const session = await readSession(memory.db, cookieValue(response, SESSION_COOKIE), NOW);
  expect(session).toMatchObject({ email: 'a@example.com', newsletterOptIn: true, providers: ['google'] });
  expect(setCookies(response).find(c => c.startsWith(`${STATE_COOKIE}=`))).toContain('Max-Age=0');
  const session_cookie = setCookies(response).find(c => c.startsWith(`${SESSION_COOKIE}=`))!;
  expect(session_cookie).toContain('HttpOnly'); expect(session_cookie).toContain('SameSite=Lax'); expect(session_cookie).toContain('Path=/'); expect(session_cookie).toContain(`Max-Age=${30 * 24 * 3600}`);
  // D1 stores only a hash of the session token, never the token itself.
  const stored = await memory.db.prepare('SELECT id FROM sessions').first<{ id: string }>();
  expect(stored!.id).not.toBe(cookieValue(response, SESSION_COOKIE));
});

test('token request carries the same redirect_uri; secrets only appear in token request bodies', async () => {
  const start = await login('google');
  const response = await callback('google', { code: 'code-fixture', state: start.state }, start.cookie);
  const [[tokenUrl, tokenInit], [infoUrl, infoInit]] = fetchMock.mock.calls as [string, RequestInit][];
  expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
  const body = tokenInit.body as URLSearchParams;
  expect(body.get('redirect_uri')).toBe(start.location.searchParams.get('redirect_uri'));
  expect(body.get('client_secret')).toBe(SECRETS[0]);
  expect(body.get('code')).toBe('code-fixture');
  expect(body.get('code_verifier')).toBeTruthy();
  expect(infoUrl).toBe('https://openidconnect.googleapis.com/v1/userinfo');
  expect(String(infoUrl)).not.toContain(SECRETS[0]);
  expect(JSON.stringify(infoInit)).not.toContain(SECRETS[0]);
  const everything = JSON.stringify([...response.headers]) + (await response.text());
  for (const leak of [...SECRETS, 'code-fixture', 'access-fixture', 'refresh-fixture']) expect(everything).not.toContain(leak);
  const stored = JSON.stringify([await memory.db.prepare('SELECT * FROM users').all(), await memory.db.prepare('SELECT * FROM user_identities').all(), await memory.db.prepare('SELECT * FROM sessions').all()]);
  for (const leak of [...SECRETS, 'code-fixture', 'access-fixture', 'refresh-fixture']) expect(stored).not.toContain(leak);
});

test('Kakao happy path sends the optional client secret and stores a numeric id as text', async () => {
  userinfo = kakaoInfo(goodKakao);
  const response = await signIn('kakao');
  expect(response.headers.get('location')).toBe(`${ORIGIN}/me`);
  const body = (fetchMock.mock.calls[0][1] as RequestInit).body as URLSearchParams;
  expect(body.get('client_id')).toBe('krest-fixture'); expect(body.get('client_secret')).toBe(SECRETS[1]);
  expect(body.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/kakao`);
  expect(fetchMock.mock.calls[1][0]).toBe('https://kapi.kakao.com/v2/user/me');
  expect(await memory.db.prepare('SELECT provider, provider_user_id FROM user_identities').first()).toEqual({ provider: 'kakao', provider_user_id: '777' });
});

test('Kakao client secret is omitted when not configured', async () => {
  delete env.KAKAO_CLIENT_SECRET; userinfo = kakaoInfo(goodKakao);
  await signIn('kakao');
  expect(((fetchMock.mock.calls[0][1] as RequestInit).body as URLSearchParams).has('client_secret')).toBe(false);
});

test.each(['missing cookie', 'mismatched state', 'missing state param'])('state failure (%s) never calls fetch and redirects to error=state', async name => {
  const start = await login('google');
  const params: Record<string, string> = { code: 'code-fixture' };
  if (name === 'mismatched state') params.state = 'other';
  if (name === 'missing cookie') params.state = start.state;
  const response = await callback('google', params, name === 'missing cookie' ? undefined : start.cookie);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=state`);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(setCookies(response)[0]).toContain('Max-Age=0');
  expect(await count('users') + await count('sessions')).toBe(0);
});

test('provider denial redirects to error=denied without creating anything', async () => {
  const start = await login('kakao');
  const response = await callback('kakao', { error: 'access_denied', state: start.state }, start.cookie);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=denied`);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(setCookies(response)[0]).toContain('Max-Age=0');
  expect(await count('users') + await count('sessions')).toBe(0);
});

test.each([
  ['google', { sub: 'g', email: 'a@example.com', email_verified: false }],
  ['google', { sub: 'g', email: 'a@example.com' }],
  ['google', { sub: 'g', email_verified: true }],
  ['kakao', kakaoInfo(undefined)],
  ['kakao', kakaoInfo({ is_email_valid: true, is_email_verified: true })],
  ['kakao', kakaoInfo({ email: 'k@example.com', is_email_valid: true, is_email_verified: false })],
  ['kakao', kakaoInfo({ email: 'k@example.com', is_email_valid: false, is_email_verified: true })],
] as const)('%s email requirements failing -> error=email, no user or session (%#)', async (provider, info) => {
  userinfo = info as Record<string, unknown>;
  const response = await signIn(provider);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=email`);
  expect(setCookies(response).find(c => c.startsWith(`${SESSION_COOKIE}=`))).toBeUndefined();
  expect(await count('users') + await count('user_identities') + await count('sessions')).toBe(0);
});

test('token endpoint failure and fetch exceptions map to error=provider', async () => {
  fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 400 }));
  expect((await signIn('google')).headers.get('location')).toBe(`${ORIGIN}/login?error=provider`);
  fetchMock.mockImplementationOnce(async () => { throw new Error('network'); });
  expect((await signIn('google')).headers.get('location')).toBe(`${ORIGIN}/login?error=provider`);
  expect(await count('users')).toBe(0);
});

test('unconfigured, unsupported and other paths are 404', async () => {
  env = { DB: memory.db, GOOGLE_CLIENT_ID: 'only-id' } as Env; // Google needs both id and secret
  expect(configuredProviders(env)).toEqual([]);
  for (const parts of [['login', 'google'], ['callback', 'google'], ['login', 'kakao'], ['login', 'naver'], ['callback', 'naver'], ['logout'], ['login'], [], ['login', 'google', 'x']]) {
    const response = await handleAuth(get('/api/auth/' + parts.join('/')), parts, env, NOW);
    expect(response.status, parts.join('/')).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  env = { DB: memory.db, KAKAO_REST_KEY: 'k' } as Env;
  expect(configuredProviders(env)).toEqual(['kakao']);
  expect((await handleAuth(get('/api/auth/login/google'), ['login', 'google'], env, NOW)).status).toBe(404);
  expect((await handleAuth(get('/api/auth/login/kakao'), ['login', 'kakao'], env, NOW)).status).toBe(302);
  expect((await handleAuth(new Request(`${ORIGIN}/api/auth/login/kakao`, { method: 'POST' }), ['login', 'kakao'], env, NOW)).status).toBe(404);
});

test('repeating the same provider id callback keeps one user; relogin keeps newsletter choice', async () => {
  await signIn('google', '?newsletter=on');
  const first = await memory.db.prepare('SELECT * FROM users').first();
  const again = await signIn('google', ''); // unchecked this time
  expect(again.status).toBe(302);
  expect(await count('users')).toBe(1); expect(await count('user_identities')).toBe(1); expect(await count('sessions')).toBe(2);
  expect(await memory.db.prepare('SELECT * FROM users').first()).toEqual(first);
});

test('unchecked newsletter at signup stores opt-out without a consent time', async () => {
  await signIn('google', '');
  expect(await memory.db.prepare('SELECT newsletter_opt_in AS o, newsletter_consented_at AS c FROM users').first()).toEqual({ o: 0, c: null });
});

test('checked newsletter at signup stores opt-in with the consent time', async () => {
  await signIn('google', '?newsletter=on');
  expect(await memory.db.prepare('SELECT newsletter_opt_in AS o, newsletter_consented_at AS c FROM users').first()).toEqual({ o: 1, c: NOW.toISOString() });
});

test('a concurrent duplicate identity insert falls back to the existing user', async () => {
  const identity = { provider: 'google', provider_user_id: 'g-1' };
  await memory.db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u-1','a@example.com','x')").run();
  await memory.db.prepare("INSERT INTO user_identities VALUES ('google','g-1','u-1','a@example.com','x')").run();
  const { findOrCreateUser } = await import('../lib/auth');
  // Simulate losing the race: the first lookup misses, the batch hits the PK conflict, the re-lookup finds u-1.
  const real = memory.db;
  let lookups = 0;
  const racy = { prepare: (sql: string) => {
    const statement = real.prepare(sql);
    if (!sql.startsWith('SELECT user_id FROM user_identities')) return statement;
    return { bind: (...v: never[]) => ({ first: async () => (lookups++ === 0 ? null : statement.bind(...v).first()) }) };
  }, batch: real.batch.bind(real) } as unknown as D1Database;
  expect(await findOrCreateUser(racy, { provider: 'google', providerUserId: identity.provider_user_id, email: 'a@example.com' }, true, NOW)).toBe('u-1');
  expect(await count('users')).toBe(1);
});

test('same email through another provider is a separate user', async () => {
  userinfo = { sub: 'g-1', email: 'same@example.com', email_verified: true };
  await signIn('google');
  userinfo = kakaoInfo({ ...goodKakao, email: 'same@example.com' });
  await signIn('kakao');
  expect(await count('users')).toBe(2); expect(await count('user_identities')).toBe(2);
});

test('sessions: expired rows are deleted, forged tokens are anonymous', async () => {
  await memory.db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u-1','a@example.com','x')").run();
  const token = await createSession(memory.db, 'u-1', NOW);
  expect(await readSession(memory.db, token, new Date(NOW.getTime() + 29 * 86400_000))).toMatchObject({ userId: 'u-1' });
  expect(await readSession(memory.db, token, new Date(NOW.getTime() + 31 * 86400_000))).toBeNull();
  expect(await count('sessions')).toBe(0);
  expect(await readSession(memory.db, 'forged-token', NOW)).toBeNull();
  expect(await readSession(memory.db, undefined, NOW)).toBeNull();
});

test('setNewsletter withdraws and resubscribes with timestamps', async () => {
  await signIn('google', '?newsletter=on');
  const { id } = (await memory.db.prepare('SELECT id FROM users').first<{ id: string }>())!;
  const later = new Date('2026-10-23T00:00:00.000Z');
  await setNewsletter(memory.db, id, false, later);
  expect(await memory.db.prepare('SELECT newsletter_opt_in o, newsletter_withdrawn_at w, newsletter_consented_at c FROM users').first()).toEqual({ o: 0, w: later.toISOString(), c: NOW.toISOString() });
  const latest = new Date('2026-10-24T00:00:00.000Z');
  await setNewsletter(memory.db, id, true, latest);
  expect(await memory.db.prepare('SELECT newsletter_opt_in o, newsletter_withdrawn_at w, newsletter_consented_at c FROM users').first()).toEqual({ o: 1, w: null, c: latest.toISOString() });
});

test('migration 0005 only contains CREATE statements and no semicolons in comments', async () => {
  const sql = await readFile(new URL('../migrations/0005_users.sql', import.meta.url), 'utf8');
  expect(sql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/i);
  expect(sql.split('\n').filter(l => l.startsWith('--')).join('')).not.toContain(';');
  expect(sql.match(/CREATE (TABLE|INDEX)/g)).toHaveLength(5);
});
