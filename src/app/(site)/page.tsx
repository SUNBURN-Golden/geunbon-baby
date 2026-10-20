import Link from "next/link";
import { GroupBuyCard } from "@/components/group-buy-card";
import { ModelCardView } from "@/components/model-card";
import { NewsletterForm } from "@/components/newsletter-form";
import { formatDate, statusLabel } from "@/lib/labels";
import { safeHttpUrl } from "@/lib/urls";
import { getHome } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await live();
  const home = await getHome(await getSql());

  return (
    <>
      <section className="wrap hero">
        <p className="kicker">STOKKE · BUGABOO · BABYBJÖRN · CYBEX · NUNA</p>
        <h1>
          <span>오래 쓰는 기어의</span>
          <span>가격과 공구.</span>
        </h1>
        <p className="lede">
          기저귀와 분유는 다루지 않습니다. 트립트랩, 폭스, 블리스처럼 이름이 남은 모델만 모아, 공구가·공식가·병행수입가·해외가·중고
          시세를 한 표에 둡니다.
        </p>
        <div className="hero-actions">
          <Link className="button" href="/models/stokke-tripp-trapp">
            트립트랩 시세
          </Link>
          <Link className="button ghost" href="/group-buys">
            공구 달력
          </Link>
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>주목하는 모델</h2>
          <Link href="/models">전체 모델</Link>
        </div>
        <div className="card-grid three">
          {home.featured.map((model) => (
            <ModelCardView key={model.slug} model={model} />
          ))}
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>진행·예정 공구</h2>
          <Link href="/group-buys">달력 보기</Link>
        </div>
        <div className="card-grid two">
          {home.groupBuys.map((item) => (
            <GroupBuyCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>브랜드 일정</h2>
        </div>
        <div className="stack">
          {home.events.map((event) => {
            const href = safeHttpUrl(event.sourceUrl);
            return (
              <article key={event.id} className="event-card">
                <div className="trust">
                  {event.isSample ? <span className="pill sample">샘플</span> : null}
                  <span className="pill">{statusLabel(event.status)}</span>
                </div>
                <h3>{event.title}</h3>
                <p className="meta">
                  {event.brandNameKo} · {formatDate(event.startsOn)} – {formatDate(event.endsOn)}
                </p>
                <p>{event.summary}</p>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer noopener">
                    일정 링크
                  </a>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="wrap band">
        <h2>시세 편지를 저장합니다</h2>
        <p>이메일은 이 데이터베이스에만 남습니다. 특정 메일 서비스에 묶여 있지 않고, 원하면 웹훅으로만 넘길 수 있습니다.</p>
        <NewsletterForm source="home" />
      </section>
    </>
  );
}
