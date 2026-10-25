import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import Sellers from '../app/sellers/page';
import { issueAdminSession } from '../lib/api';
import { migrate } from './helpers/deal-timestamps';
import { memoryD1 } from './helpers/sqlite';

const TOKEN = 'fixture-admin-onboarding-token';
const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, authenticated: true, session: '' }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'fixture-admin-onboarding-token', INGEST_TOKEN: 'fixture-ingest-onboarding-token' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => new RequestCookies(new Headers({ cookie: context.authenticated ? `agamajung_admin=${context.session}` : '' })) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); } }));
let memory: ReturnType<typeof memoryD1>;
type Props = { children?: ReactNode; name?: string; type?: string; value?: string; required?: boolean; disabled?: boolean; checked?: boolean; defaultChecked?: boolean; defaultValue?: string; formNoValidate?: boolean; action?: (form: FormData) => Promise<void> };
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : []);
}
function forms(node: ReactNode) {
  return elements(node).filter(child => child.type === 'form').map(node => ({ node, action: node.props.action!, html: renderToStaticMarkup(node) }));
}
const page = (error?: string) => Admin({ searchParams: Promise.resolve({ error }) });
const formData = (values: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
};
async function submit(action: (form: FormData) => Promise<void>, values: Record<string, string>, to = '/admin') {
  await expect(action(formData(values))).rejects.toThrow(`NEXT_REDIRECT:${to}`);
}
async function pending(account = 'new.shop', id = 'item-1') {
  await memory.db.prepare('INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES (?,?,?,?,?,?)').bind(id, `https://instagram.com/p/${id}/`, account, 'Offline caption', 'post', '2026-10-24T00:00:00Z').run();
}
const registration = { name: 'Registered fixture seller', source_url: 'https://example.com/new', account: '' };
beforeEach(async () => {
  context.authenticated = true;
  context.session = await issueAdminSession(TOKEN);
  memory = memoryD1(); context.db = memory.db;
  await migrate(memory.db);
});
afterEach(() => memory.close());

test('review selections start blank, attribution is unchecked and only rejection bypasses validation', async () => {
  await pending();
  const form = forms(await page()).find(f => f.html.includes('name="id"'))!;
  const nodes = elements(form.node);
  for (const name of ['model_id', 'seller_id']) {
    const select = nodes.find(n => n.type === 'select' && n.props.name === name)!;
    expect(select.props).toMatchObject({ required: true, defaultValue: '' });
    const options = elements(select.props.children).filter(n => n.type === 'option');
    expect(options[0].props).toMatchObject({ value: '', disabled: true });
    expect(renderToStaticMarkup(select)).toMatch(/<option value="" disabled="" selected="">선택하세요<\/option>/);
  }
  const radios = nodes.filter(n => n.props.name === 'attribution');
  expect(radios).toHaveLength(2);
  for (const radio of radios) {
    expect(radio.props.required).toBe(true);
    expect(radio.props.checked).toBeUndefined();
    expect(radio.props.defaultChecked).toBeUndefined();
  }
  const reject = nodes.find(n => n.type === 'button' && n.props.value === 'reject')!;
  const approve = nodes.find(n => n.type === 'button' && n.props.value === 'approve')!;
  expect(reject.props.formNoValidate).toBe(true);
  expect(renderToStaticMarkup(reject)).toContain('formNoValidate=""');
  expect(approve.props.formNoValidate).toBeUndefined();
  expect(renderToStaticMarkup(approve).toLowerCase()).not.toContain('formnovalidate');
});

test.each(['new.shop', 'Some Shop 공식'])('unlinked source %s cannot select account attribution', async account => {
  await pending(account);
  const review = forms(await page()).find(f => f.html.includes('name="id"'))!;
  const radio = elements(review.node).find(n => n.props.name === 'attribution' && n.props.value === 'account')!;
  expect(radio.props.disabled).toBe(true);
});

test('reviewed account is a hint only and never preselects seller or attribution', async () => {
  await pending('@NEW.Shop');
  await memory.db.prepare("INSERT INTO seller_accounts VALUES ('new.shop','seller-1','2026-10-24T00:00:00Z')").run();
  const review = forms(await page()).find(f => f.html.includes('name="id"'))!;
  expect(review.html).toContain('연결된 판매자: Test seller');
  const nodes = elements(review.node);
  expect(nodes.find(n => n.props.name === 'attribution' && n.props.value === 'account')!.props.disabled).toBe(false);
  expect(nodes.find(n => n.type === 'select' && n.props.name === 'seller_id')!.props.defaultValue).toBe('');
  expect(review.html).not.toContain('checked=""');
});

test('blank approval remains pending and the same blank selections can be rejected', async () => {
  await pending();
  const action = forms(await page()).find(f => f.html.includes('name="id"'))!.action;
  const values = { id: 'item-1', model_id: '', seller_id: '', title: '', price: '', starts_at: '', ends_at: '' };
  await submit(action, { ...values, action: 'approve' }, '/admin?error=review');
  expect(await memory.db.prepare("SELECT status FROM ingested_items WHERE id = 'item-1'").first()).toEqual({ status: 'pending' });
  await submit(action, { ...values, action: 'reject' });
  expect(await memory.db.prepare("SELECT status FROM ingested_items WHERE id = 'item-1'").first()).toEqual({ status: 'rejected' });
  expect(await memory.db.prepare('SELECT id FROM deals').first()).toBeNull();
});

