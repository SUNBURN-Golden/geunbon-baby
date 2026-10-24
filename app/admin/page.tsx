import { collectionStatus } from '../../lib/collection-status';
import { STATUSES, LABELS } from '../../shared/collection-schema';
import { DealImage } from '../deals/_image';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { adminDeal, adminDealsPage, adminSellersData, authorized, handleApi, normalizeAccount, parseStoredSuggestions, serviceTokens } from '../../lib/api';
import { environment, all } from '../../lib/db';
import { EXTERNAL_SOURCES, money, type ExternalCandidate, type Model, type Seller } from '../../lib/data';
export const dynamic = 'force-dynamic';
const ADMIN_COOKIE = 'agamajung_admin';
// Shared by login and logout: replacing/expiring a cookie requires the same name, path and domain.
const adminCookie = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/admin' } as const);
const adminToken = () => serviceTokens(environment())?.admin ?? null;
async function authenticated() {
  const expected = adminToken();
  if (!expected) return false;
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  return authorized(new Request('https://local.invalid', { headers: { authorization: `Bearer ${token ?? ''}` } }), expected);
}
async function login(form: FormData) {
  'use server';
  const expected = adminToken();
  if (!expected) redirect('/admin?error=config');
  const token = String(form.get('token') ?? '');
  if (!await authorized(new Request('https://local.invalid', { headers: { authorization: `Bearer ${token}` } }), expected)) redirect('/admin?error=auth');
  await (await cookies()).set(ADMIN_COOKIE, token, { ...adminCookie(), maxAge: 3600 });
  redirect('/admin');
}
async function logout() { 'use server'; await (await cookies()).set(ADMIN_COOKIE, '', { ...adminCookie(), maxAge: 0, expires: new Date(0) }); redirect('/admin'); }
async function adminAction(parts: string[], body: Record<string, unknown>, errorCode: 'review' | 'seller' | 'deal' | 'deal_conflict', conflictCode?: 'deal_conflict') {
  if (!await authenticated()) redirect('/admin?error=auth');
  const token = adminToken();
  if (!token) redirect('/admin?error=config');
  const response = await handleApi(new Request('https://local.invalid', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), parts, environment());
  if (!response.ok) redirect(`/admin?error=${response.status === 409 && conflictCode ? conflictCode : errorCode}`);
  revalidatePath('/admin'); redirect('/admin');
}
async function review(form: FormData) {
  'use server';
  const payload = Object.fromEntries(form.entries());
  await adminAction(['admin', 'review', String(form.get('id'))], {
    ...payload, include_image: form.get('include_image') === 'on', price: payload.price === '' ? null : Number(payload.price),
  }, 'review');
}
async function correctDeal(form: FormData) {
  'use server';
  await adminAction(['admin', 'deals', String(form.get('deal_id'))], {
    action: 'correct', expected_version: Number(form.get('expected_version')), request_id: form.get('request_id'), reason: form.get('reason'),
    model_id: form.get('model_id'), title: form.get('title'), price: form.get('price') === '' ? null : Number(form.get('price')),
    starts_at: form.get('starts_at'), ends_at: form.get('ends_at'), include_image: form.get('include_image') === 'on',
  }, 'deal', 'deal_conflict');
}
async function withdrawDeal(form: FormData) {
  'use server';
  if (!await authenticated()) redirect('/admin?error=auth');
  if (form.get('confirm_withdrawal') !== 'on') redirect('/admin?error=deal');
  await adminAction(['admin', 'deals', String(form.get('deal_id'))], {
    action: 'withdraw', expected_version: Number(form.get('expected_version')), request_id: form.get('request_id'), reason: form.get('reason'),
  }, 'deal', 'deal_conflict');
}
async function dismissCandidate(form: FormData) {
  'use server';
  await adminAction(['admin', 'candidates', String(form.get('candidate_id'))], { action: 'dismiss' }, 'review');
}
async function saveSeller(form: FormData) {
  'use server';
  const id = form.get('seller_id');
  await adminAction(id ? ['admin', 'sellers', String(id)] : ['admin', 'sellers'], {
    ...Object.fromEntries(form.entries()), action: 'update', account_reviewed: form.get('account_reviewed') === 'on',
  }, 'seller');
}
async function linkSeller(form: FormData) {
  'use server';
  await adminAction(['admin', 'sellers', String(form.get('seller_id') ?? '')], {
    action: 'link_account', account: form.get('account'), account_reviewed: form.get('account_reviewed') === 'on',
  }, 'seller');
}
async function unlinkSeller(form: FormData) {
  'use server';
  await adminAction(['admin', 'sellers', String(form.get('seller_id'))], { action: 'unlink_account', account: form.get('account') }, 'seller');
}
function sellerFields(seller?: Seller) {
  return <>
    <label>판매자 이름<input name="name" required maxLength={100} defaultValue={seller?.name ?? ''}/></label>
    <label>판매처 출처 URL (HTTPS)<input name="source_url" type="url" required defaultValue={seller?.source_url ?? ''}/></label>
    <label>통신판매업 신고 증빙 (비워 두면 미확인)<input name="registration_source" type="url" defaultValue={seller?.registration_source ?? ''}/></label>
    <label>청약철회 7일 증빙 (비워 두면 미확인)<input name="withdrawal_source" type="url" defaultValue={seller?.withdrawal_source ?? ''}/></label>
    <label>정식수입 증빙 (비워 두면 미확인)<input name="official_import_source" type="url" defaultValue={seller?.official_import_source ?? ''}/></label>
  </>;
}
export default async function Admin({ searchParams }: { searchParams: Promise<{ error?: string; deal?: string; deal_status?: string; deal_cursor?: string }> }) {
  const { error, deal, deal_status, deal_cursor } = await searchParams;
  if (!adminToken()) return <main className="page narrow"><p className="eyebrow">PRIVATE REVIEW DESK</p><h1>관리자 검수</h1><p role="alert">관리자 인증 설정을 확인해야 합니다. 운영자에게 문의하세요.</p></main>;
  if (!await authenticated()) return <main className="page narrow"><p className="eyebrow">PRIVATE REVIEW DESK</p><h1>관리자 검수</h1>{error && <p role="alert">인증에 실패했습니다.</p>}<form action={login}><label>ADMIN_TOKEN<input name="token" type="password" required autoComplete="off"/></label><button>안전하게 들어가기</button></form></main>;
  const db = environment().DB;
  const collector = await collectionStatus(db).catch(() => ({synced:false, workers:[]}));
  const queue = await all<{ id: string; source_url: string; account: string; text: string; captured_at: string; suggestions: string | null; image_url: string | null }>(db, "SELECT * FROM ingested_items WHERE status = 'pending' ORDER BY captured_at LIMIT 100");
  const candidates = await all<ExternalCandidate>(db, "SELECT * FROM external_candidates WHERE status = 'candidate' ORDER BY captured_at LIMIT 200");
  const models = await all<Model>(db, 'SELECT * FROM models');
  const { sellers, unlinked_accounts: unlinked } = await adminSellersData(db);
  let dealStatus = deal_status ?? 'published';
  let dealPage: Awaited<ReturnType<typeof adminDealsPage>>;
  if (deal) {
    const found = await adminDeal(db, deal);
    dealPage = { data: found ? [found] : [], next_cursor: null };
  } else {
    try { dealPage = await adminDealsPage(db, { status: dealStatus, limit: 20, cursor: deal_cursor }); }
    catch { dealStatus = 'published'; dealPage = await adminDealsPage(db); }
  }
  const percent = (c: number) => `${Math.round(c * 100)}%`;
  return <main className="page"><h1>게시 전 검수</h1><section><h2>로컬 수집함 현황</h2>{!collector.synced ? <p>미동기화</p> : collector.workers.map(w => <article key={w.snapshot.worker_id}><p>{w.snapshot.worker_id} · {w.stale ? '동기화 지연' : '동기화됨'}</p><ul>{STATUSES.map(s => <li key={s}>{LABELS[s]}: {w.snapshot.counts[s]}</li>)}</ul><p>생성 {w.snapshot.generated_at} · 수신 {w.received_at}</p><p>공개 대기는 실제 게시를 실행하지 않습니다.</p></article>)}</section><form action={logout}><button>로그아웃</button></form>{error && <p role="alert">{error === 'deal' ? '공구 정정·철회에 실패했습니다. 입력값을 확인하세요.' : error === 'deal_conflict' ? '다른 관리자가 먼저 변경했거나 이미 처리된 요청입니다. 새로고침 후 다시 확인하세요.' : error === 'seller' ? '판매자 등록·증빙 처리에 실패했습니다. 입력값·계정 검수 확인·기존 연결을 확인하세요.' : '검수 처리에 실패했습니다. 입력값 및 이미 처리된 항목인지 확인하세요.'}</p>}<p>수집 원문을 직접 확인한 뒤 모델·판매자·정확한 가격·일정을 지정하세요. 불명확한 가격은 비워 두세요. 판매자가 등록되어 있지 않으면 게시할 수 없습니다.</p>{!queue.length && <div className="empty">검수를 기다리는 항목이 없습니다.</div>}{queue.map(item => { const hint = item.suggestions ? parseStoredSuggestions(item.suggestions) : null; const account = normalizeAccount(item.account); const linkedSeller = account ? sellers.find(s => s.accounts.includes(account)) : undefined; return <article className="seller" key={item.id}><h2>{item.account}</h2><a href={item.source_url} target="_blank" rel="noopener noreferrer">원문 확인 ↗</a><DealImage src={item.image_url} alt={`${item.account} 수집 원문 이미지`}/><pre>{item.text}</pre><p>{item.captured_at}</p>{hint && <details><summary>자동 추출 제안 (오류 가능 · 원문 대조 필수)</summary><ul>{hint.models.map(m => <li key={m.model_id}>모델 후보 {m.brand} {m.name} · 근거 {m.matched.join(', ')} · 신뢰도 {percent(m.confidence)}</li>)}{hint.price && <li>가격 후보 {hint.price.value.toLocaleString('ko-KR')}원 · 근거 {hint.price.raw} · 신뢰도 {percent(hint.price.confidence)}</li>}{hint.dates && <li>일정 후보 {hint.dates.starts_at ?? '?'} ~ {hint.dates.ends_at ?? '?'} · 근거 {hint.dates.raw} · 신뢰도 {percent(hint.dates.confidence)}</li>}{hint.links.map((l, i) => <li key={i}>{l.kind === 'link_in_bio' ? '프로필 링크 안내(원문 프로필에서 직접 확인)' : <>링크 후보 <a href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a></>} · 신뢰도 {percent(l.confidence)}</li>)}</ul><p className="muted">제안은 캡션·OCR 텍스트의 자동 해석일 뿐 값이 그대로 게시되지 않습니다.</p></details>}<form action={review}><input type="hidden" name="id" value={item.id}/>{item.image_url && <label className="image-choice"><input type="checkbox" name="include_image" defaultChecked/>이미지 포함</label>}<label>모델<select name="model_id" required defaultValue=""><option value="" disabled>선택하세요</option>{models.map(m => <option key={m.id} value={m.id}>{m.brand} {m.name}</option>)}</select></label><label>판매자<select name="seller_id" required defaultValue=""><option value="" disabled>선택하세요</option>{sellers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>{linkedSeller && <p>연결된 판매자: {linkedSeller.name}</p>}
      <fieldset><legend>판매자 귀속 근거 (필수 선택)</legend>
        <label><input type="radio" name="attribution" value="account" required disabled={!linkedSeller}/>원문 계정 {account ? `@${account}` : item.account}의 연결 판매자</label>
        <label><input type="radio" name="attribution" value="explicit" required/>다른 판매자로 명시 귀속</label>
        <label>명시 귀속 사유 (선택 시 10–300자)<textarea name="attribution_note" maxLength={300}/></label>
      </fieldset><label>게시 제목<input name="title" maxLength={200}/></label><label>공구가(원, 미확인 시 공란)<input name="price" type="number" min="0" step="1"/></label><label>시작(시간대 포함 ISO)<input name="starts_at" placeholder="2026-10-21T09:00:00+09:00"/></label><label>종료(시간대 포함 ISO)<input name="ends_at" placeholder="2026-10-25T23:59:00+09:00"/></label><button name="action" value="approve">근거 확인 후 승인</button> <button name="action" value="reject" formNoValidate>반려</button></form></article>; })}    <section><h2>게시된 공구 정정·철회</h2>
      <nav aria-label="게시 상태"><a href="/admin?deal_status=published">게시 중</a> · <a href="/admin?deal_status=withdrawn">철회됨</a> · <a href="/admin?deal_status=all">전체</a></nav>
      <form action="/admin" method="get"><label>공구 ID로 찾기<input name="deal" defaultValue={deal ?? ''}/></label><button>찾기</button></form>
      {!dealPage.data.length && <p>{deal ? '해당 공구가 없습니다' : '해당 상태의 공구가 없습니다'}</p>}
      {dealPage.data.map(item => <article className="seller" key={item.id} data-deal-id={item.id}>
        <h3>{item.title}</h3><p>{item.id} · {item.status} · v{item.version}</p>
        {item.evidence && <details><summary>보존된 수집 원문·검수 근거</summary>
          <a href={item.evidence.source_url} target="_blank" rel="noopener noreferrer">원문 링크 ↗</a>
          <pre>{item.evidence.text}</pre><p>{item.evidence.account} · 수집 {item.evidence.captured_at}</p>
          <DealImage src={item.evidence.image_url} alt={`${item.title} 수집 원문 이미지`}/>
          <p>귀속 {item.evidence.attribution} · {item.evidence.attribution_note} · 검수 {item.evidence.reviewed_at}</p>
        </details>}
        <p>현재 값: {item.model_id} · 판매자 {item.seller_id} · {money(item.price)} · {item.starts_at} ~ {item.ends_at}</p>
        <DealImage src={item.image_url} alt={`${item.title} 게시 이미지`}/>
        <ol>{item.revisions.map(revision => <li key={revision.id}>v{revision.version} · {revision.action} · {revision.created_at} · {revision.reason}</li>)}</ol>
        {item.status === 'published' && <>
          <form action={correctDeal}>
            <input type="hidden" name="deal_id" value={item.id}/><input type="hidden" name="expected_version" value={item.version}/><input type="hidden" name="request_id" value={crypto.randomUUID()}/>
            <label>모델<select name="model_id" required defaultValue={item.model_id}>{models.map(model => <option key={model.id} value={model.id}>{model.brand} {model.name}</option>)}</select></label>
            <label>제목<input name="title" required maxLength={200} defaultValue={item.title}/></label>
            <label>공구가(원, 미확인 시 공란)<input name="price" type="number" min="0" step="1" defaultValue={item.price ?? ''}/></label>
            <label>시작(시간대 포함 ISO)<input name="starts_at" required defaultValue={item.starts_at}/></label>
            <label>종료(시간대 포함 ISO)<input name="ends_at" required defaultValue={item.ends_at}/></label>
            {item.evidence?.image_url && <label><input type="checkbox" name="include_image" defaultChecked={!!item.image_url}/>이미지 포함</label>}
            <label>정정 사유<textarea name="reason" required minLength={10} maxLength={300}/></label><button>정정</button>
          </form>
          <form action={withdrawDeal}>
            <input type="hidden" name="deal_id" value={item.id}/><input type="hidden" name="expected_version" value={item.version}/><input type="hidden" name="request_id" value={crypto.randomUUID()}/>
            <label>철회 사유<textarea name="reason" required minLength={10} maxLength={300}/></label>
            <label><input type="checkbox" name="confirm_withdrawal" required/>공개 화면에서 내림을 확인함</label><button>철회</button>
          </form>
        </>}
      </article>)}
      {dealPage.next_cursor && <a href={`/admin?deal_status=${encodeURIComponent(dealStatus)}&deal_cursor=${encodeURIComponent(dealPage.next_cursor)}`}>다음 20건</a>}
    </section>
<section><h2>판매자 등록·증빙</h2>
    <p>원문을 확인해 판매자를 등록하고 증빙을 관리하세요. 계정 연결은 직접 검수한 경우에만 설정합니다. 증빙이 없으면 배지는 미확인입니다.</p>
    <form action={saveSeller}><h3>새 판매자 등록</h3>{sellerFields()}
      <label>연결할 Instagram handle (선택)<input name="account" defaultValue="" maxLength={100}/></label>
      <label><input type="checkbox" name="account_reviewed"/>원문 계정이 이 판매자임을 직접 확인함</label>
      <button>판매자 등록</button>
    </form>
    <h3>새로 수집된 계정</h3>
    {!unlinked.length && <p>연결되지 않은 수집 계정이 없습니다.</p>}
    {unlinked.filter(a => a.normalized).map(a => <article className="seller" key={a.account}><h4>{a.account} · 검수 대기 {a.pending}건</h4>
      <form action={linkSeller}><input type="hidden" name="account" value={a.normalized!}/>
        <label>기존 판매자<select name="seller_id" required defaultValue=""><option value="" disabled>선택하세요</option>{sellers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label><input type="checkbox" name="account_reviewed" required/>원문 계정이 이 판매자임을 직접 확인함</label>
        <button>기존 판매자에 연결</button>
      </form>
    </article>)}
    {unlinked.some(a => !a.normalized) && <div><h3>핸들이 아닌 수집 계정 — 명시 귀속만 가능</h3>{unlinked.filter(a => !a.normalized).map(a => <p key={a.account}>{a.account} · 검수 대기 {a.pending}건</p>)}</div>}
    <h3>등록된 판매자</h3>
    {sellers.map(s => <article className="seller" key={s.id}><h4>{s.name}</h4>
      <form action={saveSeller}><input type="hidden" name="seller_id" value={s.id}/>{sellerFields(s)}<button>증빙 저장</button></form>
      <p>연결 계정 {s.accounts.length ? '' : '없음'}</p>
      {s.accounts.map(account => <form action={unlinkSeller} key={account}><input type="hidden" name="seller_id" value={s.id}/><input type="hidden" name="account" value={account}/><span>@{account} </span><button>계정 연결 해제</button></form>)}
    </article>)}
  </section><section><h2>외부 공구 모음 후보</h2><p>지난 가격 또는 AI 요약일 수 있어 공구가로 게시되지 않습니다. Instagram 원문을 찾아 검수하세요.</p>{!candidates.length && <div className="empty">확인할 외부 후보가 없습니다.</div>}{candidates.map(c => <article className="seller" key={c.id}><h3>{c.title}</h3><p>{(EXTERNAL_SOURCES as Record<string, { name: string }>)[c.source]?.name ?? c.source} · <a href={c.source_url} target="_blank" rel="noopener noreferrer">출처 확인 ↗</a>{c.seller_handle && <> · 셀러 @{c.seller_handle}</>}</p><p>가격 힌트(참고용) {money(c.price_hint)}{c.price_raw && <> · 원문 {c.price_raw}</>} · 일정 {c.dates_raw ?? c.starts_at ?? '정보 없음'}</p><p>수집 {c.captured_at} · 마지막 확인 {c.last_seen_at} · 시드 모델 매칭 {c.model_match ? '예' : '아니오'}</p><form action={dismissCandidate}><input type="hidden" name="candidate_id" value={c.id}/><button>확인 완료</button></form></article>)}</section></main>;
}
