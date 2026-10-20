import { formatKrw } from "@/lib/labels";
import type { Deal } from "@/lib/types";

export function DealBadge({ deal }: { deal: Deal | null }) {
  if (!deal) return null;
  const prefix = deal.basedOnSample ? "샘플 기준 · " : "";
  return (
    <p className="deal">
      <span>
        {prefix}평소보다 {deal.percentOff}% 저렴
      </span>
      <span className="meta">
        공식가 중앙값 {formatKrw(deal.baselineKrw)} · 최근 비교가 {formatKrw(deal.currentKrw)}
      </span>
    </p>
  );
}
