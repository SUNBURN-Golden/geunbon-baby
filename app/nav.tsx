'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const items = [
  { label: '혜택가', href: '/deals', icon: 'M3 7h18v14H3z M2 3h20v4H2z M12 3v18 M7 12h10' },
  { label: '브랜드', href: '/models?by=brand', icon: 'M3 3h8l10 10-8 8L3 11V3Z M7 7h.01' },
  { label: '기준가', href: '/models', icon: 'M4 4v16h16 M7 8l5 5 7-7 M14 6h5v5' },
  { label: '소식지', href: '/#letter', icon: 'M3 5h18v14H3z M3 6l9 7 9-7' },
] as const;

type ActiveHref = Exclude<(typeof items)[number]['href'], '/#letter'>;

export function NavLinks({ activeHref }: { activeHref?: ActiveHref }) {
  return (
    <nav className="primary-nav" aria-label="주요 메뉴">
      {items.map(({ label, href, icon }) => (
        <Link className="nav-link" key={href} href={href} aria-current={activeHref === href ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d={icon} />
          </svg>
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

export default function Nav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  let activeHref: ActiveHref | undefined;

  if (pathname.startsWith('/deals')) {
    activeHref = '/deals';
  } else if (pathname === '/models' && searchParams.get('by') === 'brand') {
    activeHref = '/models?by=brand';
  } else if (pathname.startsWith('/models') && searchParams.get('by') !== 'brand') {
    activeHref = '/models';
  }

  return <NavLinks activeHref={activeHref} />;
}
