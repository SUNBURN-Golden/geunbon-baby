import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { siteCopy } from '../lib/site-copy';
import Nav, { NavLinks } from './nav';
import './fonts.css';
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
      <head>
        <link rel="preload" href="/fonts/excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/gaegu/gaegu-regular-logo.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
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
            <p>{siteCopy.newsletterHow}</p>
            <Link className="button" href="/login">{siteCopy.newsletterCta}</Link>
          </section>
          <nav aria-label="사이트 안내" className="footer-nav">
            <Link href="/calendar">{siteCopy.calendarFooter}</Link>
            <Link href="/sellers">{siteCopy.sellersFooter}</Link>
          </nav>
          <div className="logo">{siteCopy.brand}</div>
          <p className="brand-slogan">{siteCopy.tagline}</p>
          <p>{siteCopy.transactionNotice}<br />{siteCopy.transactionTerms}</p>
          <small>{siteCopy.priceNotice}</small>
        </footer>
      </body>
    </html>
  );
}
