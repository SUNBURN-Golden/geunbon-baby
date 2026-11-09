import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import { GET } from '../app/api/v1/[[...path]]/route';
import { issueAdminSession } from '../lib/api';
import { seedReviewRows } from './helpers/admin-pagination';
import { migrate, publish } from './helpers/deal-timestamps';
import { malformedSnapshots, PRIVATE_MARKER, STATUS_NOW, statusSnapshot, storeStatus } from './helpers/collection-status';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, session: '' }));
const ADMIN_TOKEN = 'timestamp-admin-test-only';
const INGEST_TOKEN = 'timestamp-ingest-test-only';
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'timestamp-admin-test-only', INGEST_TOKEN: 'timestamp-ingest-test-only' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: context.session }) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT'); } }));

type Props = { children?: ReactNode; action?: string | ((form: FormData) => Promise<void>) };
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : []);
}
function actionForm(tree: ReactNode, name: string) {
  const form = elements(tree).find(node => node.type === 'form' && typeof node.props.action === 'function' && node.props.action.name === name);
  expect(form, `${name} form remains available`).toBeDefined();
  return form!;
}
const page = () => Admin({ searchParams: Promise.resolve({}) });
function collectorSection(html: string) {
  return html.slice(html.indexOf('<section>'), html.indexOf('</section>') + '</section>'.length);
}
function expectNoCounts(section: string) {
  expect(section).not.toMatch(/<ul>|<li>|생성 |수신 |offline-worker|동기화됨|동기화 지연/);
}
function expectFailure(html: string) {
  const section = collectorSection(html);
  expect(section).toContain('<p role="alert">수집 현황을 불러오지 못했습니다. 잠시 후 새로고침해 주세요. 문제가 계속되면 운영자에게 문의하세요.</p>');
  expect(section).not.toContain('미동기화');
  expectNoCounts(section);
  for (const secret of [PRIVATE_MARKER, ADMIN_TOKEN, INGEST_TOKEN, context.session]) expect(html).not.toContain(secret);
}
async function expectApiFailure() {
  const response = await GET(new Request('https://local.invalid/api/v1/admin/collection-status', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  }), { params: Promise.resolve({ path: ['admin', 'collection-status'] }) });
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: '데이터를 불러오지 못했습니다. DB 마이그레이션 상태를 확인해 주세요.' });
}

let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(STATUS_NOW);
  context.session = await issueAdminSession(ADMIN_TOKEN);
  memory = memoryD1(); context.db = memory.db;
  await migrate(memory.db);
  await publish(memory.db, 'collector-status-deal');
  await seedReviewRows(memory.db, 'queue', 1);
  await seedReviewRows(memory.db, 'candidates', 1);
});
afterEach(() => memory.close());

test('an authenticated empty table renders 미동기화 without counts or successful synchronization', async () => {
  const section = collectorSection(renderToStaticMarkup(await page()));
  expect(section).toContain('<p>미동기화</p>');
  expect(section).not.toContain('role="alert"');
  expectNoCounts(section);
});

test.each([
  { age: 0, label: '동기화됨' },
  { age: 3600000, label: '동기화됨' },
  { age: 3600001, label: '동기화 지연' },
])('an authenticated snapshot aged $age ms renders $label and actual stored data', async ({ age, label }) => {
  const snapshot = statusSnapshot({ generated_at: new Date(STATUS_NOW - age).toISOString() });
  await storeStatus(memory.db, JSON.stringify(snapshot));
  const section = collectorSection(renderToStaticMarkup(await page()));
  expect(section).toContain(`offline-worker · ${label}`);
  for (const count of ['후보: 11', '원문 확인: 7', '중복 제외: 3', '검증 완료: 5', '공개 대기: 2']) expect(section).toContain(count);
  expect(section).toContain(`생성 ${snapshot.generated_at} · 수신 ${new Date(STATUS_NOW).toISOString()}`);
  expect(section).not.toMatch(/미동기화|role="alert"/);
});

test('an authenticated valid zero-count snapshot renders synchronized zeros', async () => {
  await storeStatus(memory.db, JSON.stringify(statusSnapshot({
    counts: { discovered: 0, source_check_needed: 0, dedup_excluded: 0, verified_waiting: 0, ready_to_publish: 0 },
    total: 0, unique: 0, groups: 0,
  })));
  const section = collectorSection(renderToStaticMarkup(await page()));
  expect(section).toContain('동기화됨');
  expect(section.match(/: 0<\/li>/g)).toHaveLength(5);
  expect(section).not.toContain('미동기화');
});

