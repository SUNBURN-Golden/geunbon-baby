import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import * as apiModule from '../lib/api';
import { adminNavigationFromForm, adminUrl, type AdminNavigation, type AdminSearchParams } from '../lib/admin-navigation';
import { approval, migrate, publish } from './helpers/deal-timestamps';
import { fixtureCursor, orderedReviewRows, reviewId, reviewTables, seedReviewRows, type ReviewList } from './helpers/admin-pagination';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, session: '', authenticated: true }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'timestamp-admin-test-only', INGEST_TOKEN: 'timestamp-ingest-test-only' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: context.authenticated ? context.session : '' }) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); } }));

type Action = (form: FormData) => Promise<void>;
type Props = {
  children?: ReactNode; name?: string; type?: string; value?: string | number; defaultValue?: string | number;
  defaultChecked?: boolean; action?: string | Action; href?: string; 'aria-label'?: string;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : []);
}
function forms(node: ReactNode, action: string) {
  return elements(node).filter(n => n.type === 'form' && typeof n.props.action === 'function' && n.props.action.name === action);
}
function formData(node: ReactNode) {
  const form = new FormData();
  for (const field of elements(node)) {
    const { name, type, value, defaultValue, defaultChecked } = field.props;
    if (!name || !['input', 'select', 'textarea'].includes(String(field.type))) continue;
    if (type === 'checkbox' || type === 'radio') { if (defaultChecked) form.set(name, String(value ?? 'on')); }
    else form.set(name, String(value ?? defaultValue ?? ''));
  }
  return form;
}
function navigation(node: ReactNode, label: string) {
  const nav = elements(node).find(n => n.type === 'nav' && n.props['aria-label'] === label)!;
  return elements(nav.props.children).filter(n => n.type === 'a');
}
function paramsFromHref(href: string) {
  expect(href.startsWith('/admin?')).toBe(true);
  return Object.fromEntries(new URL(href, 'https://local.invalid').searchParams);
}
async function target(node: ReactElement<Props>, values: Record<string, string> = {}, payload = formData(node)) {
  for (const [key, value] of Object.entries(values)) payload.set(key, value);
  try { await (node.props.action as Action)(payload); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT:')) return error.message.slice('NEXT_REDIRECT:'.length);
    throw error;
  }
  throw new Error('Expected a server action redirect');
}
const page = (params: AdminSearchParams = {}) => Admin({ searchParams: Promise.resolve(params) });
let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  context.authenticated = true; context.session = await apiModule.issueAdminSession('timestamp-admin-test-only');
  memory = memoryD1(); context.db = memory.db; await migrate(memory.db);
});
afterEach(() => memory.close());

async function laterState(queueLimit = 100, candidateLimit = 200): Promise<AdminNavigation> {
  const queue = await apiModule.adminQueuePage(memory.db, { limit: queueLimit });
  const candidates = await apiModule.adminCandidatesPage(memory.db, { limit: candidateLimit });
  return {
    deal: 'offline-lookup', deal_status: 'all',
    deal_cursor: Buffer.from('9999-01-01T00:00:00.000Z|offline-anchor').toString('base64url'),
    queue_cursor: queue.next_cursor!, candidate_cursor: candidates.next_cursor!,
  };
}
const labels = { queue: '검수 대기 페이지', candidates: '외부 후보 페이지' } as const;
const actions = { queue: 'review', candidates: 'dismissCandidate' } as const;

test.each(['queue', 'candidates'] as const)('rendered %s links traverse past the former cap and preserve other sections', async list => {
  await seedReviewRows(memory.db, 'queue', 237); await seedReviewRows(memory.db, 'candidates', 437);
  const state = await laterState(20, 20);
  const ownKey = list === 'queue' ? 'queue_cursor' : 'candidate_cursor';
  delete state[ownKey];
  let params: AdminSearchParams = { ...state };
  const seen: string[] = [];
  let pages = 0;
  while (true) {
    const tree = await page(params); pages++;
    const rendered = forms(tree, actions[list]);
    expect(rendered.length).toBeLessThanOrEqual(20);
    const key = list === 'queue' ? 'id' : 'candidate_id';
    seen.push(...rendered.map(form => String(formData(form).get(key))));
    const links = navigation(tree, labels[list]);
    expect(links.some(link => link.props.children === '처음부터')).toBe(Boolean(params[ownKey]));
    const next = links.find(link => link.props.children === '다음 20건');
    if (!next) break;
    params = paramsFromHref(next.props.href!);
    for (const [key, value] of Object.entries(state)) expect(params[key]).toBe(value);
    expect(pages).toBeLessThan(24);
  }
  const expected = (await orderedReviewRows(memory.db, list)).map(row => row.id);
  expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(expected.length);
  expect(pages).toBe(list === 'queue' ? 12 : 22);
  const restart = navigation(await page(params), labels[list]).find(link => link.props.children === '처음부터')!;
  expect(paramsFromHref(restart.props.href!)).toEqual(state);
  expect(await orderedReviewRows(memory.db, list)).toHaveLength(expected.length);
});

