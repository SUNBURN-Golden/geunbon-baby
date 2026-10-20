import type { Channel } from "@/lib/labels";
import type { Deal, HistoryPoint } from "@/lib/types";

const COMPARABLE: Channel[] = ["group_buy", "official", "parallel_import"];

export function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return sorted[mid];
}

export function latestByChannel<T extends { channel: Channel; checkedOn: string }>(points: T[]) {
  const sorted = [...points].sort((a, b) => a.checkedOn.localeCompare(b.checkedOn));
  const map = new Map<Channel, T>();
  for (const point of sorted) map.set(point.channel, point);
  return map;
}

export function compareDeal(points: HistoryPoint[]): Deal | null {
  const official = points.filter((point) => point.channel === "official");
  if (official.length < 2) return null;
  const baseline = median(official.map((point) => point.amountKrw));
  if (!baseline || baseline <= 0) return null;

  const latest = latestByChannel(points);
  const candidates = COMPARABLE.map((channel) => latest.get(channel)).filter((point): point is HistoryPoint =>
    Boolean(point),
  );
  if (candidates.length === 0) return null;
  const current = candidates.reduce((lowest, point) => (point.amountKrw < lowest.amountKrw ? point : lowest));
  const percentOff = Math.round(((baseline - current.amountKrw) / baseline) * 100);
  if (percentOff < 5) return null;

  return {
    baselineKrw: baseline,
    currentKrw: current.amountKrw,
    currentChannel: current.channel,
    percentOff,
    basedOnSample: official.some((point) => point.isSample) || current.isSample,
  };
}

export function lowestComparable(points: HistoryPoint[]) {
  const latest = latestByChannel(points);
  const candidates = COMPARABLE.map((channel) => latest.get(channel)).filter((point): point is HistoryPoint =>
    Boolean(point),
  );
  if (candidates.length === 0) return null;
  const current = candidates.reduce((lowest, point) => (point.amountKrw < lowest.amountKrw ? point : lowest));
  return {
    channel: current.channel,
    amountKrw: current.amountKrw,
    isSample: current.isSample,
  };
}
