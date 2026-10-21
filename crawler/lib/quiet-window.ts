// Daily wall-clock window in Korea (UTC+9, no daylight saving time).
export type QuietWindow = {
  start: string;
  end: string;
  timezone: 'Asia/Seoul';
  jitter_ms: [number, number];
};
export const DEFAULT_QUIET_WINDOW: QuietWindow = {
  start: '06:45', end: '08:00', timezone: 'Asia/Seoul', jitter_ms: [1000, 30000],
};
const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const timeMs = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours * 60 + minutes) * 60_000;
};

export function parseQuietWindow(raw: unknown = DEFAULT_QUIET_WINDOW, override?: string): QuietWindow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('quiet_window 형식 오류');
  const value = raw as Record<string, unknown>;
  let { start, end } = value;
  if (override !== undefined) {
    const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(override);
    if (!match) throw new Error('AGAMAJUNG_QUIET_WINDOW: HH:mm-HH:mm 형식이 필요합니다.');
    [, start, end] = match;
  }
  const validTime = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (!validTime(start) || !validTime(end) || start === end) throw new Error('quiet_window: 서로 다른 HH:mm 시작·종료 시각이 필요합니다.');
  if (value.timezone !== 'Asia/Seoul') throw new Error('quiet_window.timezone: Asia/Seoul만 지원합니다.');
  const jitter = value.jitter_ms;
  if (!Array.isArray(jitter) || jitter.length !== 2 || jitter.some(n => !Number.isSafeInteger(n) || n < 0) || jitter[0] > jitter[1]) throw new Error('quiet_window.jitter_ms 값이 잘못되었습니다.');
  return { start, end, timezone: 'Asia/Seoul', jitter_ms: [jitter[0], jitter[1]] };
}

// Start is inclusive, end exclusive. now is injected: no system clock or I/O.
export function quietWindowAt(window: QuietWindow, now: number): { active: boolean; endAt: number | null; nextStartAt: number } {
  const dayStart = Math.floor((now + KST) / DAY) * DAY - KST;
  const local = now - dayStart;
  const start = timeMs(window.start);
  const end = timeMs(window.end);
  const overnight = start > end;
  const active = overnight ? local >= start || local < end : local >= start && local < end;
  return {
    active,
    endAt: active ? dayStart + end + (overnight && local >= start ? DAY : 0) : null,
    nextStartAt: dayStart + start + (local >= start ? DAY : 0),
  };
}

export class QuietWindowError extends Error {
  constructor() { super('halt:quiet_window'); }
}
