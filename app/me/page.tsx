import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { deleteSession, readSession, SESSION_COOKIE, setNewsletter } from '../../lib/auth';
import { authCopy } from '../../lib/auth-copy';
import { environment } from '../../lib/db';
export const dynamic = 'force-dynamic';
export const metadata = { title: authCopy.meTitle };
async function current() {
  return readSession(environment().DB, (await cookies()).get(SESSION_COOKIE)?.value);
}
async function toggleNewsletter(form: FormData) {
  'use server';
  const session = await current();
  if (!session) redirect('/login');
  await setNewsletter(environment().DB, session.userId, form.get('opt_in') === '1', new Date());
  revalidatePath('/me'); redirect('/me');
}
async function logout() {
  'use server';
  const store = await cookies();
  await deleteSession(environment().DB, store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  redirect('/login');
}
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '정보 없음';
export default async function Me() {
  const session = await current();
  if (!session) redirect('/login');
  return <main className="page public-page narrow">
    <p className="eyebrow">MY ACCOUNT</p>
    <h1>{authCopy.meTitle}</h1>
    <dl>
      <dt>{authCopy.email}</dt><dd>{session.email}</dd>
      <dt>{authCopy.joinedWith}</dt><dd>{session.providers.map(p => authCopy.providers[p]).join(', ')}</dd>
      <dt>{authCopy.joinedAt}</dt><dd>{when(session.createdAt)}</dd>
      <dt>{authCopy.newsletter}</dt><dd>{session.newsletterOptIn ? authCopy.subscribed : authCopy.unsubscribed}</dd>
      {session.newsletterOptIn && session.consentedAt && <><dt>{authCopy.consentedAt}</dt><dd>{when(session.consentedAt)}</dd></>}
      {!session.newsletterOptIn && session.withdrawnAt && <><dt>{authCopy.withdrawnAt}</dt><dd>{when(session.withdrawnAt)}</dd></>}
    </dl>
    <form action={toggleNewsletter}>
      <button name="opt_in" value={session.newsletterOptIn ? '0' : '1'}>{session.newsletterOptIn ? authCopy.unsubscribe : authCopy.resubscribe}</button>
    </form>
    <form action={logout}><button>{authCopy.logout}</button></form>
  </main>;
}
