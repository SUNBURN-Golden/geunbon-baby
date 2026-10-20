import { channelLabel, type Channel } from "@/lib/labels";
import type { HistoryPoint } from "@/lib/types";

const colors: Record<Channel, string> = {
  official: "#1c3a32",
  group_buy: "#8e3140",
  parallel_import: "#8c6840",
  overseas: "#3d5a73",
  used: "#8a8175",
};

export function PriceChart({ points }: { points: HistoryPoint[] }) {
  if (points.length === 0) return <p className="note">아직 가격 기록이 없습니다.</p>;

  const width = 720;
  const height = 260;
  const pad = { l: 52, r: 16, t: 18, b: 32 };
  const times = points.map((point) => Date.parse(`${point.checkedOn}T00:00:00Z`));
  const amounts = points.map((point) => point.amountKrw);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minAmount = Math.min(...amounts);
  const maxAmount = Math.max(...amounts);
  const span = Math.max(maxAmount - minAmount, 1);
  const y0 = Math.max(0, minAmount - span * 0.2);
  const y1 = maxAmount + span * 0.16;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const xFor = (date: string) => {
    const time = Date.parse(`${date}T00:00:00Z`);
    if (maxTime === minTime) return pad.l + innerW / 2;
    return pad.l + ((time - minTime) / (maxTime - minTime)) * innerW;
  };
  const yFor = (amount: number) => pad.t + (1 - (amount - y0) / (y1 - y0)) * innerH;
  const channels = [...new Set(points.map((point) => point.channel))];
  const ticks = [y1, (y0 + y1) / 2, y0];
  const dates = [...new Set(points.map((point) => point.checkedOn))].sort();
  const labels = dates.length <= 3 ? dates : [dates[0], dates[Math.floor((dates.length - 1) / 2)], dates[dates.length - 1]];
  const sample = points.some((point) => point.isSample);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={sample ? "샘플 가격 기록 그래프" : "가격 기록 그래프"}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={yFor(tick)} y2={yFor(tick)} stroke="#e0d6c6" />
            <text x={pad.l - 8} y={yFor(tick) + 4} textAnchor="end" fontSize="11" fill="#6e665c">
              {`${Math.round(tick / 10000)}만`}
            </text>
          </g>
        ))}
        {channels.map((channel) => {
          const series = points
            .filter((point) => point.channel === channel)
            .sort((a, b) => a.checkedOn.localeCompare(b.checkedOn));
          const path = series
            .map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(point.checkedOn).toFixed(1)} ${yFor(point.amountKrw).toFixed(1)}`)
            .join(" ");
          return (
            <g key={channel}>
              <path d={path} fill="none" stroke={colors[channel]} strokeWidth="2.2" />
              {series.map((point, index) => (
                <circle
                  key={`${channel}-${point.checkedOn}-${index}`}
                  cx={xFor(point.checkedOn)}
                  cy={yFor(point.amountKrw)}
                  r="3.5"
                  fill={colors[channel]}
                />
              ))}
            </g>
          );
        })}
        {labels.map((date) => (
          <text key={date} x={xFor(date)} y={height - 10} textAnchor="middle" fontSize="11" fill="#6e665c">
            {date.slice(5).replace("-", ".")}
          </text>
        ))}
      </svg>
      <ul className="legend">
        {channels.map((channel) => (
          <li key={channel}>
            <span style={{ background: colors[channel] }} />
            {channelLabel(channel)}
          </li>
        ))}
      </ul>
      <figcaption>
        {sample ? "이 그래프의 점에는 샘플 금액이 포함되어 있습니다. 실제 시세가 아닙니다." : "기록된 가격만 이은 그래프입니다."}
      </figcaption>
    </figure>
  );
}
