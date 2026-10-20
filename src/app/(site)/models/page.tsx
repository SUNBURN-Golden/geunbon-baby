import Link from "next/link";
import { ModelCardView } from "@/components/model-card";
import { CATEGORIES, isCategory } from "@/lib/labels";
import { listBrands, listModelCards } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export const metadata = { title: "모델" };

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; category?: string }>;
}) {
  await live();
  const params = await searchParams;
  const category = params.category && isCategory(params.category) ? params.category : undefined;
  const brand = params.brand;
  const sql = await getSql();
  const [brands, models] = await Promise.all([
    listBrands(sql),
    listModelCards(sql, { brandSlug: brand, category }),
  ]);

  return (
    <section className="wrap section">
      <p className="kicker">카탈로그</p>
      <h1 className="serif" style={{ fontSize: "clamp(36px, 6vw, 52px)", margin: "0 0 8px" }}>
        모델
      </h1>
      <p className="lede">아이코닉 기어만 올립니다. 카드의 금액은 샘플 배지가 붙어 있으면 실제 시세가 아닙니다.</p>
      <div className="filters" aria-label="카테고리">
        <Link href={brand ? `/models?brand=${brand}` : "/models"} aria-current={category ? undefined : "page"}>
          전체
        </Link>
        {CATEGORIES.map((item) => {
          const href = brand ? `/models?brand=${brand}&category=${item.value}` : `/models?category=${item.value}`;
          return (
            <Link key={item.value} href={href} aria-current={category === item.value ? "page" : undefined}>
              {item.label}
            </Link>
          );
        })}
      </div>
      <div className="filters" aria-label="브랜드">
        {brands.map((item) => (
          <Link
            key={item.id}
            href={category ? `/models?brand=${item.slug}&category=${category}` : `/models?brand=${item.slug}`}
            aria-current={brand === item.slug ? "page" : undefined}
          >
            {item.nameKo}
          </Link>
        ))}
      </div>
      {models.length === 0 ? <p>해당하는 모델이 없습니다.</p> : null}
      <div className="card-grid three">
        {models.map((model) => (
          <ModelCardView key={model.slug} model={model} />
        ))}
      </div>
    </section>
  );
}
