import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
export const metadata: Metadata = { title: { default: '아가마중 — 좋은 것은 우리가 골라 둘게', template: '%s | 아가마중' }, description: '오래 곁에 둘 프리미엄 육아용품. 출처가 있는 가격 비교와 신중하게 확인한 공구 소식.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body><header className="header"><Link className="logo" href="/">아가마중<span>AGAMAJUNG</span></Link><nav aria-label="주 메뉴"><Link href="/models">근본템 둘러보기</Link><Link href="/deals">공구 소식</Link><Link href="/calendar">공구 달력</Link><Link href="/sellers">판매자 안내</Link></nav></header>{children}<footer><div className="logo">아가마중</div><p>너는 건강하게만 와 주렴. 좋은 것은 우리가 골라 둘게.</p><p>아가마중은 통신판매중개 정보 제공 서비스이며, 거래 당사자가 아닙니다.<br/>모든 공구는 광고로 표시합니다. 결제·배송·교환·환불은 연결된 판매처에서 확인해 주세요.</p><small>가격은 출처 확인일 기준이며 현재 판매가와 다를 수 있습니다. 기저귀·분유는 다루지 않습니다.</small></footer></body></html>;
}
