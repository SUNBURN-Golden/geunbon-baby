import Link from "next/link";
import { GroupBuyCard } from "@/components/group-buy-card";
import { Disclaimer } from "@/components/disclaimer";
import { currentMonth, daysInMonth, monthLabel, shiftMonth, weekdayOfFirst } from "@/lib/dates";
import { isStatus, STATUSES } from "@/lib/labels";
import { listGroupBuys } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export const metadata = { title: "공구" };

function hrefFor(input: { status?: string; month?: string; on?: string }) {
  const search = new URLSearchParams();
  if (input.status) search.set("status", input.status);
  if (input.month) search.set("month", input.month);
  if (input.on) search.set("on", input.on);
  const query = search.toString();
  return query ? `/group-buys?${query}` : "/group-buys";
}

export default async function GroupBuysPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; month?: string; on?: string }>;
}) {
  await live();
  const params = await searchParams;
  const status = params.status && isStatus(params.status) ? params.status : undefined;
  const month = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : currentMonth();
  const on = params.on && /^\d{4}-\d{2}-\d{2}$/.test(params.on) ? params.on : undefined;
  const listings = await listGroupBuys(await getSql(), { status, month, on });
  const monthListings = await listGroupBuys(await getSql(), { status, month });
  const marked = new Set<string>();
  for (const item of monthListings) {
    const [year, monthNumber] = month.split("-").map(Number);
    const last = daysInMonth(month);
    for (let day = 1; day <= last; day += 1) {
      const iso = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (item.startsOn <= iso && item.endsOn >= iso) marked.add(iso);
    }
  }
  const offset = weekdayOfFirst(month);
  const cells: Array<number | null> = [...Array.from({ length: offset }, () => null)];
  for (let day = 1; day <= daysInMonth(month); day += 1) cells.push(day);

  return (
    <section className="wrap section">
      <p className="kicker">인스타 공구</p>
      <h1 className="serif" style={{ fontSize: "clamp(36px, 6vw, 52px)", margin: "0 0 8px" }}>
        공구 달력
      </h1>
      <p className="lede">
        호스트가 남긴 신뢰 표시와 유료 게재 라벨을 같이 봅니다. 광고는 제목 앞에 붙입니다. 결제는 여기서 하지 않습니다.
      </p>
      <div className="filters" aria-label="상태">
        <Link href={hrefFor({ month })} aria-current={status ? undefined : "page"}>
          전체
        </Link>
        {STATUSES.map((item) => (
          <Link
            key={item.value}
            href={hrefFor({ status: item.value, month })}
            aria-current={status === item.value ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="section-head">
        <h2>{monthLabel(month)}</h2>
        <span>
          <Link href={hrefFor({ status, month: shiftMonth(month, -1) })}>이전달</Link>
          {" · "}
          <Link href={hrefFor({ status, month: shiftMonth(month, 1) })}>다음달</Link>
        </span>
      </div>
      <div className="calendar" aria-label={`${monthLabel(month)} 달력`}>
        {["일", "월", "화", "수", "목", "금", "토"].map((label) => (
          <span key={label} className="dow">
            {label}
          </span>
        ))}
        {cells.map((day, index) => {
          if (!day) return <span key={`empty-${index}`} />;
          const iso = `${month}-${String(day).padStart(2, "0")}`;
          return (
            <Link
              key={iso}
              href={hrefFor({ status, month, on: iso })}
              className={marked.has(iso) ? "has" : undefined}
              aria-current={on === iso ? "date" : undefined}
            >
              {day}
            </Link>
          );
        })}
      </div>
      {on ? (
        <p className="note">
          {on}에 걸친 일정만 봅니다. <Link href={hrefFor({ status, month })}>날짜 해제</Link>
        </p>
      ) : null}
      {listings.length === 0 ? <p>이 조건의 공구가 없습니다.</p> : null}
      <div className="stack">
        {listings.map((item) => (
          <GroupBuyCard key={item.id} item={item} />
        ))}
      </div>
      <div className="section">
        <Disclaimer />
      </div>
    </section>
  );
}
