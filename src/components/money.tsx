import { formatKrw } from "@/lib/labels";

export function Money({ amount, sample }: { amount: number | null; sample?: boolean }) {
  if (amount == null) return <span className="meta">가격 미정</span>;
  return (
    <span className="money">
      {formatKrw(amount)}
      {sample ? <span className="pill sample">샘플</span> : null}
    </span>
  );
}
