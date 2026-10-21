import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import Nav, { NavLinks } from './nav';
import './globals.css';

export const metadata: Metadata = { title: { default: '아가마중 — 좋은 것은 우리가 골라 둘게', template: '%s | 아가마중' }, description: '오래 곁에 둘 프리미엄 육아용품. 출처가 있는 가격 비교와 신중하게 확인한 공구 소식.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="header">
          <Link className="logo" href="/" aria-label="아가마중 첫화면">
            아가마중<span>AGAMAJUNG</span>
          </Link>
          <Suspense fallback={<NavLinks />}>
            <Nav />
          </Suspense>
        </header>
        {children}
        <footer>
          <section id="letter" className="letter" aria-labelledby="letter-title">
            <h2 id="letter-title">가격 소식지</h2>
            <p>주 1회, 검증된 혜택과 시세만 전해요. 곧 만나요.</p>
          </section>
          <div className="logo">아가마중</div>
          <p>너는 건강하게만 와 주렴. 좋은 것은 우리가 골라 둘게.</p>
          <p>아가마중은 통신판매중개 정보 제공 서비스이며, 거래 당사자가 아닙니다.<br />모든 공구는 광고로 표시합니다. 결제·배송·교환·환불은 연결된 판매처에서 확인해 주세요.</p>
          <small>가격은 출처 확인일 기준이며 현재 판매가와 다를 수 있습니다. 기저귀·분유는 다루지 않습니다.</small>
        </footer>
      </body>
    </html>
  );
}
