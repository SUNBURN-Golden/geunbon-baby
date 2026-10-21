import { DealImage } from '../deals/_image';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { authorized, handleApi, parseStoredSuggestions } from '../../lib/api';
import { environment, all } from '../../lib/db';
import type { Model, Seller } from '../../lib/data';
export const dynamic = 'force-dynamic';
async function authenticated() {
  const token = (await cookies()).get('agamajung_admin')?.value;
  return authorized(new Request('https://local.invalid', { headers: { authorization: `Bearer ${token ?? ''}` } }), environment().ADMIN_TOKEN);
}
async function login(form: FormData) {
  'use server';
  const token = String(form.get('token') ?? '');
  if (!await authorized(new Request('https://local.invalid', { headers: { authorization: `Bearer ${token}` } }), environment().ADMIN_TOKEN)) redirect('/admin?error=auth');
  await (await cookies()).set('agamajung_admin', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/admin', maxAge: 3600 });
  redirect('/admin');
}
async function logout() { 'use server'; await (await cookies()).delete('agamajung_admin'); redirect('/admin'); }
async function review(form: FormData) {
  'use server';
  if (!await authenticated()) redirect('/admin?error=auth');
  const env = environment();
  const payload = Object.fromEntries(form.entries());
  const response = await handleApi(new Request('https://local.invalid', { method: 'POST', headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` }, body: JSON.stringify({ ...payload, include_image: form.get('include_image') === 'on', price: payload.price === '' ? null : Number(payload.price) }) }), ['admin', 'review', String(form.get('id'))], env);
  if (!response.ok) redirect('/admin?error=review');
  revalidatePath('/admin'); redirect('/admin');
}
export default async function Admin({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (!await authenticated()) return <main className="page narrow"><p className="eyebrow">PRIVATE REVIEW DESK</p><h1>관리자 검수</h1>{error && <p role="alert">인증에 실패했습니다.</p>}<form action={login}><label>ADMIN_TOKEN<input name="token" type="password" required autoComplete="off"/></label><button>안전하게 들어가기</button></form></main>;
  const db = environment().DB;
  const queue = await all<{ id: string; source_url: string; account: string; text: string; captured_at: string; suggestions: string | null; image_url: string | null }>(db, "SELECT * FROM ingested_items WHERE status = 'pending' ORDER BY captured_at LIMIT 100");
  const models = await all<Model>(db, 'SELECT * FROM models'); const sellers = await all<Seller>(db, 'SELECT * FROM sellers');
  const percent = (c: number) => `${Math.round(c * 100)}%`;
  return <main className="page"><h1>게시 전 검수</h1><form action={logout}><button>로그아웃</button></form>{error && <p role="alert">검수 처리에 실패했습니다. 입력값 및 이미 처리된 항목인지 확인하세요.</p>}<p>수집 원문을 직접 확인한 뒤 모델·판매자·정확한 가격·일정을 지정하세요. 불명확한 가격은 비워 두세요. 판매자가 등록되어 있지 않으면 게시할 수 없습니다.</p>{!queue.length && <div className="empty">검수를 기다리는 항목이 없습니다.</div>}{queue.map(item => { const hint = item.suggestions ? parseStoredSuggestions(item.suggestions) : null; return <article className="seller" key={item.id}><h2>{item.account}</h2><a href={item.source_url} target="_blank" rel="noopener noreferrer">원문 확인 ↗</a><DealImage src={item.image_url} alt={`${item.account} 수집 원문 이미지`}/><pre>{item.text}</pre><p>{item.captured_at}</p>{hint && <details><summary>자동 추출 제안 (오류 가능 · 원문 대조 필수)</summary><ul>{hint.models.map(m => <li key={m.model_id}>모델 후보 {m.brand} {m.name} · 근거 {m.matched.join(', ')} · 신뢰도 {percent(m.confidence)}</li>)}{hint.price && <li>가격 후보 {hint.price.value.toLocaleString('ko-KR')}원 · 근거 {hint.price.raw} · 신뢰도 {percent(hint.price.confidence)}</li>}{hint.dates && <li>일정 후보 {hint.dates.starts_at ?? '?'} ~ {hint.dates.ends_at ?? '?'} · 근거 {hint.dates.raw} · 신뢰도 {percent(hint.dates.confidence)}</li>}{hint.links.map((l, i) => <li key={i}>{l.kind === 'link_in_bio' ? '프로필 링크 안내(원문 프로필에서 직접 확인)' : <>링크 후보 <a href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a></>} · 신뢰도 {percent(l.confidence)}</li>)}</ul><p className="muted">제안은 캡션·OCR 텍스트의 자동 해석일 뿐 값이 그대로 게시되지 않습니다.</p></details>}<form action={review}><input type="hidden" name="id" value={item.id}/>{item.image_url && <label className="image-choice"><input type="checkbox" name="include_image" defaultChecked/>이미지 포함</label>}<label>모델<select name="model_id">{models.map(m => <option key={m.id} value={m.id}>{m.brand} {m.name}</option>)}</select></label><label>판매자<select name="seller_id">{sellers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>게시 제목<input name="title" maxLength={200}/></label><label>공구가(원, 미확인 시 공란)<input name="price" type="number" min="0" step="1"/></label><label>시작(시간대 포함 ISO)<input name="starts_at" placeholder="2026-10-21T09:00:00+09:00"/></label><label>종료(시간대 포함 ISO)<input name="ends_at" placeholder="2026-10-25T23:59:00+09:00"/></label><button name="action" value="approve">근거 확인 후 승인</button> <button name="action" value="reject">반려</button></form></article>; })}</main>;
}
