import Link from 'next/link';
import { siteCopy } from '../lib/site-copy';
import { dealsCopy } from '../lib/deals-copy';
import { all, environment } from '../lib/db';
import { DEAL_SELECT, type DealWithContext } from '../lib/deals';
import { ActiveDeals } from './_active-deals';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // eslint-disable-next-line react-hooks/purity -- Capture request time once for consistent deal states.
  const nowMs = Date.now();
  const deals = await all<DealWithContext>(environment().DB, DEAL_SELECT);
  return <main><ActiveDeals deals={deals} nowMs={nowMs} /><section className="hero"><div><p className="eyebrow">A THOUGHTFUL BEGINNING</p><h1>너는 건강하게만 와 주렴. 좋은 것은 <em>우리가 골라 둘게.</em></h1><p className="lead">{siteCopy.heroLead}</p><Link className="button" href="/deals">{dealsCopy.homeLink} <span>↗</span></Link></div><div className="hero-art" aria-hidden="true"><div className="sun"/><div className="arch"><div className="chair"><i/><b/><span/></div></div><p>작은 시작, 오래 곁에 둘 것들.</p><span className="art-label">THE FIRST COLLECTION / 01</span></div></section><section className="manifesto"><span className="eyebrow">OUR PROMISE</span><h2>많이 고르기보다, 제대로 고르는 일.</h2><div><p>유모차부터 첫 의자까지. 브랜드의 이름보다<br/>아이와 함께할 시간을 먼저 생각합니다.</p><p>{siteCopy.pricePromise}</p></div></section><section className="entry-grid"><Link href="/models?category=stroller"><span>01 / OUT & ABOUT</span><h3>함께 걷는 첫 길</h3><p>유모차 살펴보기 →</p></Link><Link href="/models?category=high_chair"><span>02 / AT THE TABLE</span><h3>식탁의 작은 자리</h3><p>하이체어 살펴보기 →</p></Link><Link href="/models?category=car_seat"><span>03 / SAFE JOURNEY</span><h3>안심을 싣는 시간</h3><p>카시트 살펴보기 →</p></Link></section></main>;
}
