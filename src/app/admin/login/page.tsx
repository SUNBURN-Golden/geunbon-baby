import { LoginForm } from "@/components/admin/managers";
import { devPasswordHint } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const nextPath = params.next?.startsWith("/admin") && !params.next.startsWith("//") ? params.next : "/admin";
  return (
    <section className="wrap section">
      <p className="kicker">관리</p>
      <h1 className="serif">로그인</h1>
      <LoginForm hint={devPasswordHint()} nextPath={nextPath} />
    </section>
  );
}
