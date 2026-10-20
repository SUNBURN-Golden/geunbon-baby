import Link from "next/link";
import { formatDate, statusLabel } from "@/lib/labels";
import { displayHandle, instagramUrl, safeHttpUrl } from "@/lib/urls";
import type { GroupBuy } from "@/lib/types";
import { Money } from "@/components/money";

export function GroupBuyCard({ item }: { item: GroupBuy }) {
  const source = safeHttpUrl(item.sourceUrl);
  const instagram = instagramUrl(item.instagramHandle);
  const handle = displayHandle(item.instagramHandle);
  return (
    <article className="listing">
      <div className="trust">
        {item.isSample ? <span className="pill sample">샘플</span> : null}
        {item.isAd ? <span className="pill ad">광고</span> : null}
        <span className="pill">{statusLabel(item.status)}</span>
      </div>
      <h3>{item.title}</h3>
      <p className="meta">
        <Link href={`/models/${item.modelSlug}`}>
          {item.brandNameKo} {item.modelNameKo}
        </Link>
      </p>
      <p>
        <Money amount={item.priceKrw} sample={item.isSample && item.priceKrw != null} />
      </p>
      <p className="meta">
        {item.sellerName}
        {handle ? (
          <>
            {" · "}
            {instagram ? (
              <a href={instagram} target="_blank" rel="noreferrer noopener">
                {handle}
              </a>
            ) : (
              handle
            )}
          </>
        ) : null}
      </p>
      <p className="meta">
        {formatDate(item.startsOn)} – {formatDate(item.endsOn)}
      </p>
      <ul className="trust">
        <li>
          <span className={item.hasMailOrderRegistration ? "pill on" : "pill off"}>
            통신판매업 신고 {item.hasMailOrderRegistration ? "표시" : "미표시"}
          </span>
        </li>
        <li>
          <span className={item.hasCoolingOff ? "pill on" : "pill off"}>
            청약철회 7일 {item.hasCoolingOff ? "표시" : "미표시"}
          </span>
        </li>
        <li>
          <span className={item.isOfficialImport ? "pill on" : "pill off"}>
            정식수입 {item.isOfficialImport ? "표시" : "미표시"}
          </span>
        </li>
      </ul>
      {item.note ? <p className="note">{item.note}</p> : null}
      {source ? (
        <p>
          <a href={source} target="_blank" rel={item.isAd ? "noreferrer noopener sponsored" : "noreferrer noopener"}>
            출처 열기
          </a>
        </p>
      ) : null}
    </article>
  );
}
