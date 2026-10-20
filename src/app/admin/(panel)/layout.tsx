import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/admin/managers";
import { SESSION_COOKIE, verifySession } from "@/server/auth";

export const dynamic = "force-dynamic";

const links = [
  ["/admin", "개요"],
  ["/admin/brands", "브랜드"],
  ["/admin/models", "모델"],
  ["/admin/prices", "가격"],
  ["/admin/group-buys", "공구"],
  ["/admin/events", "행사"],
  ["/admin/submissions", "제보"],
  ["/admin/newsletter", "뉴스레터"],
];

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/admin/login");
  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="관리">
        <Link href="/">사이트로</Link>
        {links.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
        <LogoutButton />
      </nav>
      <div className="admin-main">{children}</div>
    </div>
  );
}
