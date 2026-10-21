// 크롤러 공용 소도구. 최소·최대 범위의 무작위 대기(사람 흉내 지터)와 KST 기준 시각 키.
export const sleep = (minMs: number, maxMs = minMs) => new Promise<void>(resolve => setTimeout(resolve, minMs + Math.random() * Math.max(0, maxMs - minMs)));
export const range = ([min, max]: number[]) => [min, max] as const;
// KST는 UTC+9 고정(서머타임 없음). 시간대 키 계산에만 쓴다.
export const kstNow = (date = new Date()) => new Date(date.getTime() + 9 * 3_600_000);
export const kstDayKey = (date = new Date()) => kstNow(date).toISOString().slice(0, 10);
export const kstHourKey = (date = new Date()) => kstNow(date).toISOString().slice(0, 13);
