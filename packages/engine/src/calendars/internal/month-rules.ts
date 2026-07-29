/**
 * Date-arithmetic helpers for the named-Monday / named-Friday rules in the
 * Holidays Act 2003 (NZ) regional anniversaries.
 *
 * All inputs/outputs are local-time `Date`s. No timezone normalisation —
 * the schedule engine treats holiday-exception dates as calendar-day
 * markers, not instants.
 */

import { addDays, dayOfWeek } from './date-utils.js';

/**
 * The N-th Monday of the given month. `month` is zero-indexed (Jan = 0).
 * `n` is 1-indexed (1 = first Monday).
 */
export function nthMondayOfMonth(year: number, month: number, n: number): Date {
  const firstOfMonth = new Date(year, month, 1);
  const firstDow = dayOfWeek(firstOfMonth);
  // Days to add to reach the first Monday of the month.
  // (8 - dow) % 7: Sun(0)→1, Mon(1)→0, Tue(2)→6, Wed(3)→5, Thu(4)→4, Fri(5)→3, Sat(6)→2
  const offsetToFirstMonday = (8 - firstDow) % 7;
  return new Date(year, month, 1 + offsetToFirstMonday + (n - 1) * 7);
}

/**
 * The first Monday strictly after the given date.
 */
export function firstMondayAfter(date: Date): Date {
  const dow = dayOfWeek(date);
  // Days from `date` to the next Monday strictly after it.
  // Sun(0): +1, Mon(1): +7, Tue(2): +6, Wed(3): +5, Thu(4): +4, Fri(5): +3, Sat(6): +2
  const delta = dow === 0 ? 1 : (8 - dow) % 7 || 7;
  return addDays(date, delta);
}

/**
 * The Friday immediately before the given date. Used for Hawke's Bay
 * (Friday before Labour Day).
 */
export function fridayBefore(date: Date): Date {
  const dow = dayOfWeek(date);
  // Days BACK from `date` to the most recent Friday strictly before it.
  // Sun(0): -2, Mon(1): -3, Tue(2): -4, Wed(3): -5, Thu(4): -6, Fri(5): -7, Sat(6): -1
  const delta = -((dow + 2) % 7 || 7);
  return addDays(date, delta);
}

/**
 * The Monday nearest the given calendar date. No tie-break logic needed:
 * no day-of-week produces equidistant prev/next Monday — the function is
 * well-defined for all 7 inputs.
 *
 * `month` is zero-indexed.
 */
export function nearestMondayTo(year: number, month: number, day: number): Date {
  const target = new Date(year, month, day);
  const dow = dayOfWeek(target);
  if (dow === 1) return target; // Already Monday

  // Distance to previous Monday: dow - 1 days back if dow ≥ 1 else 6.
  // Distance to next Monday: 8 - dow if dow ≥ 1 else 1.
  const distPrev = dow === 0 ? 6 : dow - 1;
  const distNext = dow === 0 ? 1 : 8 - dow;
  return distPrev <= distNext ? addDays(target, -distPrev) : addDays(target, distNext);
}
