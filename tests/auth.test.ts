import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configuredProviders, handleAuth, readSession, createSession, STATE_COOKIE, SESSION_COOKIE, setNewsletter, deleteSession } from '../lib/auth';
import type { Env } from '../lib/db';
import { GET } from '../app/api/auth/[[...path]]/route';
import { memoryD1 } from './helpers/sqlite';

const ORIGIN = 'https://agamajoong.soulbound.co.kr';
const SECRETS = ['gsecret-fixture', 'ksecret-fixture'];
const NOW = new Date('2026-10-22T00:00:00.000Z');
let memory: ReturnType<typeof memoryD1>;
// Deliberately model obsolete bindings that may still exist at runtime.
type LegacyEnv = Env & { KAKAO_REST_KEY?: string; KAKAO_CLIENT_SECRET?: string };
let env: LegacyEnv;
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => env,
}));
type Mock = ReturnType<typeof vi.fn>;
let fetchMock: Mock;
let userinfo: Record<string, unknown>;
beforeEach(async () => {
  memory = memoryD1();
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) await memory.db.prepare(sql).run();
  }
  env = { DB: memory.db, GOOGLE_CLIENT_ID: 'gid-fixture', GOOGLE_CLIENT_SECRET: SECRETS[0], KAKAO_REST_KEY: 'krest-fixture', KAKAO_CLIENT_SECRET: SECRETS[1] } as LegacyEnv;
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
async function signIn(provider: 'google', query = '?newsletter=on') {
  const start = await login(provider, query);
  return callback(provider, { code: 'code-fixture', state: start.state }, start.cookie);
}
const count = async (table: string) => (await memory.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
async function seedKakao() {
  await memory.db.prepare('INSERT INTO users (id, email, created_at, newsletter_opt_in, newsletter_consented_at) VALUES (?, ?, ?, 1, ?)')
    .bind('historical', 'same@example.com', NOW.toISOString(), NOW.toISOString()).run();
  await memory.db.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?, ?)')
    .bind('kakao', '777', 'historical', 'same@example.com', NOW.toISOString()).run();
}

const configurations: { settings: Partial<LegacyEnv>; expected: string[] }[] = [
  { settings: {}, expected: [] },
  { settings: { GOOGLE_CLIENT_ID: 'gid' }, expected: [] },
  { settings: { GOOGLE_CLIENT_SECRET: 'gsecret' }, expected: [] },
  { settings: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'gsecret' }, expected: [] },
  { settings: { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: '' }, expected: [] },
  { settings: { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' }, expected: ['google'] },
  { settings: { KAKAO_REST_KEY: 'krest', KAKAO_CLIENT_SECRET: SECRETS[1] }, expected: [] },
  { settings: { GOOGLE_CLIENT_ID: 'gid', KAKAO_REST_KEY: 'krest', KAKAO_CLIENT_SECRET: SECRETS[1] }, expected: [] },
  { settings: { GOOGLE_CLIENT_SECRET: 'gsecret', KAKAO_REST_KEY: 'krest' }, expected: [] },
  { settings: { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', KAKAO_REST_KEY: 'krest', KAKAO_CLIENT_SECRET: SECRETS[1] }, expected: ['google'] },
];
test.each(configurations)('configuration enables only complete Google credentials (%#)', async ({ settings, expected }) => {
  env = { DB: memory.db, ...settings } as LegacyEnv;
  expect(configuredProviders(env)).toEqual(expected);
  const response = await handleAuth(get('/api/auth/login/google'), ['login', 'google'], env, NOW);
  expect(response.status).toBe(expected.length ? 302 : 404);
  expect(response.headers.get('cache-control')).toBe('no-store');
  if (!expected.length) {
    expect((await callback('google', { code: 'code-fixture', state: 'old-state' })).status).toBe(404);
  }
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await count('sessions')).toBe(0);
});

test.each(['handleAuth', 'GET'] as const)('%s rejects Kakao before any DB access or provider request, including legacy state', async entrypoint => {
  const oldState = Buffer.from(JSON.stringify({ state: 'old-state', verifier: null, newsletter: true })).toString('base64url');
  const dbAccess = vi.fn(() => { throw new Error('Disabled provider must not access DB'); });
  for (const googleConfigured of [false, true]) {
    env = { KAKAO_REST_KEY: 'krest', KAKAO_CLIENT_SECRET: SECRETS[1],
      ...(googleConfigured ? { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: SECRETS[0] } : {}),
    } as LegacyEnv;
    Object.defineProperty(env, 'DB', { get: dbAccess });
    for (const action of ['login', 'callback']) {
      for (const stateCookie of [undefined, `${STATE_COOKIE}=malformed`, `${STATE_COOKIE}=${oldState}`]) {
        const parts = [action, 'kakao'];
        const request = get(`/api/auth/${action}/kakao?code=legacy-code&state=old-state&newsletter=on`, stateCookie);
        const response = entrypoint === 'GET'
          ? await GET(request, { params: Promise.resolve({ path: parts }) })
          : await handleAuth(request, parts, env, NOW);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.has('location')).toBe(false);
        expect(setCookies(response)).toEqual([]);
        expect(await response.text()).toBe('Not found');
      }
    }
  }
  expect(dbAccess).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await count('users') + await count('user_identities') + await count('sessions')).toBe(0);
});

