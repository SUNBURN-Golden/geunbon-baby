import { channelLabel, formatDate } from "@/lib/labels";
import { safeHttpUrl } from "@/lib/urls";
import type { ComparisonRow } from "@/lib/types";
import { Money } from "@/components/money";

export function PriceTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <div className="table-scroll">
      <table className="compare">
        <caption className="note" style={{ captionSide: "bottom", textAlign: "left", padding: "10px 14px" }}>
          공구가, 공식가, 병행수입가, 해외가(원화), 중고 시세. 해외가는 샘플 환율로 환산한 자리일 수 있습니다.
        </caption>
        <thead>
          <tr>
            <th>구분</th>
            <th>가격</th>
            <th>출처</th>
            <th>확인일</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = safeHttpUrl(row.quote?.sourceUrl);
            return (
              <tr key={row.channel}>
                <td>{channelLabel(row.channel)}</td>
                <td>{row.quote ? <Money amount={row.quote.amountKrw} sample={row.quote.isSample} /> : <span className="meta">기록 없음</span>}</td>
                <td>
                  {row.quote && href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener">
                      {row.quote.sourceName}
                    </a>
                  ) : (
                    <span className="meta">{row.quote?.sourceName ?? "—"}</span>
                  )}
                  {row.quote?.note ? <p className="note">{row.quote.note}</p> : null}
                </td>
                <td>{row.quote ? formatDate(row.quote.checkedOn) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