test('approval, rejection, dismissal, and review errors preserve incoming cursors and all deal state', async () => {
  await seedReviewRows(memory.db, 'queue', 237); await seedReviewRows(memory.db, 'candidates', 437);
  const state = await laterState(), expected = adminUrl(state);
  const tree = await page(state);
  const review = forms(tree, 'review'), dismiss = forms(tree, 'dismissCandidate');
  expect(formData(review[0]).get('id')).toBe(reviewId('queue', 100));
  expect(formData(dismiss[0]).get('candidate_id')).toBe(reviewId('candidates', 200));
  const original = apiModule.handleApi, bodies: Record<string, unknown>[] = [];
  vi.spyOn(apiModule, 'handleApi').mockImplementation(async (request, parts, env) => {
    bodies.push(await request.clone().json<Record<string, unknown>>()); return original(request, parts, env);
  });
  expect(await target(review[0], { action: 'approve' })).toBe(adminUrl(state, {}, 'review'));
  const approved = Object.fromEntries(Object.entries(approval('2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z')).map(([key, value]) => [key, value === null ? '' : String(value)]));
  expect(await target(review[0], approved)).toBe(expected);
  expect(await target(review[1], { action: 'reject' })).toBe(expected);
  expect(await target(dismiss[0])).toBe(expected);
  // A second administrator's stale form reaches the conflict path.
  expect(await target(review[0], { action: 'reject' })).toBe(adminUrl(state, {}, 'review_conflict'));
  expect(await target(dismiss[0])).toBe(adminUrl(state, {}, 'review'));
  expect(bodies).toHaveLength(6);
  expect(bodies.every(body => Object.keys(body).every(key => !key.startsWith('nav_')))).toBe(true);
  const refreshed = await page(state);
  const remainingQueue = forms(refreshed, 'review').map(form => formData(form).get('id'));
  expect(remainingQueue).toHaveLength(20); expect(remainingQueue[0]).toBe(reviewId('queue', 102));
  expect(remainingQueue.at(-1)).toBe(reviewId('queue', 121));
  expect(forms(refreshed, 'dismissCandidate').map(form => formData(form).get('candidate_id'))[0]).toBe(reviewId('candidates', 201));
  expect(await memory.db.prepare('SELECT status FROM ingested_items WHERE id = ?').bind(reviewId('queue', 100)).first()).toEqual({ status: 'approved' });
});

test('deal controls preserve both review cursors, reset deal position when filtering, and retain state through other actions', async () => {
  await seedReviewRows(memory.db, 'queue', 23); await seedReviewRows(memory.db, 'candidates', 23);
  const state = await laterState(20, 20); delete state.deal;
  for (let index = 0; index < 21; index++) await publish(memory.db, `pagination-deal-${index}`);
  const tree = await page(state);
  const next = navigation(tree, '공구 페이지').find(link => link.props.children === '다음 20건')!;
  const nextParams = paramsFromHref(next.props.href!);
  expect(nextParams).toMatchObject({ queue_cursor: state.queue_cursor, candidate_cursor: state.candidate_cursor, deal_status: 'all' });
  expect(nextParams.deal_cursor).not.toBe(state.deal_cursor);
  for (const link of navigation(tree, '게시 상태')) {
    const params = paramsFromHref(link.props.href!);
    expect(params).toMatchObject({ queue_cursor: state.queue_cursor, candidate_cursor: state.candidate_cursor });
    expect(params.deal_cursor).toBeUndefined(); expect(params.deal).toBeUndefined();
  }
  const search = elements(tree).find(n => n.type === 'form' && n.props.action === '/admin')!;
  const searchData = formData(search);
  expect(searchData.get('queue_cursor')).toBe(state.queue_cursor);
  expect(searchData.get('candidate_cursor')).toBe(state.candidate_cursor);
  expect(searchData.get('deal_status')).toBe('all'); expect(searchData.has('deal_cursor')).toBe(false);
  const recovered = await page({ ...state, deal_cursor: '!' });
  expect(renderToStaticMarkup(recovered)).toContain('공구 목록의 위치가 올바르지 않아 처음부터 표시합니다.');
  expect(adminNavigationFromForm(formData(forms(recovered, 'review')[0]))).toEqual({
    deal_status: state.deal_status, queue_cursor: state.queue_cursor, candidate_cursor: state.candidate_cursor,
  });
  const correct = forms(tree, 'correctDeal')[0], withdraw = forms(tree, 'withdrawDeal')[0];
  expect(await target(correct, { reason: 'short' })).toBe(adminUrl(state, {}, 'deal'));
  expect(await target(correct, { reason: 'Offline documented correction reason', title: 'Edited fixture' })).toBe(adminUrl(state));
  expect(await target(withdraw, { confirm_withdrawal: 'on', reason: 'Offline documented withdrawal reason' })).toBe(adminUrl(state, {}, 'deal_conflict'));
  expect(await target(withdraw)).toBe(adminUrl(state, {}, 'deal'));
  const seller = forms(tree, 'saveSeller')[0];
  expect(await target(seller)).toBe(adminUrl(state, {}, 'seller'));
  expect(await target(seller, { name: 'Offline added seller', source_url: 'https://example.com/offline-seller' })).toBe(adminUrl(state));
});

