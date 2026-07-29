/**
 * Mondayisation rules per Holidays Act 2003 (NZ).
 *
 * Single-day mondayisation (Waitangi, ANZAC): if the statutory date falls
 * on Saturday or Sunday, the observed date is the following Monday.
 *
 * Pair-rule mondayisation (Jan 1 / 2 Jan; Dec 25 / 26): the pair is
 * inseparable. If either falls on a weekend, the pair shifts forward
 * together — the first takes Monday (or stays where it is if already a
 * weekday), the second takes Tuesday if its natural slot conflicts with
 * the first's Monday, or stays unchanged otherwise.
 */

import { addDays, dayOfWeek } from './date-utils.js';

export function mondayiseSingle(date: Date): Date {
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, 2); // Sat → Mon
  if (dow === 0) return addDays(date, 1); // Sun → Mon
  return new Date(date);
}

/**
 * Apply the pair rule to a [first, second] pair where `second` is exactly
 * one calendar day after `first` (Jan 1 / 2 Jan or Dec 25 / 26). Returns
 * the observed [first, second] pair.
 */
export function mondayisePair(first: Date, second: Date): [Date, Date] {
  const firstDow = dayOfWeek(first);

  // First on Sat → first observed Mon (+2), second observed Tue (+2)
  if (firstDow === 6) {
    return [addDays(first, 2), addDays(second, 2)];
  }
  // First on Sun → first observed Mon (+1), second observed Tue (+1).
  // (Second's natural day is Mon, which is now taken by first; bump to Tue.)
  if (firstDow === 0) {
    return [addDays(first, 1), addDays(second, 1)];
  }
  // First on Fri → first stays Fri; second (originally Sat) shifts to Mon (+2).
  if (firstDow === 5) {
    return [new Date(first), addDays(second, 2)];
  }
  // First on Mon-Thu → no shift; second is naturally Tue–Fri.
  return [new Date(first), new Date(second)];
}
