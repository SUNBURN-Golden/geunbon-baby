import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdir, readFile } from 'node:fs/promises';
import { RequestCookies, ResponseCookies, parseSetCookie, type ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import { memoryD1 } from './helpers/sqlite';

const COOKIE = 'agamajung_admin';
const TOKEN = 'fixture-admin-token-session-regression';
const context = vi.hoisted(() => ({
  db: undefined as D1Database | undefined,
  store: undefined as { get: RequestCookies['get']; set: ResponseCookies['set']; delete: ResponseCookies['delete'] } | undefined,
}));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'fixture-admin-token-session-regression', INGEST_TOKEN: 'fixture-ingest-token-session-regression' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => context.store }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); } }));

// A same-host browser jar: deletion must match BOTH name and path. Responses are
// applied only after serialization, including ResponseCookies' replacement by name.
class BrowserJar {
  cookies = new Map<string, ResponseCookie>();
  apply(headers: string[]) {
    for (const header of headers) {
      const cookie = parseSetCookie(header)!;
      const key = `${cookie.name}:${cookie.path ?? '/'}`;
      if ((cookie.maxAge !== undefined && cookie.maxAge <= 0) || (cookie.expires !== undefined && Number(cookie.expires) <= Date.now())) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }
  request(path = '/admin') {
    return [...this.cookies.values()].filter(cookie => {
      const scope = cookie.path ?? '/';
      return path === scope || (path.startsWith(scope) && (scope.endsWith('/') || path[scope.length] === '/'));
    }).map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; ');
  }
}

let memory: ReturnType<typeof memoryD1>;
let jar: BrowserJar;
let headers: Headers;
function startRequest() {
  headers = new Headers();
  const request = new RequestCookies(new Headers({ cookie: jar.request() }));
  const response = new ResponseCookies(headers);
  context.store = { get: request.get.bind(request), set: response.set.bind(response), delete: response.delete.bind(response) };
}
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  jar = new BrowserJar(); startRequest();
  memory = memoryD1(); context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) await memory.db.prepare(sql).run();
  }
});
afterEach(() => memory.close());

type Props = { children?: ReactNode; name?: string; action?: (form: FormData) => Promise<void> };
function forms(node: ReactNode): { action: (form: FormData) => Promise<void>; html: string }[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<Props>(child)) return [];
    if (child.type === 'form') return [{ action: child.props.action!, html: renderToStaticMarkup(child) }];
    return forms(child.props.children);
  });
}
async function page() {
  startRequest();
  return Admin({ searchParams: Promise.resolve({}) });
}
async function login() {
  const action = forms(await page()).find(form => form.html.includes('name="token"'))!.action;
  const form = new FormData(); form.set('token', TOKEN);
  startRequest();
  await expect(action(form)).rejects.toThrow('NEXT_REDIRECT:/admin');
  const final = headers.getSetCookie(); jar.apply(final);
  return final;
}
async function logout() {
  const action = forms(await page()).find(form => form.html.includes('로그아웃'))!.action;
  startRequest();
  await expect(action(new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin');
  const final = headers.getSetCookie(); jar.apply(final);
  return final;
}
function adminHeader(final: string[]) {
  const matching = final.filter(header => header.startsWith(`${COOKIE}=`));
  expect(matching).toHaveLength(1);
  return matching[0];
}
function attributes(header: string) {
  return Object.fromEntries(header.split('; ').slice(1).map(attribute => {
    const equals = attribute.indexOf('=');
    return equals < 0 ? [attribute, true] : [attribute.slice(0, equals), attribute.slice(equals + 1)];
  }));
}

test.each(['test', 'production'])('login keeps its scoped cookie attributes in %s', async env => {
  vi.stubEnv('NODE_ENV', env);
  const header = adminHeader(await login());
  expect(header.startsWith(`${COOKIE}=${TOKEN};`)).toBe(true);
  expect(attributes(header)).toEqual({ Path: '/admin', Expires: expect.any(String), 'Max-Age': '3600', HttpOnly: true, SameSite: 'strict', ...(env === 'production' ? { Secure: true } : {}) });
});

test.each(['test', 'production'])('logout serializes exactly one scoped expiry with matching attributes in %s', async env => {
  vi.stubEnv('NODE_ENV', env);
  const issued = attributes(adminHeader(await login()));
  const final = await logout();
  const header = adminHeader(final);
  expect(header.startsWith(`${COOKIE}=;`)).toBe(true);
  expect(attributes(header)).toEqual({ ...issued, Expires: 'Thu, 01 Jan 1970 00:00:00 GMT', 'Max-Age': '0' });
  expect(final.filter(value => value.startsWith(`${COOKIE}=`)).some(value => /(?:^|; )Path=\/(?:;|$)/.test(value))).toBe(false);
});

test('logout clears the browser jar and the next /admin request renders the login form', async () => {
  await login();
  expect(jar.cookies.has(`${COOKIE}:/admin`)).toBe(true);
  await logout();
  expect(jar.cookies.has(`${COOKIE}:/admin`)).toBe(false);
  const html = renderToStaticMarkup(await page());
  expect(html).toContain('ADMIN_TOKEN<input');
  expect(html).toContain('type="password"');
  expect(html).not.toContain('게시 전 검수');
});

test('stale review and dismiss actions reject the logged-out browser without changing rows', async () => {
  await memory.db.prepare("INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES ('item-1','https://www.instagram.com/p/fixture-logout/','fixture','synthetic fixture','post','2026-10-22T00:00:00.000Z')").run();
  await memory.db.prepare("INSERT INTO external_candidates (id,source,source_url,title,text,captured_at,last_seen_at) VALUES ('cand-1','pangpang','https://09pangpang.com/deal/fixture-logout','synthetic fixture','synthetic fixture','2026-10-22T00:00:00.000Z','2026-10-22T00:00:00.000Z')").run();
  await login();
  const stale = forms(await page());
  const review = stale.find(form => form.html.includes('name="id"'))!.action;
  const dismiss = stale.find(form => form.html.includes('name="candidate_id"'))!.action;
  await logout();
  const approval = new FormData(); approval.set('id', 'item-1'); approval.set('action', 'approve');
  startRequest();
  await expect(review(approval)).rejects.toThrow('NEXT_REDIRECT:/admin?error=auth');
  const candidate = new FormData(); candidate.set('candidate_id', 'cand-1');
  startRequest();
  await expect(dismiss(candidate)).rejects.toThrow('NEXT_REDIRECT:/admin?error=auth');
  expect(await memory.db.prepare('SELECT status FROM ingested_items WHERE id = ?').bind('item-1').first()).toEqual({ status: 'pending' });
  expect(await memory.db.prepare('SELECT status FROM external_candidates WHERE id = ?').bind('cand-1').first()).toEqual({ status: 'candidate' });
});
