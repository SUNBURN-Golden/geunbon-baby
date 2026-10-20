"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/models", label: "모델" },
  { href: "/group-buys", label: "공구" },
  { href: "/submit", label: "제보" },
  { href: "/legal", label: "안내" },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="wrap site-header">
      <Link href="/" className="brand-mark">
        <strong>근본</strong>
        <span>프리미엄 기어 시세</span>
      </Link>
      <nav className="nav" aria-label="주요">
        {links.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
