import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { siteCopy } from '../lib/site-copy';
import Nav, { NavLinks } from './nav';
import './globals.css';

export const metadata: Metadata = {
  title: { default: siteCopy.title, template: siteCopy.titleTemplate },
  description: siteCopy.description,
  openGraph: { title: siteCopy.title, description: siteCopy.description, siteName: siteCopy.brand, locale: 'ko_KR', type: 'website' },
  twitter: { card: 'summary', title: siteCopy.title, description: siteCopy.description },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="header">
          <Link className="logo" href="/" aria-label={siteCopy.homeLabel}>
            {siteCopy.brand}<span>AGAMAJUNG</span>
          </Link>
          <Suspense fallback={<NavLinks />}>
            <Nav />
          </Suspense>
          <Link className="account-link" href="/me">내 계정</Link>
        </header>
        {children}
        <footer>
          <section id="letter" className="letter" aria-labelledby="letter-title">
            <h2 id="letter-title">가격 소식지</h2>
            <p>{siteCopy.newsletterLead}</p>
          </section>
          <div className="logo">{siteCopy.brand}</div>
          <p>{siteCopy.tagline}</p>
          <p>{siteCopy.transactionNotice}<br />{siteCopy.transactionTerms}</p>
          <small>{siteCopy.priceNotice}</small>
        </footer>
      </body>
    </html>
  );
}
