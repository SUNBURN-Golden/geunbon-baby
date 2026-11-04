import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import * as apiModule from '../lib/api';
import { api, migrate, publish } from './helpers/deal-timestamps';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, authenticated: true, session: '' }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'timestamp-admin-test-only', INGEST_TOKEN: 'timestamp-ingest-test-only' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => new RequestCookies(new Headers({ cookie: context.authenticated ? `agamajung_admin=${context.session}` : '' })) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); } }));
let memory: ReturnType<typeof memoryD1>, call: ReturnType<typeof api>, id: string;
type Action = (form: FormData) => Promise<void>;
type Props = { children?: ReactNode; name?: string; type?: string; value?: string | number; defaultValue?: string | number; defaultChecked?: boolean; required?: boolean; minLength?: number; maxLength?: number; action?: string | Action; href?: string; 'aria-label'?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : []);
}
function forms(node: ReactNode) {
  return elements(node).filter(n => n.type === 'form' && typeof n.props.action === 'function').map(node => ({ node, action: node.props.action as Action }));
}
function data(node: ReactNode) {
  const result = new FormData();
  for (const field of elements(node)) {
    const props = field.props;
    if (!props.name || !['input','select','textarea'].includes(String(field.type))) continue;
    if (props.type === 'checkbox') { if (props.defaultChecked) result.set(props.name, 'on'); }
    else result.set(props.name, String(props.value ?? props.defaultValue ?? ''));
  }
  result.set('reason', 'Offline administrator documented reason');
  return result;
}
const page = (params: { error?: string; deal?: string; deal_status?: string; deal_cursor?: string } = {}) => Admin({ searchParams: Promise.resolve(params) });
async function lifecycle(dealId = id) {
  const rendered = forms(await page({ deal: dealId }));
  return { correct: rendered.find(f => f.action.name === 'correctDeal')!, withdraw: rendered.find(f => f.action.name === 'withdrawDeal')! };
}
async function submit(form: ReturnType<typeof forms>[number], values: Record<string, string | null> = {}, target = '/admin') {
  const payload = data(form.node);
  for (const [key, value] of Object.entries(values)) { if (value === null) payload.delete(key); else payload.set(key, value); }
  await expect(form.action(payload)).rejects.toThrow(`NEXT_REDIRECT:${target}`);
}
const row = () => memory.db.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first();
async function snapshot() {
  return { deals: (await memory.db.prepare('SELECT * FROM deals ORDER BY id').all()).results, revisions: (await memory.db.prepare('SELECT * FROM deal_revisions ORDER BY deal_id,version').all()).results };
}
beforeEach(async () => {
  context.session = await apiModule.issueAdminSession('timestamp-admin-test-only');
  context.authenticated = true; memory = memoryD1({ serialize: true }); context.db = memory.db;
  call = api(memory.db); await migrate(memory.db); id = (await publish(memory.db, 'admin-form')).id;
});
afterEach(() => memory.close());