test('exported GET handler completes Google authentication using the configured origin', async () => {
  const start = await GET(new Request('https://untrusted.example/api/auth/login/google?newsletter=on'), { params: Promise.resolve({ path: ['login', 'google'] }) });
  const location = new URL(start.headers.get('location')!);
  expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
  const params = new URLSearchParams({ code: 'code-fixture', state: location.searchParams.get('state')! });
  const completed = await GET(new Request(`https://untrusted.example/api/auth/callback/google?${params}`, {
    headers: { cookie: `${STATE_COOKIE}=${cookieValue(start, STATE_COOKIE)}` },
  }), { params: Promise.resolve({ path: ['callback', 'google'] }) });
  expect(completed.status).toBe(302);
  expect(completed.headers.get('location')).toBe(`${ORIGIN}/me`);
  expect(completed.headers.get('cache-control')).toBe('no-store');
  expect(await readSession(memory.db, cookieValue(completed, SESSION_COOKIE))).toMatchObject({ providers: ['google'], newsletterOptIn: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

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

test('AUTH_ORIGIN overrides the redirect origin and drops Secure for http', async () => {
  env.AUTH_ORIGIN = 'http://localhost:8787/';
  const { response, location, state, cookie } = await login('google');
  expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/auth/callback/google');
  expect(setCookies(response)[0]).not.toContain('Secure');
  const completed = await callback('google', { code: 'code-fixture', state }, cookie);
  expect(completed.headers.get('location')).toBe('http://localhost:8787/me');
  expect(setCookies(completed).every(c => !c.includes('Secure'))).toBe(true);
  expect(((fetchMock.mock.calls[0][1] as RequestInit).body as URLSearchParams).get('redirect_uri')).toBe('http://localhost:8787/api/auth/callback/google');
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
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!))).toString('base64url');
  expect(challenge).toBe(start.location.searchParams.get('code_challenge'));
  expect(infoUrl).toBe('https://openidconnect.googleapis.com/v1/userinfo');
  expect(String(infoUrl)).not.toContain(SECRETS[0]);
  expect(JSON.stringify(infoInit)).not.toContain(SECRETS[0]);
  const everything = JSON.stringify([...response.headers]) + (await response.text());
  for (const leak of [...SECRETS, 'code-fixture', 'access-fixture', 'refresh-fixture']) expect(everything).not.toContain(leak);
  const stored = JSON.stringify([await memory.db.prepare('SELECT * FROM users').all(), await memory.db.prepare('SELECT * FROM user_identities').all(), await memory.db.prepare('SELECT * FROM sessions').all()]);
  for (const leak of [...SECRETS, 'code-fixture', 'access-fixture', 'refresh-fixture']) expect(stored).not.toContain(leak);
});

test.each(['missing cookie', 'malformed cookie', 'mismatched state', 'missing state param'])('state failure (%s) never calls fetch and redirects to error=state', async name => {
  const start = await login('google');
  const params: Record<string, string> = { code: 'code-fixture' };
  if (name === 'mismatched state') params.state = 'other';
  if (name === 'missing cookie' || name === 'malformed cookie') params.state = start.state;
  const response = await callback('google', params, name === 'missing cookie' ? undefined : name === 'malformed cookie' ? `${STATE_COOKIE}=invalid` : start.cookie);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=state`);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(setCookies(response)[0]).toContain('Max-Age=0');
  expect(await count('users') + await count('sessions')).toBe(0);
});

test('provider denial redirects to error=denied without creating anything', async () => {
  const start = await login('google');
  const response = await callback('google', { error: 'access_denied', state: start.state }, start.cookie);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=denied`);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(setCookies(response)[0]).toContain('Max-Age=0');
  expect(await count('users') + await count('sessions')).toBe(0);
});