test('multiple workers render separate freshness labels without summed counts', async () => {
  await storeStatus(memory.db);
  await storeStatus(memory.db, JSON.stringify(statusSnapshot({ worker_id: 'old-worker', generated_at: new Date(STATUS_NOW - 3600001).toISOString() })), undefined, 'old-worker');
  const section = collectorSection(renderToStaticMarkup(await page()));
  expect(section).toContain('offline-worker · 동기화됨');
  expect(section).toContain('old-worker · 동기화 지연');
  expect(section.match(/<article>/g)).toHaveLength(2);
  expect(section.match(/후보: 11/g)).toHaveLength(2);
});

test.each(['synchronous query error', 'asynchronous all rejection', 'unsuccessful D1 result'])('%s renders a private failure while other admin sections and candidate dismissal work', async failure => {
  const prepare = memory.db.prepare.bind(memory.db);
  vi.spyOn(memory.db, 'prepare').mockImplementation(sql => {
    if (!sql.includes('collector_status_snapshots')) return prepare(sql);
    if (failure === 'synchronous query error') throw new Error(`${PRIVATE_MARKER} ${ADMIN_TOKEN} ${INGEST_TOKEN}`);
    const statement = prepare(sql);
    if (failure === 'asynchronous all rejection') vi.spyOn(statement, 'all').mockRejectedValue(new Error(`${PRIVATE_MARKER} ${ADMIN_TOKEN}`));
    else vi.spyOn(statement, 'all').mockResolvedValue({ success: false, results: [], error: PRIVATE_MARKER } as unknown as D1Result);
    return statement;
  });
  const tree = await page(), html = renderToStaticMarkup(tree);
  expectFailure(html);
  for (const text of ['Synthetic caption queue-0000', 'Synthetic candidate candidates-0000', 'Test seller', 'Original collector-status-deal']) expect(html).toContain(text);
  for (const action of ['review', 'saveSeller', 'correctDeal', 'withdrawDeal', 'dismissCandidate', 'logout']) actionForm(tree, action);
  const dismiss = actionForm(tree, 'dismissCandidate').props.action as (form: FormData) => Promise<void>;
  const form = new FormData(); form.set('candidate_id', 'candidates-0000');
  await expect(dismiss(form)).rejects.toThrow('NEXT_REDIRECT');
  expect(await memory.db.prepare("SELECT status FROM external_candidates WHERE id = 'candidates-0000'").first()).toEqual({ status: 'dismissed' });
  const refreshed = renderToStaticMarkup(await page());
  expectFailure(refreshed);
  expect(refreshed).not.toContain('Synthetic candidate candidates-0000');
  await expectApiFailure();
});

test.each(malformedSnapshots)('$name renders failure without raw stored data and the API returns generic 503', async ({ payload, receivedAt }) => {
  await storeStatus(memory.db, payload, receivedAt);
  expectFailure(renderToStaticMarkup(await page()));
  await expectApiFailure();
});

test('mixed valid and invalid rows render only a failure, with no partial synchronization claims', async () => {
  await storeStatus(memory.db);
  await storeStatus(memory.db, `{"${PRIVATE_MARKER}":`, undefined, 'second-worker');
  expectFailure(renderToStaticMarkup(await page()));
});

test('a successful subsequent render clears a collector-only failure', async () => {
  const prepare = memory.db.prepare.bind(memory.db);
  const spy = vi.spyOn(memory.db, 'prepare').mockImplementation(sql => {
    if (sql.includes('collector_status_snapshots')) throw new Error(PRIVATE_MARKER);
    return prepare(sql);
  });
  expectFailure(renderToStaticMarkup(await page()));
  spy.mockRestore();
  await storeStatus(memory.db);
  const section = collectorSection(renderToStaticMarkup(await page()));
  expect(section).toContain('동기화됨');
  expect(section).toContain('후보: 11');
  expect(section).not.toMatch(/불러오지 못했습니다|role="alert"|미동기화/);
});

test('unauthenticated rendering performs no private reads even when D1 would fail', async () => {
  context.session = '';
  const prepare = vi.spyOn(memory.db, 'prepare').mockImplementation(() => { throw new Error(PRIVATE_MARKER); });
  const html = renderToStaticMarkup(await page());
  expect(html).toContain('안전하게 들어가기');
  expect(html).not.toMatch(/로컬 수집함 현황|불러오지 못했습니다|Synthetic caption|Synthetic candidate/);
  expect(prepare).not.toHaveBeenCalled();
});
