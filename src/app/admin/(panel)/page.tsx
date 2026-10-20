import Link from "next/link";
import { getSampleState, listBrands, listEvents, listGroupBuys, listModels, listPrices } from "@/server/catalog";
import { listSubmissions, listSubscribers } from "@/server/inbox";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await live();
  const sql = await getSql();
  const [brands, models, prices, listings, events, submissions, subscribers, sample] = await Promise.all([
    listBrands(sql),
    listModels(sql),
    listPrices(sql),
    listGroupBuys(sql),
    listEvents(sql),
    listSubmissions(sql),
    listSubscribers(sql),
    getSampleState(sql),
  ]);
  const pending = submissions.filter((item) => item.status === "pending").length;
  const cards = [
    ["브랜드", brands.length, "/admin/brands"],
    ["모델", models.length, "/admin/models"],
    ["가격", prices.length, "/admin/prices"],
    ["공구", listings.length, "/admin/group-buys"],
    ["행사", events.length, "/admin/events"],
    ["제보 대기", pending, "/admin/submissions"],
    ["구독", subscribers.length, "/admin/newsletter"],
  ] as const;
  return (
    <section>
      <h1 className="serif">관리</h1>
      <p className="note">
        {sample.allStoredPricesAreSample
          ? "저장된 가격과 공구는 아직 모두 샘플입니다."
          : `실제 가격 ${sample.realPriceCount}건, 실제 공구 ${sample.realGroupBuyCount}건이 있습니다.`}
      </p>
      <div className="card-grid two">
        {cards.map(([label, count, href]) => (
          <Link key={href} href={href} className="panel">
            <p className="meta">{label}</p>
            <p className="price">{count}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