test('standalone seller registration exists with no queue and blank account preserves other links', async () => {
  await memory.db.prepare("INSERT INTO seller_accounts VALUES ('existing','seller-1','2026-10-24T00:00:00Z')").run();
  const form = forms(await page()).find(f => f.html.includes('새 판매자 등록'))!;
  expect(form).toBeDefined();
  expect(elements(form.node).find(n => n.props.name === 'account')!.props).toMatchObject({ defaultValue: '' });
  expect(elements(form.node).find(n => n.props.name === 'account_reviewed')!.props.required).toBeUndefined();
  await submit(form.action, registration);
  expect(await memory.db.prepare('SELECT account,seller_id FROM seller_accounts').all()).toMatchObject({ results: [{ account: 'existing', seller_id: 'seller-1' }] });
  expect(await memory.db.prepare('SELECT registration_source,withdrawal_source,official_import_source FROM sellers WHERE name = ?').bind(registration.name).first()).toEqual({ registration_source: null, withdrawal_source: null, official_import_source: null });
  const publicPage = renderToStaticMarkup(await Sellers());
  expect(publicPage).toContain(registration.name);
  expect(publicPage.match(/미확인<\/span>/g)).toHaveLength(6);
  expect(publicPage).not.toContain('badge verified');
});

test('registration needs deliberate checkbox for an account and can then approve for the new seller', async () => {
  await pending('@New.Shop');
  const action = forms(await page()).find(f => f.html.includes('새 판매자 등록'))!.action;
  await submit(action, { ...registration, account: '@New.Shop' }, '/admin?error=seller');
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM sellers').first()).toEqual({ n: 1 });
  expect(await memory.db.prepare('SELECT account FROM seller_accounts').first()).toBeNull();
  await submit(action, { ...registration, account: '@New.Shop', account_reviewed: 'on' });
  const seller = await memory.db.prepare('SELECT id FROM sellers WHERE name = ?').bind(registration.name).first<{ id: string }>();
  const review = forms(await page()).find(f => f.html.includes('name="id"'))!.action;
  await submit(review, { id: 'item-1', action: 'approve', model_id: 'model-1', seller_id: seller!.id, attribution: 'account', title: 'Reviewed fixture', price: '', starts_at: '2026-10-25T00:00:00Z', ends_at: '2026-10-26T00:00:00Z' });
  expect(await memory.db.prepare('SELECT seller_id FROM deals').first()).toEqual({ seller_id: seller!.id });
});

test('evidence and reviewed link forms update rows, clear evidence and unlink only their seller', async () => {
  await pending();
  let rendered = forms(await page());
  const linkForm = rendered.find(f => f.html.includes('기존 판매자에 연결'))!;
  const select = elements(linkForm.node).find(n => n.type === 'select')!;
  expect(select.props).toMatchObject({ required: true, defaultValue: '' });
  expect(elements(linkForm.node).find(n => n.props.name === 'account_reviewed')!.props.required).toBe(true);
  await submit(linkForm.action, { seller_id: 'seller-1', account: 'new.shop' }, '/admin?error=seller');
  await submit(linkForm.action, { seller_id: 'seller-1', account: 'new.shop', account_reviewed: 'on' });
  const edit = rendered.find(f => f.html.includes('증빙 저장'))!.action;
  const fields = { seller_id: 'seller-1', name: 'Test seller', source_url: 'https://example.com/seller', registration_source: 'https://example.com/proof', withdrawal_source: '', official_import_source: '' };
  await submit(edit, fields);
  rendered = forms(await page());
  const updated = rendered.find(f => f.html.includes('증빙 저장'))!;
  expect(updated.html).toContain('value="https://example.com/proof"');
  await submit(updated.action, { ...fields, registration_source: '' });
  expect(await memory.db.prepare("SELECT registration_source FROM sellers WHERE id = 'seller-1'").first()).toEqual({ registration_source: null });
  const unlink = rendered.find(f => f.html.includes('계정 연결 해제'))!;
  await submit(unlink.action, { seller_id: 'seller-1', account: 'new.shop' });
  expect(await memory.db.prepare('SELECT account FROM seller_accounts').first()).toBeNull();
});

test('non-handle accounts have no link form', async () => {
  await pending('Some Shop 공식');
  const tree = await page();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain('핸들이 아닌 수집 계정 — 명시 귀속만 가능');
  expect(html).toContain('Some Shop 공식');
  expect(forms(tree).some(f => f.html.includes('기존 판매자에 연결'))).toBe(false);
});

test('all stale seller actions reject the logged-out browser without writes', async () => {
  await pending();
  await memory.db.prepare("INSERT INTO seller_accounts VALUES ('existing','seller-1','2026-10-24T00:00:00Z')").run();
  const rendered = forms(await page());
  const actions: [string, Record<string, string>][] = [
    ['새 판매자 등록', registration],
    ['증빙 저장', { ...registration, seller_id: 'seller-1' }],
    ['기존 판매자에 연결', { seller_id: 'seller-1', account: 'new.shop', account_reviewed: 'on' }],
    ['계정 연결 해제', { seller_id: 'seller-1', account: 'existing' }],
  ];
  context.authenticated = false;
  for (const [label, payload] of actions) await submit(rendered.find(f => f.html.includes(label))!.action, payload, '/admin?error=auth');
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM sellers').first()).toEqual({ n: 1 });
  expect(await memory.db.prepare("SELECT name FROM sellers WHERE id = 'seller-1'").first()).toEqual({ name: 'Test seller' });
  expect((await memory.db.prepare('SELECT account FROM seller_accounts').all()).results).toEqual([{ account: 'existing' }]);
});

test('seller failures have a dedicated alert and site code never imports Linux seller candidates', async () => {
  expect(renderToStaticMarkup(await page('seller'))).toContain('판매자 등록·증빙 처리에 실패했습니다.');
  for (const file of ['app/admin/page.tsx', 'lib/api.ts']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source).not.toContain('crawler/');
    expect(source).not.toContain('seller_candidates');
  }
});
