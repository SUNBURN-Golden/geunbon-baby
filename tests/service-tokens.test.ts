import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdir, readFile } from 'node:fs/promises';
import { ResponseCookies } from 'next/dist/compiled/@edge-runtime/cookies';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import { authorized, handleApi, issueAdminSession, MIN_SERVICE_TOKEN_LENGTH, serviceTokens } from '../lib/api';
import type { Env } from '../lib/db';
import { memoryD1 } from './helpers/sqlite';

type TokenConfig = Pick<Env, 'ADMIN_TOKEN' | 'INGEST_TOKEN' | 'COLLECTOR_STATUS_TOKEN'>;
const valid: TokenConfig = {
  ADMIN_TOKEN: 'fixture-admin-token-separation-0001',
  INGEST_TOKEN: 'fixture-ingest-token-separation-0002',
  COLLECTOR_STATUS_TOKEN: 'fixture-status-token-separation-0003',
};
const invalid: { name: string; config: TokenConfig }[] = [
  { name: 'missing admin', config: { ...valid, ADMIN_TOKEN: undefined } },
  { name: 'missing ingest', config: { ...valid, INGEST_TOKEN: undefined } },
  { name: 'both missing', config: {} },
  ...(['ADMIN_TOKEN', 'INGEST_TOKEN'] as const).flatMap(key => [
    { name: `${key} empty`, config: { ...valid, [key]: '' } },
    { name: `${key} short`, config: { ...valid, [key]: 'a'.repeat(23) } },
    { name: `${key} leading whitespace`, config: { ...valid, [key]: ` ${valid[key]}` } },
    { name: `${key} trailing whitespace`, config: { ...valid, [key]: `${valid[key]} ` } },
    { name: `${key} whitespace only`, config: { ...valid, [key]: ' '.repeat(24) } },
  ]),
  { name: 'admin equals ingest', config: { ...valid, INGEST_TOKEN: valid.ADMIN_TOKEN } },
  { name: 'collector equals admin', config: { ...valid, COLLECTOR_STATUS_TOKEN: valid.ADMIN_TOKEN } },
  { name: 'collector equals ingest', config: { ...valid, COLLECTOR_STATUS_TOKEN: valid.INGEST_TOKEN } },
];
const context = vi.hoisted(() => ({
  env: undefined as Env | undefined,
  cookie: undefined as string | undefined,
  response: undefined as ResponseCookies | undefined,
}));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => context.env,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: () => context.cookie === undefined ? undefined : { value: context.cookie },
  set: (...args: Parameters<ResponseCookies['set']>) => context.response!.set(...args),
}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); } }));

let memory: ReturnType<typeof memoryD1>;
let headers: Headers;
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  memory = memoryD1();
  context.env = { DB: memory.db, IMAGES: {} as R2Bucket, ...valid };
  context.cookie = undefined;
  headers = new Headers(); context.response = new ResponseCookies(headers);
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) await memory.db.prepare(sql).run();
  }
  await memory.db.prepare("INSERT INTO models VALUES ('model-1','Stokke','fixture','high_chair','fixture',NULL,'https://www.stokke.com/','2026-10-20','manual','')").run();
  await memory.db.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','fixture','https://www.stokke.com/')").run();
  await memory.db.prepare("INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES ('item-1','https://www.instagram.com/p/separation-review/','fixture','synthetic fixture','post','2026-10-22T00:00:00.000Z')").run();
  await memory.db.prepare("INSERT INTO external_candidates (id,source,source_url,title,text,captured_at,last_seen_at) VALUES ('cand-1','pangpang','https://09pangpang.com/deal/separation','synthetic fixture','synthetic fixture','2026-10-22T00:00:00.000Z','2026-10-22T00:00:00.000Z')").run();
});
afterEach(() => memory.close());

