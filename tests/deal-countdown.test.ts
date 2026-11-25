import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { DealCountdown, countdownLabel } from '../app/deals/_countdown';

const endsAt = '2026-10-21T03:00:00.000Z';
const end = Date.parse(endsAt);

test('countdown renders 500 ms before expiry and shows the clamped state two seconds later', () => {
  // Server render 500 ms before the deadline: still D-day with one hour left.
  const initial = renderToStaticMarkup(createElement(DealCountdown, { endsAt, nowMs: end - 500 }));
  expect(initial).toContain('data-remaining="1"');
  expect(initial).toContain('title="D-day · 1시간 남음"');
  // Hydration reads the absolute clock on mount, two seconds after expiry, and
  // must never show a negative remainder.
  const hydrated = renderToStaticMarkup(createElement(DealCountdown, { endsAt, nowMs: end + 2000 }));
  expect(hydrated).toContain('data-remaining="0"');
  expect(hydrated).toContain('title="D-day · 0시간 남음"');
  expect(countdownLabel(endsAt, end + 2000)).toBe('D-day · 0시간 남음');
});

test('countdown keeps the KST day boundary and drops the hour suffix beyond one day', () => {
  // 2026-10-21 03:00Z is 12:00 KST; two KST days earlier is D-2 with no hours.
  expect(countdownLabel(endsAt, end - 2 * 86_400_000)).toBe('D-2');
  // 2026-10-21 09:30 KST vs 2026-10-20 23:59 KST is under 24 hours apart but
  // crosses the KST midnight boundary, so the day counter still increments.
  expect(countdownLabel('2026-10-21T00:30:00.000Z', Date.parse('2026-10-20T14:59:59.000Z'))).toBe('D-1 · 10시간 남음');
});
