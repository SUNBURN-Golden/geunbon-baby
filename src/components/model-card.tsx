import Link from "next/link";
import { categoryLabel, channelLabel } from "@/lib/labels";
import type { ModelCard } from "@/lib/types";
import { DealBadge } from "@/components/deal-badge";
import { Money } from "@/components/money";

const tones: Record<string, string> = {
  stokke: "#f3e7d4",
  bugaboo: "#e5eee6",
  babybjorn: "#f6e6de",
  cybex: "#ece7f2",
  nuna: "#e5eef3",
  joie: "#f4eadc",
  egg: "#f7f0dc",
  "d-throne": "#eee8df",
  doona: "#e6f0f1",
  britax: "#f3e6e6",
};

export function ModelCardView({ model }: { model: ModelCard }) {
  return (
    <Link href={`/models/${model.slug}`} className="model-card" style={{ background: tones[model.brandSlug] ?? "#f7f3eb" }}>
      <p className="kicker">
        {model.brandNameKo} · {categoryLabel(model.category)}
      </p>
      <h3>{model.name}</h3>
      <p className="ko">{model.nameKo}</p>
      <div className="price-row">
        <Money amount={model.lowest?.amountKrw ?? null} sample={model.lowest?.isSample} />
        {model.lowest ? <span className="meta">{channelLabel(model.lowest.channel)}</span> : <span className="meta">기록 없음</span>}
      </div>
      <DealBadge deal={model.deal} />
    </Link>
  );
}
