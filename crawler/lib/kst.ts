/** Linux-only calendar policy. All callers supply a captured clock. */
export const KST_OFFSET = 9 * 60 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;
const millis = (at: string | number | Date) => typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : at.getTime();
export const kstDate = (at: string | number | Date) => new Date(millis(at) + KST_OFFSET).toISOString().slice(0, 10);
export const kstDay = (at: string | number | Date) => Math.floor((millis(at) + KST_OFFSET) / DAY);
export function kstWeek(now: number) {
  const day = kstDay(now), weekday = new Date(day * DAY).getUTCDay();
  const monday = day - (weekday + 6) % 7;
  return { start: monday * DAY - KST_OFFSET, end: (monday + 7) * DAY - KST_OFFSET };
}
