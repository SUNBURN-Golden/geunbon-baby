import type { Provider } from './types';

const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
export function isLimited(output: string): boolean {
  return /you['’]ve hit your\b|(?:^|[^a-z0-9])(?:usage[- _]?limit|rate[- _]?limit|quota|429|limits?|limited|resets?)(?=$|[^a-z0-9])/i.test(clean(output));
}

// A timestamp without a zone belongs to the CLI provider, never the box's TZ.
export function parseReset(output: string, provider: Provider, now = Date.now()): number | undefined {
  const s = clean(output);
  const offset = /(?:Asia\/Seoul|KST)/i.test(s) ? 9 : /(?:UTC\+8|GMT\+8|Asia\/Shanghai|CST)/i.test(s) ? 8 :
    provider === 'glm' ? 8 : provider === 'claude' ? 9 : 0;
  const candidates: number[] = [];
  const add = (n: number) => { if (Number.isFinite(n) && n > now) candidates.push(n); };
  // Scope parsing to reset/retry messages so unrelated dates in a transcript don't schedule a pause.
  for (const line of s.split('\n').filter(line => /reset|retry|available|try again/i.test(line))) {
    const iso = line.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gi);
    for (const date of iso ?? []) {
      add(Date.parse(date.replace(' ', 'T') + (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(date) ? '' : `${offset >= 0 ? '+' : '-'}${String(Math.abs(offset)).padStart(2, '0')}:00`)));
    }
    const epoch = line.match(/(?:reset(?:s|_at)?|retry[_ -]?at)\s*(?:at\s*)?[:=]?\s*(\d{10}|\d{13})\b/i);
    if (epoch) add(Number(epoch[1]) * (epoch[1].length === 10 ? 1000 : 1));
    const retryAfter = line.match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\b/i);
    if (retryAfter && !/\b(?:hours?|minutes?|hrs?|mins?)\b/i.test(line)) add(now + Number(retryAfter[1]) * 1000);
    if (/(?:in|after)\s+\d/i.test(line)) {
      let duration = 0;
      for (const match of line.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
        duration += Number(match[1]) * (/^h/i.test(match[2]) ? 3600000 : /^m/i.test(match[2]) ? 60000 : 1000);
      }
      if (duration) add(now + duration);
    }
    if (iso?.length) continue;
    const clock = line.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})(?::\d{2})?\b/i);
    if (!clock) continue;
    let hour = Number(clock[1] ?? clock[4]);
    const minute = Number(clock[2] ?? clock[5] ?? 0);
    if (clock[3]) hour = hour % 12 + (/pm/i.test(clock[3]) ? 12 : 0);
    if (hour > 23 || minute > 59) continue;
    const local = new Date(now + offset * 3600000);
    let year = local.getUTCFullYear(), month = local.getUTCMonth(), day = local.getUTCDate();
    let dated = false;
    const numeric = line.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const named = line.match(/\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
    if (numeric) { year = +numeric[1]; month = +numeric[2] - 1; day = +numeric[3]; dated = true; }
    if (named) { month = months.indexOf(named[1].slice(0, 3).toLowerCase()); day = +named[2]; year = Number(named[3] ?? year); dated = true; }
    let reset = Date.UTC(year, month, day, hour - offset, minute);
    if (/tomorrow/i.test(line)) reset += 86400000;
    else if (!dated && reset <= now) reset += 86400000;
    add(reset);
  }
  return candidates.length ? Math.min(...candidates) : undefined;
}
