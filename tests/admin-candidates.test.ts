import { migrationStatements } from './helpers/migrations';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Admin from '../app/admin/page';
import { issueAdminSession } from '../lib/api';
import { verifiedDealsCopy } from '../lib/copy/deals.ko';
import { endsAt, exampleEvidence } from './helpers/verified-deal-prices';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined, session: '' }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db, ADMIN_TOKEN: 'fixture-admin-token-separation-0001', INGEST_TOKEN: 'fixture-ingest-token-separation-0002' }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: context.session }) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT'); } }));

let memory: ReturnType<typeof memoryD1>;
beforeEach(async () => {
  context.session = await issueAdminSession('fixture-admin-token-separation-0001');
  memory = memoryD1(); context.db = memory.db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const statement of migrationStatements(await readFile(new URL(file, dir), 'utf8'))) await memory.db.prepare(statement).run();
  }
  await memory.db.prepare("INSERT INTO external_candidates (id,source,source_url,title,text,seller_handle,price_hint,price_raw,dates_raw,model_match,captured_at,last_seen_at) VALUES ('cand-1','pangpang','https://09pangpang.com/deal/1','합성 후보 제목','합성 본문','synthetic_seller',390000,'390,000원','10/26~10/28',1,'2026-10-22T00:30:00.000Z','2026-10-22T09:30:00.000Z')").run();
});
afterEach(() => memory.close());

function dismissAction(node: ReactNode): (form: FormData) => Promise<void> {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; action?: (form: FormData) => Promise<void> }>(child)) continue;
    if (child.type === 'form' && Children.toArray(child.props.children).some(btn => isValidElement<{ children?: ReactNode }>(btn) && btn.type === 'button' && String(btn.props.children).includes('게시 안 함'))) {
      return child.props.action!;
    }
    if (child.props.children) { try { return dismissAction(child.props.children); } catch { /* siblings */ } }
  }
  throw new Error('Dismiss form not found');
}

test('the candidate section shows promote and dismiss controls with source metadata', async () => {
  const html = renderToStaticMarkup(await Admin({ searchParams: Promise.resolve({}) }));
  const section = html.slice(html.indexOf('외부 공구 모음 후보'));
  expect(section).toContain('원문·가격·일정을 확인한 뒤 공개 /deals로 게시');
  expect(section).toContain('공구팡팡');
  expect(section).toContain('href="https://09pangpang.com/deal/1"');
  expect(section).toContain('@synthetic_seller');
  expect(section).toContain('390,000원');
  expect(section).toContain('2026-10-22T00:30:00.000Z');
  expect(section).toContain('2026-10-22T09:30:00.000Z');
  expect(section).toContain('시드 모델 매칭 예');
  expect(section).toContain('원문 확인 후 /deals 게시');
  expect(section).toContain('확인 완료(게시 안 함)');
  expect(section).toContain('name="model_id"');
  expect(section).toContain('name="seller_id"');
});

test('확인 완료 dismisses through the admin API, after which the candidate disappears', async () => {
  const action = dismissAction(await Admin({ searchParams: Promise.resolve({}) }));
  const form = new FormData();
  form.set('candidate_id', 'cand-1');
  await expect(action(form)).rejects.toThrow('NEXT_REDIRECT');
  expect(await memory.db.prepare('SELECT status FROM external_candidates').first()).toEqual({ status: 'dismissed' });
  expect(await memory.db.prepare('SELECT COUNT(*) AS n FROM deals').first()).toEqual({ n: 0 });
  const html = renderToStaticMarkup(await Admin({ searchParams: Promise.resolve({}) }));
  expect(html).not.toContain('합성 후보 제목');
});

test('missing collector migration reports a load failure and leaves candidate controls available',async()=>{
 await memory.db.prepare('DROP TABLE collector_status_snapshots').run();
 const html=renderToStaticMarkup(await Admin({searchParams:Promise.resolve({})}));
 expect(html).toContain('수집 현황을 불러오지 못했습니다.');expect(html).not.toContain('미동기화');expect(html).toContain('합성 후보 제목');expect(html).toContain('확인 완료');expect(html).toContain('게시 전 검수');
});

async function stageObservation(kind: 'ingest' | 'candidate', target: string, revision: string, id: string, offer = 390000) {
  const proof = await exampleEvidence(`https://www.instagram.com/p/${id}/`, offer);
  await memory.db.prepare(`INSERT INTO deal_price_evidence (id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(id, kind, target, revision, 'configuration_mismatch', JSON.stringify(proof),
    '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z').run();
  await memory.db.prepare(`INSERT INTO deal_price_backfill_receipts (request_id,request_hash,outcome,observation_id,revision,operation_id)
    VALUES (?,?,?,?,?,?)`).bind(id.slice(0, 60) + 'receipt', 'h'.repeat(64), 'legacy_hash_missing', id, revision, 'operation').run();
}

test('a staged observation with no current head is the only and default evidence choice', async () => {
  const candidateEvidence = 'c'.repeat(64), queueEvidence = 'd'.repeat(64);
  await stageObservation('candidate', 'cand-1', 'legacy', candidateEvidence, 400000);
  await memory.db.prepare("INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES ('queue-1','https://www.instagram.com/p/queue-1/','fixture','fixture','post','2026-11-20T00:00:00.000Z')").run();
  await stageObservation('ingest', 'queue-1', '2026-11-20T00:00:00.000Z', queueEvidence);
  const html = renderToStaticMarkup(await Admin({ searchParams: Promise.resolve({}) }));
  const selectFor = (name: string, region: string) => {
    const start = html.indexOf(region);
    const end = name === 'queue' ? html.indexOf('게시된 공구 정정·철회', start) : html.length;
    const select = new RegExp('<select name="price_evidence_id">([\\s\\S]*?)</select>').exec(html.slice(start, end));
    expect(select, region).not.toBeNull();
    return select![1];
  };
  for (const [region, evidenceId] of [['소셜 공구 검수 대기', queueEvidence], ['외부 공구 모음 후보', candidateEvidence]] as const) {
    const select = selectFor(region.includes('소셜') ? 'queue' : 'candidate', region);
    // The empty "existing evidence" option used to submit '' (400) or a null
    // selection (promotion without proof) when no head existed.
    expect(select).not.toContain('value=""');
    expect(select).not.toContain(verifiedDealsCopy.currentEvidence);
    expect(select).toContain(`value="${evidenceId}"`);
    expect(select).toContain(`value="${evidenceId}" selected`);
  }
  // The promote form must also default to the observation's facts, otherwise
  // the API rejects the prefilled hint/legacy schedule against the evidence.
  const candidateSection = html.slice(html.indexOf('외부 공구 모음 후보'));
  expect(candidateSection).toMatch(/name="price" value="400000"/);
  expect(candidateSection).toContain(`name="ends_at" value="${endsAt}"`);
});
