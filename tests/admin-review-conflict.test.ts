import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import * as apiModule from '../lib/api';
import { adminNavigationFromForm, adminUrl, type AdminNavigation, type AdminSearchParams } from '../lib/admin-navigation';
import { seedReviewRows } from './helpers/admin-pagination';
import { api, approval, migrate } from './helpers/deal-timestamps';
import { LOSER_TIME, WINNER_TIME, rejectionGate, reviewSnapshot } from './helpers/review-race';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, session: '' }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'timestamp-admin-test-only', INGEST_TOKEN: 'timestamp-ingest-test-only' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: context.session }) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); } }));

type Action = (form: FormData) => Promise<void>;
type Props = { children?: ReactNode; name?: string; value?: string; action?: string | Action; role?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : []);
}
function reviews(node: ReactNode) {
  return elements(node).filter(n => n.type === 'form' && typeof n.props.action === 'function' && n.props.action.name === 'review');
}
function payload(node: ReactNode, action: 'approve' | 'reject' = 'reject') {
  const form = new FormData();
  for (const field of elements(node).filter(n => n.type === 'input' && n.props.name?.startsWith('nav_'))) {
    form.set(field.props.name!, field.props.value!);
  }
  form.set('id', elements(node).find(n => n.props.name === 'id')!.props.value!);
  form.set('action', action);
  return form;
}
async function destination(form: ReactElement<Props>, data: FormData) {
  try { await (form.props.action as Action)(data); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT:')) return error.message.slice('NEXT_REDIRECT:'.length);
    throw error;
  }
  throw new Error('Expected a server action redirect');
}
const page = (params: AdminSearchParams = {}) => Admin({ searchParams: Promise.resolve(params) });
const approved = () => approval('2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z');
const alert = '검수 상태가 변경되었습니다. 다른 요청에서 이미 승인 또는 반려했습니다. 새로고침 후 현재 상태를 확인하세요.';
const id = 'queue-0020';
let memory: ReturnType<typeof memoryD1>;
let state: AdminNavigation;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LOSER_TIME);
  context.session = await apiModule.issueAdminSession('timestamp-admin-test-only');
  memory = memoryD1(); context.db = memory.db;
  await migrate(memory.db);
  await seedReviewRows(memory.db, 'queue', 22);
  await seedReviewRows(memory.db, 'candidates', 22);
  state = {
    deal: id, deal_status: 'all',
    deal_cursor: Buffer.from('9999-01-01T00:00:00.000Z|offline-anchor').toString('base64url'),
    queue_cursor: (await apiModule.adminQueuePage(memory.db, { limit: 20 })).next_cursor!,
    candidate_cursor: (await apiModule.adminCandidatesPage(memory.db, { limit: 20 })).next_cursor!,
  };
});
afterEach(() => { vi.useRealTimers(); memory.close(); });

test.each(['approve', 'reject'] as const)('rendered rejection losing to %s redirects to the review conflict alert and reloads the queue', async action => {
  const form = reviews(await page(state))[0];
  const data = payload(form);
  expect(data.get('id')).toBe(id);
  expect(adminNavigationFromForm(data)).toEqual(state);
  const gate = rejectionGate(memory.db);
  context.db = gate.db;
  const original = apiModule.handleApi;
  const responses: Response[] = [];
  vi.spyOn(apiModule, 'handleApi').mockImplementation(async (request, parts, env) => {
    const response = await original(request, parts, env);
    if (env.DB === gate.db) responses.push(response.clone());
    return response;
  });
  const loser = destination(form, data);
  let won!: Awaited<ReturnType<typeof reviewSnapshot>>;
  try {
    await gate.reached;
    expect((await reviewSnapshot(memory.db, id)).item).toMatchObject({ status: 'pending', reviewed_at: null });
    vi.setSystemTime(WINNER_TIME);
    const winner = await api(memory.db)(`admin/review/${id}`, action === 'approve' ? approved() : { action });
    expect(winner.status).toBe(200);
    won = await reviewSnapshot(memory.db, id);
    expect(won.item).toMatchObject({ status: action === 'approve' ? 'approved' : 'rejected', reviewed_at: WINNER_TIME });
    if (action === 'approve') {
      expect(won.deal).toMatchObject({ status: 'published', version: 1, withdrawn_at: null });
      expect(won.revisions).toHaveLength(1);
      expect(won.revisions[0]).toMatchObject({ deal_id: id, action: 'publish', version: 1 });
    } else {
      expect(won.deal).toBeNull(); expect(won.revisions).toEqual([]);
    }
  } finally { gate.release(); }
  const to = await loser;
  expect(to).toBe(adminUrl(state, {}, 'review_conflict'));
  expect(responses).toHaveLength(1);
  expect(responses[0].status).toBe(409);
  expect(await responses[0].json()).toEqual({ error: '이미 검수된 항목' });
  expect(await reviewSnapshot(memory.db, id)).toEqual(won);
  const refreshed = await page(Object.fromEntries(new URL(to, 'https://local.invalid').searchParams));
  const alerts = elements(refreshed).filter(n => n.props.role === 'alert');
  expect(alerts.some(n => n.props.children === alert)).toBe(true);
  expect(renderToStaticMarkup(refreshed)).toContain(alert);
  const remaining = reviews(refreshed);
  expect(remaining.map(n => payload(n).get('id'))).toEqual(['queue-0021']);
  expect(adminNavigationFromForm(payload(remaining[0]))).toEqual(state);
  expect(await reviewSnapshot(memory.db, id)).toEqual(won);
});

test.each(['approve', 'reject'] as const)('stale approval after %s uses the same conflict redirect and alert', async action => {
  const form = reviews(await page(state))[0];
  expect((await api(memory.db)(`admin/review/${id}`, action === 'approve' ? approved() : { action })).status).toBe(200);
  const before = await reviewSnapshot(memory.db, id);
  const to = await destination(form, payload(form, 'approve'));
  expect(to).toBe(adminUrl(state, {}, 'review_conflict'));
  const refreshed = await page(Object.fromEntries(new URL(to, 'https://local.invalid').searchParams));
  expect(renderToStaticMarkup(refreshed)).toContain(alert);
  expect(reviews(refreshed).map(n => payload(n).get('id'))).toEqual(['queue-0021']);
  expect(await reviewSnapshot(memory.db, id)).toEqual(before);
});
