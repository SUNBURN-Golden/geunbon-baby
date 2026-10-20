export const CATEGORIES = [
  { value: "stroller", label: "유모차" },
  { value: "compact_stroller", label: "휴대용 유모차" },
  { value: "high_chair", label: "하이체어" },
  { value: "bouncer", label: "바운서" },
  { value: "car_seat", label: "카시트" },
  { value: "travel_system", label: "트래블 시스템" },
] as const;

export type Category = (typeof CATEGORIES)[number]["value"];

export const CHANNELS = [
  { value: "group_buy", label: "공구가" },
  { value: "official", label: "공식가" },
  { value: "parallel_import", label: "병행수입가" },
  { value: "overseas", label: "해외가" },
  { value: "used", label: "중고 시세" },
] as const;

export type Channel = (typeof CHANNELS)[number]["value"];

export const STATUSES = [
  { value: "ongoing", label: "진행 중" },
  { value: "upcoming", label: "예정" },
  { value: "ended", label: "종료" },
] as const;

export type WindowStatus = (typeof STATUSES)[number]["value"];

export function categoryLabel(category: string) {
  return CATEGORIES.find((item) => item.value === category)?.label ?? category;
}

export function channelLabel(channel: string) {
  return CHANNELS.find((item) => item.value === channel)?.label ?? channel;
}

export function statusLabel(status: string) {
  return STATUSES.find((item) => item.value === status)?.label ?? status;
}

export function formatKrw(amount: number) {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

export function formatDate(iso: string) {
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day) return iso;
  return `${year}.${month}.${day}`;
}

export function isCategory(value: string): value is Category {
  return CATEGORIES.some((item) => item.value === value);
}

export function isChannel(value: string): value is Channel {
  return CHANNELS.some((item) => item.value === value);
}

export function isStatus(value: string): value is WindowStatus {
  return STATUSES.some((item) => item.value === value);
}