test('real correction action converts fields, stores null price, removes and restores only the original image', async () => {
  let form = (await lifecycle()).correct;
  const requestId = data(form.node).get('request_id');
  const reason = elements(form.node).find(n => n.props.name === 'reason')!;
  expect(reason.props).toMatchObject({ required: true, minLength: 10, maxLength: 300 });
  await submit(form, { title: 'Edited by admin form', price: '123456', include_image: null, image_url: 'https://cdninstagram.com/injected.jpg' });
  expect(await row()).toMatchObject({ title: 'Edited by admin form', price: 123456, image_url: null, version: 2 });
  expect((await memory.db.prepare('SELECT * FROM deal_revisions WHERE deal_id = ? AND version = 2').bind(id).first())).toMatchObject({ request_id: requestId, action: 'correct', reason: 'Offline administrator documented reason', price: 123456 });
  form = (await lifecycle()).correct;
  await submit(form, { price: '', include_image: 'on' });
  expect(await row()).toMatchObject({ price: null, image_url: 'https://cdninstagram.com/original.jpg?sig=offline%2B', version: 3 });
  const invalid = await call(`admin/deals/${id}`, { action: 'correct', expected_version: 3, request_id: crypto.randomUUID(), reason: 'Offline administrator documented reason', model_id: 'model-1', title: 'Invalid image edit', price: null, starts_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-30T00:00:00Z', include_image: true, image_url: 'https://cdninstagram.com/injected.jpg' });
  expect(invalid.status).toBe(400);
});

test('withdrawal requires confirmation, records one revision and leaves no mutation forms', async () => {
  const form = (await lifecycle()).withdraw;
  const before = await snapshot();
  const handler = vi.spyOn(apiModule, 'handleApi');
  await submit(form, {}, '/admin?error=deal');
  expect(handler).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  await submit(form, { confirm_withdrawal: 'on' });
  expect(await row()).toMatchObject({ status: 'withdrawn', version: 2, withdrawn_at: expect.any(String) });
  expect((await memory.db.prepare('SELECT * FROM deal_revisions WHERE deal_id = ? ORDER BY version').bind(id).all()).results).toHaveLength(2);
  const after = await lifecycle(); expect(after.correct).toBeUndefined(); expect(after.withdraw).toBeUndefined();
  const html = renderToStaticMarkup(await page({ deal: id })); expect(html).toContain('withdrawn'); expect(html).toContain('Offline administrator documented reason'); expect(html).toContain('Original evidence admin-form');
});

test('forms get independent request IDs on each render and repeated submissions replay', async () => {
  const first = await lifecycle(), second = await lifecycle();
  const key = data(first.correct.node).get('request_id') as string;
  const keys = [key, data(first.withdraw.node).get('request_id'), data(second.correct.node).get('request_id'), data(second.withdraw.node).get('request_id')];
  expect(new Set(keys).size).toBe(4);
  await submit(first.correct, { title: 'First submission' });
  const before = await snapshot();
  await submit(first.correct, { title: 'First submission' }); expect(await snapshot()).toEqual(before);
  await submit(first.withdraw, { confirm_withdrawal: 'on', request_id: key }, '/admin?error=deal_conflict');
  expect(await snapshot()).toEqual(before); expect(await row()).toMatchObject({ status: 'published', version: 2 });
});

test('a stale form redirects to deal_conflict and the page explains refreshing', async () => {
  const stale = (await lifecycle()).correct;
  const fresh = (await lifecycle()).correct;
  await submit(fresh, { title: 'Another administrator won' });
  const before = await snapshot();
  await submit(stale, { price: '98765' }, '/admin?error=deal_conflict');
  expect(await snapshot()).toEqual(before);
  expect(renderToStaticMarkup(await page({ error: 'deal_conflict' }))).toContain('다른 관리자가 먼저 변경했거나 이미 처리된 요청입니다. 새로고침 후 다시 확인하세요.');
  expect(renderToStaticMarkup(await page({ error: 'deal' }))).toContain('공구 정정·철회에 실패했습니다. 입력값을 확인하세요.');
});

test('logout invalidates both captured forms before they can call the API', async () => {
  const captured = await lifecycle();
  const logout = forms(await page()).find(f => f.action.name === 'logout')!;
  await submit(logout);
  context.authenticated = false;
  const before = await snapshot();
  const handler = vi.spyOn(apiModule, 'handleApi');
  await submit(captured.correct, { title: 'Logged out edit' }, '/admin?error=auth');
  await submit(captured.withdraw, { confirm_withdrawal: 'on' }, '/admin?error=auth');
  await submit(captured.withdraw, {}, '/admin?error=auth');
  expect(handler).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  const html = renderToStaticMarkup(await page()); expect(html).not.toContain('게시된 공구 정정·철회');
});

test('ID lookup and next links reach a deal ranked beyond 200, including status and bad-cursor fallback', async () => {
  await memory.db.prepare('UPDATE deals SET checked = ? WHERE id = ?').bind('2026-01-01T00:00:00.000Z', id).run();
  for (let index = 1; index < 205; index++) await publish(memory.db, `admin-reach-${index}`);
  const found = await lifecycle(); expect(found.correct).toBeDefined(); expect(data(found.correct.node).get('deal_id')).toBe(id);
  let params = {}, lastPage = false, pages = 0;
  const seen: string[] = [];
  while (!lastPage) {
    const tree = await page(params); pages++;
    const nodes = elements(tree);
    for (const form of forms(tree).filter(f => f.action.name === 'correctDeal')) seen.push(String(data(form.node).get('deal_id')));
    const nav = nodes.find(n => n.type === 'nav' && n.props['aria-label'] === '공구 페이지')!;
    const next = elements(nav.props.children).find(n => n.type === 'a' && n.props.children === '다음 20건');
    if (!next) lastPage = true;
    else { const url = new URL(next.props.href!, 'http://localhost'); params = { deal_status: url.searchParams.get('deal_status')!, deal_cursor: url.searchParams.get('deal_cursor')! }; }
    expect(pages).toBeLessThan(12);
  }
  expect(pages).toBe(11); expect(seen).toHaveLength(205); expect(new Set(seen).size).toBe(205); expect(seen.at(-1)).toBe(id);
  await submit(found.correct, { title: 'Oldest deal corrected from lookup' }); expect(await row()).toMatchObject({ title: 'Oldest deal corrected from lookup', version: 2 });
  const first = forms(await page()).filter(f => f.action.name === 'correctDeal').map(f => data(f.node).get('deal_id'));
  for (const values of [{ deal_cursor: 'bad' }, { deal_status: 'bad' }]) expect(forms(await page(values)).filter(f => f.action.name === 'correctDeal').map(f => data(f.node).get('deal_id'))).toEqual(first);
  expect(renderToStaticMarkup(await page({ deal: 'unknown' }))).toContain('해당 공구가 없습니다');
  await submit((await lifecycle()).withdraw, { confirm_withdrawal: 'on' });
  expect(renderToStaticMarkup(await page({ deal_status: 'withdrawn' }))).toContain(`data-deal-id="${id}"`);
  expect(renderToStaticMarkup(await page())).not.toContain(`data-deal-id="${id}"`);
});