test.each([
  { sub: 'g', email: 'a@example.com', email_verified: false },
  { sub: 'g', email: 'a@example.com' },
  { sub: 'g', email_verified: true },
  { sub: 'g', email: 'not-an-email', email_verified: true },
  { sub: 'g', email: 'a@example.com', email_verified: 'true' },
])('Google email requirements failing -> error=email, no user or session (%#)', async info => {
  userinfo = info;
  const response = await signIn('google');
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

test.each(['missing code', 'missing token', 'userinfo failure', 'invalid userinfo', 'missing id'] as const)('Google callback handles %s without issuing a session or disclosing credentials', async failure => {
  if (failure === 'missing token') fetchMock.mockImplementationOnce(async () => Response.json({}));
  if (failure === 'userinfo failure') fetchMock.mockImplementation(async (url: string) => url.includes('/token')
    ? Response.json({ access_token: 'access-fixture' }) : new Response('access-fixture', { status: 503 }));
  if (failure === 'invalid userinfo') fetchMock.mockImplementation(async (url: string) => url.includes('/token')
    ? Response.json({ access_token: 'access-fixture' }) : Response.json(null));
  if (failure === 'missing id') userinfo = { email: 'a@example.com', email_verified: true };
  const start = await login('google');
  const params: Record<string, string> = { state: start.state };
  if (failure !== 'missing code') params.code = 'code-fixture';
  const response = await callback('google', params, start.cookie);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=provider`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(setCookies(response)).toHaveLength(1);
  expect(setCookies(response)[0]).toContain(`${STATE_COOKIE}=;`);
  const output = JSON.stringify([...response.headers]) + await response.text();
  for (const leak of [...SECRETS, 'code-fixture', 'access-fixture']) expect(output).not.toContain(leak);
  expect(await count('users') + await count('user_identities') + await count('sessions')).toBe(0);
  if (failure === 'missing code') expect(fetchMock).not.toHaveBeenCalled();
});

test('unconfigured, unsupported and other paths are 404', async () => {
  env = { DB: memory.db, GOOGLE_CLIENT_ID: 'only-id' } as LegacyEnv; // Google needs both id and secret
  expect(configuredProviders(env)).toEqual([]);
  for (const parts of [['login', 'google'], ['callback', 'google'], ['login', 'kakao'], ['login', 'naver'], ['callback', 'naver'], ['logout'], ['login'], [], ['login', 'google', 'x']]) {
    const response = await handleAuth(get('/api/auth/' + parts.join('/')), parts, env, NOW);
    expect(response.status, parts.join('/')).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect((await handleAuth(new Request(`${ORIGIN}/api/auth/login/google`, { method: 'POST' }), ['login', 'google'], env, NOW)).status).toBe(404);
});

test.each([['?newsletter=on', ''], ['', '?newsletter=on']])('relogin preserves newsletter choice and timestamps (%s -> %s)', async (firstChoice, nextChoice) => {
  await signIn('google', firstChoice);
  const first = await memory.db.prepare('SELECT * FROM users').first();
  const again = await signIn('google', nextChoice);
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

test('same-email Google login creates a separate account and preserves historical Kakao records and session', async () => {
  await seedKakao();
  const token = await createSession(memory.db, 'historical', NOW);
  const historical = async () => [
    await memory.db.prepare("SELECT * FROM users WHERE id = 'historical'").first(),
    await memory.db.prepare("SELECT * FROM user_identities WHERE provider = 'kakao'").all(),
    await memory.db.prepare("SELECT * FROM sessions WHERE user_id = 'historical'").all(),
  ];
  const before = await historical();
  const session = await readSession(memory.db, token, NOW);
  expect(session).toMatchObject({ userId: 'historical', providers: ['kakao'], newsletterOptIn: true });
  userinfo = { sub: 'g-1', email: 'same@example.com', email_verified: true };
  const response = await signIn('google', '');
  expect(await count('users')).toBe(2); expect(await count('user_identities')).toBe(2);
  expect(await historical()).toEqual(before);
  expect(await readSession(memory.db, token, NOW)).toEqual(session);
  const google = await readSession(memory.db, cookieValue(response, SESSION_COOKIE), NOW);
  expect(google).toMatchObject({ email: 'same@example.com', providers: ['google'], newsletterOptIn: false });
  expect(google!.userId).not.toBe('historical');
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

test('historical Kakao sessions retain newsletter controls until normal logout or expiry', async () => {
  await seedKakao();
  const token = await createSession(memory.db, 'historical', NOW);
  const later = new Date('2026-10-23T00:00:00.000Z');
  await setNewsletter(memory.db, 'historical', false, later);
  expect(await readSession(memory.db, token, later)).toMatchObject({ providers: ['kakao'], newsletterOptIn: false, consentedAt: NOW.toISOString(), withdrawnAt: later.toISOString() });
  await setNewsletter(memory.db, 'historical', true, later);
  expect(await readSession(memory.db, token, later)).toMatchObject({ providers: ['kakao'], newsletterOptIn: true, consentedAt: later.toISOString(), withdrawnAt: null });
  // Additional sessions model records issued before Kakao was disabled.
  const expires = await createSession(memory.db, 'historical', NOW);
  await deleteSession(memory.db, token);
  expect(await readSession(memory.db, token, later)).toBeNull();
  expect(await readSession(memory.db, expires, new Date(NOW.getTime() + 31 * 86400_000))).toBeNull();
  expect(await count('sessions')).toBe(0);
  expect(await count('users')).toBe(1); expect(await count('user_identities')).toBe(1);
  expect((await handleAuth(get('/api/auth/login/kakao'), ['login', 'kakao'], env, later)).status).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('setNewsletter withdraws and resubscribes with timestamps', async () => {
  await signIn('google', '?newsletter=on');
  const { id } = (await memory.db.prepare('SELECT id FROM users').first<{ id: string }>())!;
  const later = new Date('2026-10-23T00:00:00.000Z');
  await setNewsletter(memory.db, id, false, later);
  const row = () => memory.db.prepare('SELECT newsletter_opt_in o, newsletter_withdrawn_at w, newsletter_consented_at c FROM users').first();
  const withdrawn = { o: 0, w: later.toISOString(), c: NOW.toISOString() };
  expect(await row()).toEqual(withdrawn);
  const latest = new Date('2026-10-24T00:00:00.000Z');
  await setNewsletter(memory.db, id, false, latest);
  expect(await row()).toEqual(withdrawn); // repeated withdrawal does not change timestamps
  await signIn('google', '?newsletter=on');
  expect(await row()).toEqual(withdrawn); // login never resubscribes a returning account
  await setNewsletter(memory.db, id, true, latest);
  const subscribed = { o: 1, w: null, c: latest.toISOString() };
  expect(await row()).toEqual(subscribed);
  await setNewsletter(memory.db, id, true, new Date('2026-10-25T00:00:00.000Z'));
  expect(await row()).toEqual(subscribed); // repeated consent does not change timestamps
  await signIn('google', '');
  expect(await row()).toEqual(subscribed);
});

test('migration 0005 only contains CREATE statements and no semicolons in comments', async () => {
  const sql = await readFile(new URL('../migrations/0005_users.sql', import.meta.url), 'utf8');
  expect(sql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/i);
  expect(sql.split('\n').filter(l => l.startsWith('--')).join('')).not.toContain(';');
  expect(sql.match(/CREATE (TABLE|INDEX)/g)).toHaveLength(5);
});
