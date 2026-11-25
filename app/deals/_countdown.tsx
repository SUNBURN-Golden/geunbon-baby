'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { homeCopy } from '../../lib/copy/home.ko';
import { formatDealDate } from '../../lib/deals';
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

let clock: number | null = null;
let timer: number;
const listeners = new Set<() => void>();

function tick() {
  clock = Date.now();
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    tick();
    document.addEventListener('visibilitychange', tick);
    timer = window.setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', tick);
      window.clearInterval(timer);
      clock = null;
    }
  };
}

export function DealCountdown({ endsAt, nowMs }: { endsAt: string; nowMs: number }) {
  const observed = useSyncExternalStore(subscribe, () => clock, () => nowMs);
  const current = Math.max(nowMs, observed ?? nowMs);
  const seconds = Math.max(0, Math.ceil((Date.parse(endsAt) - current) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60].map(pad).join(':');
  return <p className="deal-countdown">
    <span className="deal-timer" data-remaining={seconds}>{homeCopy.duration(pad(Math.floor(seconds / 86400)), time)}</span>
    <time dateTime={endsAt} title={countdownLabel(endsAt, current)}>{homeCopy.closesAt(formatDealDate(endsAt, true)!)}</time>
  </p>;
}

export function RefreshAtDeadline({ nowMs, deadline }: { nowMs: number; deadline: string | null }) {
  return <RefreshAtInstant nowMs={nowMs} instant={deadline ? new Date(Date.parse(deadline) + 1).toISOString() : null} resetCursor />;
}

export function RefreshAtInstant({ nowMs, instant, resetCursor = false }: { nowMs: number; instant: string | null; resetCursor?: boolean }) {
  useEffect(() => {
    if (!instant) return;
    const expiry = Date.parse(instant);
    let refreshed = false;
    let timer: number;
    const refresh = () => {
      window.clearTimeout(timer);
      if (refreshed) return;
      const delay = expiry - Date.now();
      if (delay > 0) { timer = window.setTimeout(refresh, Math.min(delay, 2_147_483_647)); return; }
      refreshed = true;
      const url = new URL(window.location.href);
      if (resetCursor) url.searchParams.delete('cursor');
      window.location.replace(url);
    };
    refresh();
    const resume = () => {
      if (document.visibilityState !== 'visible' || refreshed) return;
      if (resetCursor) refresh();
      else {
        refreshed = true;
        window.location.reload();
      }
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [instant, nowMs, resetCursor]);
  return null;
}