test.each(['queue', 'candidates'] as const)('%s page emptied by concurrent processing explains its position and retains restart', async list => {
  await seedReviewRows(memory.db, 'queue', 41); await seedReviewRows(memory.db, 'candidates', 41);
  const state = await laterState(20, 20);
  const tree = await page(state), stale = forms(tree, actions[list])[0];
  await memory.db.prepare(`UPDATE ${reviewTables[list]} SET status = ?`).bind(list === 'queue' ? 'rejected' : 'dismissed').run();
  expect(await target(stale, list === 'queue' ? { action: 'reject' } : {})).toBe(adminUrl(state, {}, list === 'queue' ? 'review_conflict' : 'review'));
  const empty = await page(state), html = renderToStaticMarkup(empty);
  expect(html).toContain(list === 'queue' ? '이 위치에 남아 있는 검수 대기 항목이 없습니다.' : '이 위치에 남아 있는 외부 후보가 없습니다.');
  expect(forms(empty, actions[list])).toHaveLength(0);
  const links = navigation(empty, labels[list]); expect(links).toHaveLength(1);
  expect(links[0].props.children).toBe('처음부터');
  const ownKey = list === 'queue' ? 'queue_cursor' : 'candidate_cursor';
  const remaining = { ...state }; delete remaining[ownKey];
  expect(paramsFromHref(links[0].props.href!)).toEqual(remaining);
});

test.each(['queue', 'candidates'] as const)('invalid %s page cursors restart only that section and explain recovery', async list => {
  await seedReviewRows(memory.db, 'queue', 25); await seedReviewRows(memory.db, 'candidates', 25);
  const state = await laterState(20, 20), ownKey = list === 'queue' ? 'queue_cursor' : 'candidate_cursor';
  const other = list === 'queue' ? 'candidates' : 'queue';
  for (const cursor of ['', '!', 'a'.repeat(2049), [state[ownKey]!, state[ownKey]!], fixtureCursor([1, other, '2026-10-20T00:00:00Z', 'anchor'])]) {
    const tree = await page({ ...state, [ownKey]: cursor });
    expect(renderToStaticMarkup(tree)).toContain(list === 'queue' ? '검수 대기 목록의 위치가 올바르지 않아 처음부터 표시합니다.' : '외부 후보 목록의 위치가 올바르지 않아 처음부터 표시합니다.');
    expect(forms(tree, actions[list])).toHaveLength(20);
    expect(forms(tree, actions[other])).toHaveLength(5);
    const postedState = adminNavigationFromForm(formData(forms(tree, actions[list])[0]));
    const valid = { ...state }; delete valid[ownKey]; expect(postedState).toEqual(valid);
  }
});

test('return state is bounded and allowlisted, with duplicates, files, and external return URLs discarded', async () => {
  await seedReviewRows(memory.db, 'queue', 23); await seedReviewRows(memory.db, 'candidates', 23);
  const state = await laterState(20, 20), tree = await page(state), form = forms(tree, 'dismissCandidate')[0];
  const payload = formData(form);
  payload.set('return_to', 'https://untrusted.invalid/'); payload.set('nav_return_to', '//untrusted.invalid/');
  payload.set('nav_deal', 'https://untrusted.invalid/'); payload.set('nav_deal_status', 'x'.repeat(5000));
  payload.set('nav_deal_cursor', 'x'.repeat(5000)); payload.append('nav_queue_cursor', state.queue_cursor!);
  payload.set('nav_candidate_cursor', new File(['not a cursor'], 'cursor.txt'));
  expect(await target(form, {}, payload)).toBe('/admin');
  expect(adminUrl({ ...state, deal: '//untrusted.invalid/' })).toBe(adminUrl(state, { deal: undefined }));
});

test('an expired session cannot use captured navigation forms and no private reads occur before login', async () => {
  await seedReviewRows(memory.db, 'queue', 23); await seedReviewRows(memory.db, 'candidates', 23);
  const state = await laterState(20, 20), tree = await page(state);
  const handler = vi.spyOn(apiModule, 'handleApi'), prepare = vi.spyOn(memory.db, 'prepare');
  context.authenticated = false;
  expect(await target(forms(tree, 'review')[0], { action: 'reject' })).toBe('/admin?error=auth');
  expect(await target(forms(tree, 'dismissCandidate')[0])).toBe('/admin?error=auth');
  const html = renderToStaticMarkup(await page({ queue_cursor: '!', candidate_cursor: '!' }));
  expect(html).toContain('ADMIN_TOKEN'); expect(html).not.toContain('Synthetic caption');
  expect(handler).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});

test.each(['queue', 'candidates'] as const)('%s database errors propagate instead of silently resetting or emptying the section', async (list: ReviewList) => {
  const prepare = memory.db.prepare.bind(memory.db);
  vi.spyOn(memory.db, 'prepare').mockImplementation(sql => {
    if (sql.includes(`SELECT * FROM ${reviewTables[list]}`)) throw new Error('Synthetic D1 read failure');
    return prepare(sql);
  });
  await expect(page()).rejects.toThrow('Synthetic D1 read failure');
});
