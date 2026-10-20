import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Checklist } from "@/components/checklist";
import { DealBadge } from "@/components/deal-badge";
import { Disclaimer } from "@/components/disclaimer";
import { GroupBuyCard } from "@/components/group-buy-card";
import { PriceChart } from "@/components/price-chart";
import { PriceTable } from "@/components/price-table";
import { categoryLabel, channelLabel, formatKrw } from "@/lib/labels";
import { safeHttpUrl } from "@/lib/urls";
import { getModelDetail } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const detail = await getModelDetail(await getSql(), slug);
  if (!detail) return { title: "모델을 찾을 수 없습니다" };
  const title = `${detail.model.brandName} ${detail.model.nameKo}`;
  return {
    title,
    description: `${title} 공구가·공식가·병행수입가·해외가·중고 시세 비교. 샘플 금액은 실제 판매가가 아닙니다.`,
    alternates: { canonical: `/models/${slug}` },
  };
}

export default async function ModelPage({ params }: { params: Promise<{ slug: string }> }) {
  await live();
  const { slug } = await params;
  const detail = await getModelDetail(await getSql(), slug);
  if (!detail) notFound();
  const { model } = detail;
  const website = safeHttpUrl(model.brandWebsite);
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${model.brandName} ${model.name}`,
    brand: { "@type": "Brand", name: model.brandName },
    category: categoryLabel(model.category),
    description: model.summary,
  }).replace(/</g, "\\u003c");

  return (
    <article className="wrap section model-hero">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <p className="crumbs">
        <Link href="/models">모델</Link> / {model.brandNameKo}
      </p>
      <p className="kicker">
        {model.brandNameKo} · {categoryLabel(model.category)}
      </p>
      <h1>{model.name}</h1>
      <p className="lede">{model.nameKo}</p>
      <p>{model.summary}</p>
      {detail.allPricesSample ? (
        <p className="note">이 페이지의 가격은 모두 샘플(플레이스홀더)입니다. 실제 판매가가 아닙니다.</p>
      ) : null}
      <DealBadge deal={detail.deal} />
      <p className="note">
        {detail.deal
          ? `배지는 공식가 기록의 중앙값과 ${channelLabel(detail.deal.currentChannel)}를 견준 값입니다. 중고·해외가는 이 비교에서 빼 둡니다.`
          : "공식가 기록이 두 건 미만이거나, 최근 공구·공식·병행 가격이 평소 공식가보다 5% 이상 낮지 않아 할인 배지를 붙이지 않습니다."}{" "}
        {detail.deal?.basedOnSample ? `비교 금액 ${formatKrw(detail.deal.currentKrw)}은 샘플입니다.` : ""}
      </p>
      {website ? (
        <p>
          <a href={website} target="_blank" rel="noreferrer noopener">
            {model.brandName} 브랜드 사이트
          </a>
        </p>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>가격 비교</h2>
        </div>
        <PriceTable rows={detail.comparison} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2>가격 기록</h2>
        </div>
        <PriceChart points={detail.history} />
      </section>

      <section className="section">
        <Checklist model={model} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2>이 모델의 공구</h2>
          <Link href="/group-buys">전체 달력</Link>
        </div>
        {detail.groupBuys.length === 0 ? <p className="note">등록된 공구가 없습니다.</p> : null}
        <div className="stack">
          {detail.groupBuys.map((item) => (
            <GroupBuyCard key={item.id} item={item} />
          ))}
        </div>
      </section>
      <Disclaimer />
    </article>
  );
}
