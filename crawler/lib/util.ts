// 크롤러 공용 소도구. 최소·최대 범위의 무작위 대기(사람 흉내 지터)와 KST 기준 시각 키.
export const jitter = (min: number, max = min) => min + Math.random() * (max - min);
export const sleep = (minMs: number, maxMs = minMs) => new Promise<void>(resolve => setTimeout(resolve, jitter(minMs, maxMs)));
export const range = ([min, max]: number[]) => [min, max] as const;
// KST는 UTC+9 고정(서머타임 없음). 시간대 키 계산에만 쓴다.
export const kstNow = (date = new Date()) => new Date(date.getTime() + 9 * 3_600_000);
export const kstDayKey = (date = new Date()) => kstNow(date).toISOString().slice(0, 10);
export const kstHourKey = (date = new Date()) => kstNow(date).toISOString().slice(0, 13);

export function canonicalPost(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.instagram.com/');
    if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password) return null;
    if (!/^\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    return `https://www.instagram.com${url.pathname.replace(/\/$/, '')}/`;
  } catch { return null; }
}
