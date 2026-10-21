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
export const DEFAULT_QUIET_WINDOWS: QuietWindow[] = [
  DEFAULT_QUIET_WINDOW,
  { ...DEFAULT_QUIET_WINDOW, start: '13:00', end: '14:00' },
];
const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const timeMs = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours * 60 + minutes) * 60_000;
};

export function parseQuietWindow(raw: unknown = DEFAULT_QUIET_WINDOW, override?: string, envKey = 'AGAMAJUNG_QUIET_WINDOW'): QuietWindow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('quiet_window 형식 오류');
  const value = raw as Record<string, unknown>;
  let { start, end } = value;
  if (override !== undefined) {
    const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(override);
    if (!match) throw new Error(`${envKey}: HH:mm-HH:mm 형식이 필요합니다.`);
    [, start, end] = match;
  }
  const validTime = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (!validTime(start) || !validTime(end) || start === end) throw new Error('quiet_window: 서로 다른 HH:mm 시작·종료 시각이 필요합니다.');
  if (value.timezone !== 'Asia/Seoul') throw new Error('quiet_window.timezone: Asia/Seoul만 지원합니다.');
  const jitter = value.jitter_ms;
  if (!Array.isArray(jitter) || jitter.length !== 2 || jitter.some(n => !Number.isSafeInteger(n) || n < 0) || jitter[0] > jitter[1]) throw new Error('quiet_window.jitter_ms 값이 잘못되었습니다.');
  return { start, end, timezone: 'Asia/Seoul', jitter_ms: [jitter[0], jitter[1]] };
}

export function parseQuietWindows(raw: unknown = DEFAULT_QUIET_WINDOWS, override?: string, envKey = 'AGAMAJUNG_QUIET_WINDOWS'): QuietWindow[] {
  if (!Array.isArray(raw)) throw new Error('quiet_windows: 배열이 필요합니다.');
  const windows = raw.map(value => parseQuietWindow(value));
  if (override === undefined) return windows;
  return override.split(',').map((range, index) =>
    parseQuietWindow(windows[index] ?? windows[0] ?? DEFAULT_QUIET_WINDOW, range.trim(), envKey));
}

type Interval = { start: number; end: number; jitter_ms: [number, number] };
const maxJitter = (a: Interval, b: Interval): [number, number] => [
  Math.max(a.jitter_ms[0], b.jitter_ms[0]), Math.max(a.jitter_ms[1], b.jitter_ms[1]),
];

// Merge on a circular KST day, including adjacency across midnight. A merged
// interval uses the largest jitter bounds of its members, sampled only once.
function mergedIntervals(windows: QuietWindow[]): Interval[] {
  const intervals: Interval[] = [];
  for (const window of windows) {
    const start = timeMs(window.start);
    const end = timeMs(window.end);
    if (start < end) intervals.push({ start, end, jitter_ms: window.jitter_ms });
    else {
      intervals.push({ start, end: DAY, jitter_ms: window.jitter_ms });
      if (end > 0) intervals.push({ start: 0, end, jitter_ms: window.jitter_ms });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      last.jitter_ms = maxJitter(last, interval);
    } else merged.push({ ...interval });
  }
  const first = merged[0];
  const last = merged.at(-1);
  if (merged.length > 1 && first.start === 0 && last?.end === DAY) {
    last.end += first.end;
    last.jitter_ms = maxJitter(last, first);
    merged.shift();
  }
  return merged;
}

// Start is inclusive, end exclusive. now is injected: no system clock or I/O.
export function quietWindowsAt(windows: QuietWindow[], now: number): {
  active: boolean; endAt: number | null; nextStartAt: number; jitter_ms: [number, number] | null;
} {
  const dayStart = Math.floor((now + KST) / DAY) * DAY - KST;
  const local = now - dayStart;
  let endAt: number | null = null;
  let nextStartAt = Infinity;
  let jitter: [number, number] | null = null;
  for (const interval of mergedIntervals(windows)) {
    const { start, end } = interval;
    if (start === 0 && end === DAY) {
      return { active: true, endAt: Infinity, nextStartAt: Infinity, jitter_ms: interval.jitter_ms };
    }
    nextStartAt = Math.min(nextStartAt, dayStart + start + (local >= start ? DAY : 0));
    if (local >= start && local < end) {
      endAt = dayStart + end;
      jitter = interval.jitter_ms;
    } else if (local < end - DAY) {
      endAt = dayStart + end - DAY;
      jitter = interval.jitter_ms;
    }
  }
  return { active: endAt !== null, endAt, nextStartAt, jitter_ms: jitter };
}

export function quietWindowAt(window: QuietWindow, now: number) {
  return quietWindowsAt([window], now);
}

export class QuietWindowError extends Error {
  constructor() { super('halt:quiet_window'); }
}