const ingest = { source_url: 'https://www.instagram.com/p/separation-ingest/', account: 'fixture', kind: 'post', text: 'synthetic fixture', captured_at: '2026-10-22T00:00:00.000Z' };
const approval = { action: 'approve', attribution: 'explicit', attribution_note: 'Synthetic fixture attribution reviewed offline', model_id: 'model-1', seller_id: 'seller-1', title: 'synthetic fixture', price: null, starts_at: '2026-10-26T00:00:00Z', ends_at: '2026-10-28T00:00:00Z' };
function call(path: string, token?: string, body?: unknown) {
  return handleApi(new Request(`https://site.invalid/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'), context.env!);
}
function noSecrets(value: string, config: TokenConfig = context.env!) {
  for (const token of Object.values(config)) if (typeof token === 'string' && token.trim()) expect(value).not.toContain(token);
}
async function expectResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  noSecrets(await response.text());
}
async function unchanged() {
  expect(await memory.db.prepare('SELECT status, reviewed_at FROM ingested_items WHERE id = ?').bind('item-1').first()).toEqual({ status: 'pending', reviewed_at: null });
  expect(await memory.db.prepare('SELECT status, reviewed_at FROM external_candidates WHERE id = ?').bind('cand-1').first()).toEqual({ status: 'candidate', reviewed_at: null });
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM deals').first()).toEqual({ n: 0 });
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM ingested_items').first()).toEqual({ n: 1 });
}
type Action = (form: FormData) => Promise<void>;
function forms(node: ReactNode): { action: Action; html: string }[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; action?: Action }>(child)) return [];
    if (child.type === 'form') return [{ action: child.props.action!, html: renderToStaticMarkup(child) }];
    return forms(child.props.children);
  });
}
const page = () => Admin({ searchParams: Promise.resolve({}) });
async function action(marker: string) {
  return forms(await page()).find(form => form.html.includes(marker))!.action;
}
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
async function expectRedirect(action: Action, data: FormData, to: string) {
  const error = await action(data).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`NEXT_REDIRECT:${to}`);
  noSecrets((error as Error).message);
}

test.each(invalid)('configuration rejects $name', ({ config }) => {
  expect(serviceTokens(config)).toBeNull();
});

test('exactly 24 characters and an unset status token are supported', () => {
  expect(MIN_SERVICE_TOKEN_LENGTH).toBe(24);
  const admin = 'a'.repeat(24), ingest = 'b'.repeat(24), status = 'c'.repeat(24);
  expect(serviceTokens({ ADMIN_TOKEN: admin, INGEST_TOKEN: ingest, COLLECTOR_STATUS_TOKEN: status })).toEqual({ admin, ingest });
  expect(serviceTokens({ ADMIN_TOKEN: admin, INGEST_TOKEN: ingest })).toEqual({ admin, ingest });
  expect(serviceTokens({ ...valid, COLLECTOR_STATUS_TOKEN: 'short-distinct-status' })).toEqual({ admin: valid.ADMIN_TOKEN, ingest: valid.INGEST_TOKEN });
});

test.each([undefined, '', 'a'.repeat(23), ` ${valid.ADMIN_TOKEN}`, `${valid.ADMIN_TOKEN} `])('authorized rejects weak configured tokens (%#)', async token => {
  expect(await authorized(new Request('https://site.invalid', { headers: { authorization: `Bearer ${token ?? ''}` } }), token)).toBe(false);
});

test.each(invalid)('protected APIs fail closed and public reads remain available: $name', async ({ config }) => {
  context.env = { ...context.env!, ADMIN_TOKEN: undefined, INGEST_TOKEN: undefined, COLLECTOR_STATUS_TOKEN: undefined, ...config };
  for (const [path, body] of [
    ['admin/queue', undefined], ['admin/candidates', undefined], ['admin/collection-status', undefined],
    ['admin/review/item-1', approval], ['admin/candidates/cand-1', { action: 'dismiss' }],
  ] as const) {
    await expectResponse(await call(path, config.ADMIN_TOKEN, body), 503);
  }
  await expectResponse(await call('ingest', config.INGEST_TOKEN, ingest), 503);
  await expectResponse(await call('admin/queue'), 503);
  await expectResponse(await call('ingest', undefined, ingest), 503);
  for (const path of ['brands', 'models', 'models/model-1', 'deals', 'calendar', 'sellers']) await expectResponse(await call(path), 200);
  await unchanged();
});

test('valid credentials retain separate privileges, including collector isolation', async () => {
  for (const token of [undefined, valid.INGEST_TOKEN, valid.COLLECTOR_STATUS_TOKEN]) {
    for (const path of ['admin/queue', 'admin/candidates', 'admin/collection-status']) await expectResponse(await call(path, token), 401);
    await expectResponse(await call('admin/review/item-1', token, approval), 401);
    await expectResponse(await call('admin/candidates/cand-1', token, { action: 'dismiss' }), 401);
  }
  for (const token of [undefined, valid.ADMIN_TOKEN, valid.COLLECTOR_STATUS_TOKEN]) await expectResponse(await call('ingest', token, ingest), 401);
  await unchanged();
  for (const path of ['admin/queue', 'admin/candidates', 'admin/collection-status']) await expectResponse(await call(path, valid.ADMIN_TOKEN), 200);
  await expectResponse(await call('ingest', valid.INGEST_TOKEN, ingest), 202);
  await expectResponse(await call('admin/review/item-1', valid.ADMIN_TOKEN, approval), 200);
  await expectResponse(await call('admin/candidates/cand-1', valid.ADMIN_TOKEN, { action: 'dismiss' }), 200);
  for (const path of ['brands', 'models', 'models/model-1', 'deals', 'calendar', 'sellers']) await expectResponse(await call(path), 200);
});

test.each(invalid)('admin login, existing cookies and stale actions fail closed: $name', async ({ config }) => {
  // Capture real server actions before the operator invalidates configuration.
  const login = await action('name="token"');
  context.cookie = await issueAdminSession(valid.ADMIN_TOKEN!);
  const review = await action('name="id"');
  const dismiss = await action('name="candidate_id"');
  context.env = { ...context.env!, ADMIN_TOKEN: undefined, INGEST_TOKEN: undefined, COLLECTOR_STATUS_TOKEN: undefined, ...config };
  for (const cookie of [config.ADMIN_TOKEN, await issueAdminSession(valid.ADMIN_TOKEN!)]) {
    context.cookie = cookie;
    const tree = await page();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('관리자 인증 설정을 확인해야 합니다. 운영자에게 문의하세요.');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('게시 전 검수');
    expect(forms(tree)).toHaveLength(0);
    noSecrets(html);
    await expectRedirect(review, form({ id: 'item-1', ...approval, price: '' }), '/admin?error=auth');
    await expectRedirect(dismiss, form({ candidate_id: 'cand-1' }), '/admin?error=auth');
  }
  await expectRedirect(login, form({ token: config.ADMIN_TOKEN ?? '' }), '/admin?error=config');
  expect(headers.getSetCookie()).toEqual([]);
  await unchanged();
});

test('valid administrator login, review, dismiss and logout preserve the session contract', async () => {
  const login = await action('name="token"');
  for (const token of [valid.INGEST_TOKEN!, valid.COLLECTOR_STATUS_TOKEN!]) {
    await expectRedirect(login, form({ token }), '/admin?error=auth');
    expect(headers.getSetCookie()).toEqual([]);
  }
  await expectRedirect(login, form({ token: valid.ADMIN_TOKEN! }), '/admin');
  const issued = context.response!.get('agamajung_admin')!;
  expect(issued.value).not.toBe(valid.ADMIN_TOKEN);
  noSecrets(issued.value);
  expect(issued).toMatchObject({ path: '/admin', httpOnly: true, sameSite: 'strict', maxAge: 3600 });
  context.cookie = issued.value;
  const tree = await page();
  expect(renderToStaticMarkup(tree)).toContain('게시 전 검수');
  noSecrets(renderToStaticMarkup(tree));
  const review = await action('name="id"');
  const dismiss = await action('name="candidate_id"');
  const logout = await action('로그아웃');
  await expectRedirect(review, form({ id: 'item-1', ...approval, price: '' }), '/admin');
  await expectRedirect(dismiss, form({ candidate_id: 'cand-1' }), '/admin');
  expect(await memory.db.prepare('SELECT status FROM ingested_items WHERE id = ?').bind('item-1').first()).toEqual({ status: 'approved' });
  expect(await memory.db.prepare('SELECT status FROM external_candidates WHERE id = ?').bind('cand-1').first()).toEqual({ status: 'dismissed' });
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM deals').first()).toEqual({ n: 1 });
  await expectRedirect(logout, new FormData(), '/admin');
  expect(context.response!.get('agamajung_admin')).toMatchObject({ value: '', path: '/admin', httpOnly: true, sameSite: 'strict', maxAge: 0, expires: new Date(0) });
  context.cookie = undefined;
  expect(renderToStaticMarkup(await page())).toContain('type="password"');
});

test('collector-status remains available with an invalid admin/ingest pair', async () => {
  const snapshot = { worker_id: 'fixture-worker', version: 1, generated_at: '2026-10-22T00:00:00.000Z', counts: { discovered: 0, source_check_needed: 0, dedup_excluded: 0, verified_waiting: 0, ready_to_publish: 0 }, total: 0, unique: 0, groups: 0, unresolved_conflicts: 0, recheck_due: 0 };
  for (const config of [{}, { ADMIN_TOKEN: 'short-admin', INGEST_TOKEN: 'short-ingest' }, { ADMIN_TOKEN: valid.ADMIN_TOKEN, INGEST_TOKEN: valid.ADMIN_TOKEN }]) {
    context.env = { DB: memory.db, IMAGES: {} as R2Bucket, ...config, COLLECTOR_STATUS_TOKEN: valid.COLLECTOR_STATUS_TOKEN };
    await expectResponse(await call('collector/status', valid.COLLECTOR_STATUS_TOKEN, snapshot), 200);
  }
});

test.each([undefined, '', 'a'.repeat(23), ` ${valid.COLLECTOR_STATUS_TOKEN}`, `${valid.COLLECTOR_STATUS_TOKEN} `, valid.ADMIN_TOKEN, valid.INGEST_TOKEN])('collector-status rejects missing, weak or colliding credentials (%#)', async token => {
  context.env = { ...context.env!, COLLECTOR_STATUS_TOKEN: token };
  const response = await call('collector/status', token, {});
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: 'status_token_config' });
  noSecrets(text);
});
