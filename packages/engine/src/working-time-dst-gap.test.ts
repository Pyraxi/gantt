// A work interval that starts inside a skipped DST hour constructs with its end
// before its start (Chile springs forward at midnight: 2026-09-06 00:00 → 01:00).
// It holds no time: the day walk must not add negative minutes, and must agree
// with the memoised counter. Separate file: TZ is process-wide (relies on
// vitest's per-file process isolation).
process.env.TZ = 'America/Santiago';

import { expect, test } from 'vitest';
import type { Calendar } from './types';
import {
  addWorkingMinutes,
  createWorkingMinutesCounter,
  workingMinutesBetween,
} from './working-time';

const cal: Calendar = {
  id: 'c',
  name: 'Early shift in the gap',
  workWeek: Array.from({ length: 7 }, () => [
    { startMinutes: 22, endMinutes: 73 },
    { startMinutes: 480, endMinutes: 600 },
  ]),
  exceptions: [],
};

test('the zone really skips midnight on 6 Sep 2026 (guards the premise)', () => {
  expect(new Date(2026, 8, 6, 0, 22).getHours()).toBe(1);
});

test('no negative time across the gap; walk = counter', () => {
  const a = new Date(2026, 8, 5, 12);
  const b = new Date(2026, 8, 7, 12);
  const walk = workingMinutesBetween(a, b, cal);
  expect(walk).toBe(createWorkingMinutesCounter(cal)(a, b));
  // 5 Sep: none after noon. 6 Sep: the gap interval [01:22 → 01:13] holds
  // nothing, 08:00–10:00 = 120. 7 Sep: 00:22–01:13 = 51, 08:00–10:00 = 120.
  expect(walk).toBe(120 + 51 + 120);
  expect(workingMinutesBetween(b, a, cal)).toBe(-walk);
});

test('adding time steps over the empty interval', () => {
  const end = addWorkingMinutes(new Date(2026, 8, 5, 12), 60, cal);
  expect(end).toEqual(new Date(2026, 8, 6, 9));
});
