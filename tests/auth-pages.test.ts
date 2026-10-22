import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Login from '../app/login/page';
import Me from '../app/me/page';
import Layout from '../app/layout';
import { createSession, SESSION_COOKIE } from '../lib/auth';
import { authCopy } from '../lib/auth-copy';
import { memoryD1 } from './helpers/sqlite';

type Props = { children?: ReactNode; [key: string]: unknown };
const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, env: {} as Record<string, string>, session: undefined as string | undefined, deleted: [] as string[] }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ...context.env }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => name === 'agamajung_session' && context.session ? { value: context.session } : undefined, delete: (name: string) => { context.deleted.push(name); context.session = undefined; } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
  usePathname: () => '/', useSearchParams: () => new URLSearchParams(),
}));
let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  context.env = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', KAKAO_REST_KEY: 'krest' };
  context.session = undefined; context.deleted = [];
  memory = memoryD1(); context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) await memory.db.prepare(sql).run();
  }
});
afterEach(() => memory.close());

// Collect every element matching the predicate, remembering its ancestor chain.
function find(node: ReactNode, match: (el: ReactElement<Props>) => boolean, ancestors: ReactElement<Props>[] = []): { el: ReactElement<Props>; ancestors: ReactElement<Props>[] }[] {
  const found: { el: ReactElement<Props>; ancestors: ReactElement<Props>[] }[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Props>(child)) continue;
    if (match(child)) found.push({ el: child, ancestors });
    found.push(...find(child.props.children, match, [...ancestors, child]));
  }
  return found;
}
const checkboxes = (page: ReactNode) => find(page, el => el.type === 'input' && el.props.type === 'checkbox');
const buttons = (page: ReactNode) => find(page, el => el.type === 'button' && typeof el.props.formAction === 'string');

test('login page: one form holds the default-checked checkbox and every provider button', async () => {
  const page = await Login({ searchParams: Promise.resolve({}) });
  const boxes = checkboxes(page);
  expect(boxes).toHaveLength(1);
  expect(boxes[0].el.props.name).toBe('newsletter'); expect(boxes[0].el.props.defaultChecked).toBe(true);
  const forms = find(page, el => el.type === 'form');
  expect(forms).toHaveLength(1);
  expect(forms[0].el.props.method).toBe('get');
  const found = buttons(page);
  expect(found.map(b => b.el.props.formAction)).toEqual(['/api/auth/login/google', '/api/auth/login/kakao']);
  for (const item of [...boxes, ...found]) expect(item.ancestors.filter(a => a.type === 'form')).toHaveLength(1);
  // No self-signup inputs besides the newsletter checkbox.
  expect(find(page, el => el.type === 'input')).toHaveLength(1);
  const html = renderToStaticMarkup(page);
  expect(html).toMatch(/type="checkbox"[^>]*name="newsletter"[^>]*checked=""/);
  expect(html).toContain('이메일 주소');
  expect(html).toContain(authCopy.newsletterConsent);
  expect(html).not.toMatch(/naver|네이버/i);
});

test('login page hides buttons for unconfigured providers', async () => {
  context.env = { KAKAO_REST_KEY: 'krest' };
  expect(buttons(await Login({ searchParams: Promise.resolve({}) })).map(b => b.el.props.formAction)).toEqual(['/api/auth/login/kakao']);
  context.env = { GOOGLE_CLIENT_ID: 'gid' }; // secret missing
  const none = await Login({ searchParams: Promise.resolve({}) });
  expect(buttons(none)).toHaveLength(0);
  expect(find(none, el => el.type === 'form')).toHaveLength(0);
  expect(renderToStaticMarkup(none)).toContain('소셜 로그인이 아직 준비되지 않았어요');
});

test.each(['state', 'denied', 'email', 'provider'] as const)('login page shows an alert for error=%s', async error => {
  const html = renderToStaticMarkup(await Login({ searchParams: Promise.resolve({ error }) }));
  expect(html).toContain('role="alert"');
  expect(html).toContain(authCopy.errors[error]);
});

test('login page ignores unknown error codes such as config', async () => {
  expect(renderToStaticMarkup(await Login({ searchParams: Promise.resolve({ error: 'config' }) }))).not.toContain('role="alert"');
});

test('login redirects signed-in users to /me; /me redirects anonymous users to /login', async () => {
  await expect(Me()).rejects.toThrow('NEXT_REDIRECT:/login');
  await memory.db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u-1','a@example.com','2026-10-22T00:00:00.000Z')").run();
  await memory.db.prepare("INSERT INTO user_identities VALUES ('kakao','1','u-1','a@example.com','x')").run();
  context.session = await createSession(memory.db, 'u-1', new Date());
  await expect(Login({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT:/me');
  const html = renderToStaticMarkup(await Me());
  expect(html).toContain('a@example.com'); expect(html).toContain('카카오');
});

test('/me server actions withdraw, resubscribe and log out', async () => {
  await memory.db.prepare("INSERT INTO users (id, email, created_at, newsletter_opt_in, newsletter_consented_at) VALUES ('u-1','a@example.com','2026-10-22T00:00:00.000Z',1,'2026-10-22T00:00:00.000Z')").run();
  await memory.db.prepare("INSERT INTO user_identities VALUES ('google','1','u-1','a@example.com','x')").run();
  const token = context.session = await createSession(memory.db, 'u-1', new Date());
  const row = () => memory.db.prepare('SELECT newsletter_opt_in AS o, newsletter_consented_at AS c, newsletter_withdrawn_at AS w FROM users').first<{ o: number; c: string | null; w: string | null }>();
  const actions = async () => {
    const page = await Me();
    const forms = find(page, el => el.type === 'form');
    return { toggle: forms[0].el.props.action as (f: FormData) => Promise<void>, logout: forms[1].el.props.action as () => Promise<void>, optIn: find(forms[0].el, el => el.type === 'button')[0].el.props.value };
  };
  let a = await actions();
  expect(a.optIn).toBe('0');
  await expect(a.toggle(new FormData())).rejects.toThrow('NEXT_REDIRECT:/me'); // no opt_in => withdraw
  expect(await row()).toMatchObject({ o: 0, w: expect.any(String) });
  a = await actions();
  expect(a.optIn).toBe('1');
  const form = new FormData(); form.set('opt_in', '1');
  await expect(a.toggle(form)).rejects.toThrow('NEXT_REDIRECT:/me');
  expect(await row()).toMatchObject({ o: 1, w: null, c: expect.any(String) });
  await expect(a.logout()).rejects.toThrow('NEXT_REDIRECT:/login');
  expect(context.deleted).toEqual([SESSION_COOKIE]);
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
  // The old cookie value is anonymous afterwards.
  context.session = token;
  await expect(Me()).rejects.toThrow('NEXT_REDIRECT:/login');
});

test('layout header links to /me', () => {
  const html = renderToStaticMarkup(Layout({ children: null }));
  expect(html).toContain('class="account-link" href="/me"');
});
