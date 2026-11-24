'use client';

import { useEffect, useState } from 'react';
import { verifiedDealsCopy } from '../../lib/copy/deals.ko';

const hour = 3_600_000;
const day = 24 * hour;

// Pure so the server markup and the hydrated clock are computed identically.
export function countdownLabel(endsAt: string, clockMs: number) {
  const end = Date.parse(endsAt);
  const days = Math.max(0, Math.floor((end + 9 * hour) / day) - Math.floor((clockMs + 9 * hour) / day));
  const hours = Math.max(0, Math.ceil((end - clockMs) / hour));
  return `${days > 0 ? `D-${days}` : 'D-day'}${end - clockMs < day ? ` · ${verifiedDealsCopy.hours.replace('{n}', String(hours))}` : ''}`;
}

export function DealCountdown({ endsAt, nowMs }: { endsAt: string; nowMs: number }) {
  const [clock, setClock] = useState(nowMs);
  useEffect(() => {
    // The absolute deadline replaces the server-rendered clock immediately on
    // hydration and on tab resume; the interval keeps the label current after.
    const update = () => setClock(Date.now());
    update();
    document.addEventListener('visibilitychange', update);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [nowMs]);
  return <time dateTime={endsAt}>{countdownLabel(endsAt, clock)}</time>;
}

export function RefreshAtDeadline({ nowMs, deadline }: { nowMs: number; deadline: string | null }) {
  useEffect(() => {
    if (!deadline) return;
    const expiry = Date.parse(deadline) + 1;
    let refreshed = false;
    let timer: number;
    const refresh = () => {
      window.clearTimeout(timer);
      if (refreshed) return;
      const delay = expiry - Date.now();
      if (delay > 0) { timer = window.setTimeout(refresh, Math.min(delay, 2_147_483_647)); return; }
      refreshed = true;
      const url = new URL(window.location.href);
      url.searchParams.delete('cursor');
      window.location.replace(url);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [deadline, nowMs]);
  return null;
}
