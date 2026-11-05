import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { configuredProviders, readSession, SESSION_COOKIE } from '../../lib/auth';
import { authCopy } from '../../lib/auth-copy';
import { environment } from '../../lib/db';
export const dynamic = 'force-dynamic';
export const metadata = { title: authCopy.loginTitle };
const errors = authCopy.errors as Record<string, string>;
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const env = environment();
  if (await readSession(env.DB, (await cookies()).get(SESSION_COOKIE)?.value)) redirect('/me');
  const providers = configuredProviders(env);
  const message = error ? errors[error] : undefined;
  return <main className="page public-page narrow">
    <p className="eyebrow">MEMBERS</p>
    <h1>{authCopy.loginTitle}</h1>
    <p className="lead">{authCopy.loginLead}</p>
    {message && <p role="alert">{message}</p>}
    {providers.length === 0 ? <p>{authCopy.unavailable}</p> : <form method="get">
      <label className="consent"><input type="checkbox" name="newsletter" defaultChecked />{authCopy.newsletterConsent}</label>
      <p className="muted">{authCopy.collectNotice}</p>
      <p className="muted">{authCopy.withdrawNotice}</p>
      <div className="auth-buttons">
        {providers.map(p => <button key={p} type="submit" formAction={`/api/auth/login/${p}`}>{authCopy[p]}</button>)}
      </div>
    </form>}
  </main>;
}
