/**
 * Tiny shared date-arithmetic helpers used across the calendars module.
 * Kept module-private (not re-exported from the package entry).
 */

export function dayOfWeek(date: Date): number {
  // 0 = Sun … 6 = Sat
  return date.getDay();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
