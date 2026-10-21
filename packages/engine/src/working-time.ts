import type { Calendar, CalendarException, WorkInterval } from './types';

export function isWorkingDay(date: Date, calendar: Calendar): boolean {
  return getIntervalsForDay(date, calendar).length > 0;
}

/**
 * True iff `date`'s time-of-day falls within a working interval for that day,
 * honouring exceptions and split shifts. The intraday sibling of `isWorkingDay`.
 *
 * Membership is `[startMinutes, endMinutes)` (end-exclusive). Granularity is the
 * supplied moment — callers shading hour cells pass the cell's start; a shift
 * boundary mid-hour therefore classifies the whole hour by its start.
 */
export function isWorkingTime(date: Date, calendar: Calendar): boolean {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return getIntervalsForDay(date, calendar).some(
    (iv) => minutes >= iv.startMinutes && minutes < iv.endMinutes,
  );
}

export function getDayWorkingMinutes(date: Date, calendar: Calendar): number {
  return getIntervalsForDay(date, calendar).reduce(
    (sum, iv) => sum + (iv.endMinutes - iv.startMinutes),
    0,
  );
}

/**
 * Add `minutes` of working time to `start`, skipping non-working time
 * (weekends, holidays, partial-day shift gaps). The result is the wall-clock
 * Date exactly `minutes` working-time-minutes after `start`.
 *
 * If `start` falls in a non-working moment (weekend, after-hours, lunch
 * break), the working-time clock begins from the next working interval.
 *
 * Note: not DST-aware. Working hours are wall-clock; cross-DST scheduling
 * is approximate. Real DST handling is a future enhancement.
 */
export function addWorkingMinutes(start: Date, minutes: number, calendar: Calendar): Date {
  if (minutes <= 0) return new Date(start);

  let current = new Date(start);
  let remaining = minutes;

  while (remaining > 0) {
    const interval = findNextWorkingInterval(current, calendar);
    if (!interval) {
      throw new Error('Calendar has no working time within ~1 year after the given date');
    }

    if (current < interval.start) current = new Date(interval.start);

    const availableMinutes = (interval.end.getTime() - current.getTime()) / 60_000;

    if (remaining <= availableMinutes) {
      return new Date(current.getTime() + remaining * 60_000);
    }

    remaining -= availableMinutes;
    current = new Date(interval.end);
  }

  return current;
}

/**
 * Subtract `minutes` of working time from `end`, walking backward through
 * working intervals. Backward-pass mirror of {@link addWorkingMinutes}.
 *
 * If `end` falls in a non-working moment, the clock begins from the end of
 * the most recent working interval.
 */
export function subtractWorkingMinutes(end: Date, minutes: number, calendar: Calendar): Date {
  if (minutes <= 0) return new Date(end);

  let current = new Date(end);
  let remaining = minutes;

  while (remaining > 0) {
    const interval = findPreviousWorkingInterval(current, calendar);
    if (!interval) {
      throw new Error('Calendar has no working time within ~1 year before the given date');
    }

    if (current > interval.end) current = new Date(interval.end);

    const availableMinutes = (current.getTime() - interval.start.getTime()) / 60_000;

    if (remaining <= availableMinutes) {
      return new Date(current.getTime() - remaining * 60_000);
    }

    remaining -= availableMinutes;
    current = new Date(interval.start);
  }

  return current;
}

/**
 * Return the next working moment at or after `date`. If `date` already falls
 * inside a working interval, returns it unchanged. If it falls in non-working
 * time (weekend, after-hours, lunch break, holiday), returns the start of the
 * next working interval.
 */
export function snapToNextWorkingMoment(date: Date, calendar: Calendar): Date {
  const interval = findNextWorkingInterval(date, calendar);
  if (!interval) {
    throw new Error('Calendar has no working time within ~1 year after the given date');
  }
  return date < interval.start ? new Date(interval.start) : new Date(date);
}

/**
 * Return the previous working moment at or before `date`. Mirror of
 * {@link snapToNextWorkingMoment} for backward-pass scheduling.
 */
export function snapToPreviousWorkingMoment(date: Date, calendar: Calendar): Date {
  const interval = findPreviousWorkingInterval(date, calendar);
  if (!interval) {
    throw new Error('Calendar has no working time within ~1 year before the given date');
  }
  return date > interval.end ? new Date(interval.end) : new Date(date);
}

/**
 * Working-minute distance from `a` to `b`. Positive if `a` is earlier than
 * `b`, negative if `a` is later. Used to compute slack (lateStart - earlyStart
 * in working time).
 */
export function workingMinutesBetween(a: Date, b: Date, calendar: Calendar): number {
  if (a.getTime() === b.getTime()) return 0;
  const reverse = a > b;
  const start = reverse ? b : a;
  const end = reverse ? a : b;

  let current = new Date(start);
  let total = 0;
  while (current < end) {
    const interval = findNextWorkingInterval(current, calendar);
    if (!interval) break;
    if (current < interval.start) current = new Date(interval.start);
    if (current >= end) break;

    if (interval.end >= end) {
      total += (end.getTime() - current.getTime()) / 60_000;
      break;
    }
    total += (interval.end.getTime() - current.getTime()) / 60_000;
    current = new Date(interval.end);
  }

  // `|| 0`: a reverse span with no working time is 0, not -0.
  return reverse ? -total || 0 : total;
}

/**
 * Working-minute distances for many date pairs in one calendar — the same
 * answer as {@link workingMinutesBetween}, but each day's working time is
 * computed once and kept in a running total, so a query is O(1) after the
 * first pass over its date range (slack to the project finish across a
 * 5,000-task open-ended programme).
 */
export function createWorkingMinutesCounter(calendar: Calendar): (a: Date, b: Date) => number {
  const exceptions = new Map<string, CalendarException>();
  for (const ex of calendar.exceptions) {
    const k = `${ex.date.getFullYear()}-${ex.date.getMonth()}-${ex.date.getDate()}`;
    if (!exceptions.has(k)) exceptions.set(k, ex);
  }
  const DAY_MS = 86_400_000;
  const dayIndex = (d: Date) =>
    Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
  /**
   * Working intervals of day `idx`, as [start, end] epoch-ms pairs. Cached
   * per day: a caller sweeping buckets asks for the same days again and again
   * (the resource histogram re-queries on every pan / zoom).
   */
  const dayCache = new Map<number, [number, number][]>();
  const intervalsOf = (idx: number): [number, number][] => {
    const cached = dayCache.get(idx);
    if (cached) return cached;
    const ivs = computeIntervals(idx);
    dayCache.set(idx, ivs);
    return ivs;
  };
  const computeIntervals = (idx: number): [number, number][] => {
    const u = new Date(idx * DAY_MS);
    const y = u.getUTCFullYear();
    const m = u.getUTCMonth();
    const d = u.getUTCDate();
    const ex = exceptions.get(`${y}-${m}-${d}`);
    const ivs = workingIntervals(
      ex ? (ex.isWorking ? (ex.intervals ?? []) : []) : (calendar.workWeek[u.getUTCDay()] ?? []),
    );
    return ivs.map((iv) => [
      new Date(y, m, d, 0, iv.startMinutes).getTime(),
      new Date(y, m, d, 0, iv.endMinutes).getTime(),
    ]);
  };
  const overlap = (from: number, to: number, ivs: [number, number][]) => {
    let ms = 0;
    for (const [s, e] of ivs) ms += Math.max(0, Math.min(to, e) - Math.max(from, s));
    return ms / 60_000;
  };
  // prefix[i] = working minutes of days base … base + i − 1.
  let base = 0;
  let prefix: number[] = [];
  const ensure = (lo: number, hi: number) => {
    if (prefix.length > 0 && lo >= base && hi < base + prefix.length - 1) return;
    // Grow with a year of slack each side, so a stream of nearby queries
    // doesn't rebuild the table every time.
    const PAD = 366;
    const from = (prefix.length > 0 ? Math.min(lo, base) : lo) - PAD;
    const to = (prefix.length > 0 ? Math.max(hi, base + prefix.length - 2) : hi) + PAD;
    const next = [0];
    for (let i = from; i <= to; i++) {
      next.push((next[next.length - 1] ?? 0) + overlap(-Infinity, Infinity, intervalsOf(i)));
    }
    base = from;
    prefix = next;
  };
  const fullDays = (lo: number, hi: number) => {
    if (hi < lo) return 0;
    ensure(lo, hi);
    return (prefix[hi - base + 1] ?? 0) - (prefix[lo - base] ?? 0);
  };
  return (a, b) => {
    if (a.getTime() === b.getTime()) return 0;
    const reverse = a > b;
    const start = reverse ? b : a;
    const end = reverse ? a : b;
    const ia = dayIndex(start);
    const ib = dayIndex(end);
    const total =
      ia === ib
        ? overlap(start.getTime(), end.getTime(), intervalsOf(ia))
        : overlap(start.getTime(), Infinity, intervalsOf(ia)) +
          fullDays(ia + 1, ib - 1) +
          overlap(-Infinity, end.getTime(), intervalsOf(ib));
    return reverse ? -total || 0 : total;
  };
}

interface DatedInterval {
  start: Date;
  end: Date;
}

/**
 * Find the earliest working interval whose end is strictly after `date`.
 * Walks forward up to ~1 year before giving up.
 */
function findNextWorkingInterval(date: Date, calendar: Calendar): DatedInterval | null {
  const msPerDay = 24 * 60 * 60 * 1000;
  let day = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  for (let i = 0; i < 366; i++) {
    const intervals = getIntervalsForDay(day, calendar);
    for (const iv of intervals) {
      const intervalStart = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        0,
        iv.startMinutes,
      );
      const intervalEnd = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        0,
        iv.endMinutes,
      );
      if (intervalEnd > date) {
        return { start: intervalStart, end: intervalEnd };
      }
    }
    day = new Date(day.getTime() + msPerDay);
  }
  return null;
}

/**
 * Find the latest working interval whose start is strictly before `date`.
 * Walks backward up to ~1 year before giving up.
 */
function findPreviousWorkingInterval(date: Date, calendar: Calendar): DatedInterval | null {
  const msPerDay = 24 * 60 * 60 * 1000;
  let day = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  for (let i = 0; i < 366; i++) {
    const intervals = getIntervalsForDay(day, calendar);
    for (let j = intervals.length - 1; j >= 0; j--) {
      const iv = intervals[j];
      if (!iv) continue;
      const intervalStart = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        0,
        iv.startMinutes,
      );
      const intervalEnd = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        0,
        iv.endMinutes,
      );
      if (intervalStart < date) {
        return { start: intervalStart, end: intervalEnd };
      }
    }
    day = new Date(day.getTime() - msPerDay);
  }
  return null;
}

function getIntervalsForDay(date: Date, calendar: Calendar): WorkInterval[] {
  const exception = findException(date, calendar);
  if (exception) {
    return exception.isWorking ? workingIntervals(exception.intervals ?? []) : [];
  }
  return workingIntervals(calendar.workWeek[date.getDay()] ?? []);
}

/**
 * A day's intervals with any inverted or zero-length one (end <= start)
 * dropped: it holds no working time. Every working-time read in this module
 * goes through here, so such an interval can't add negative time (inflating a
 * duration) or leave a calendar with "intervals" but nothing to work in.
 */
export function workingIntervals(intervals: WorkInterval[]): WorkInterval[] {
  return intervals.every(isPositiveInterval) ? intervals : intervals.filter(isPositiveInterval);
}

/** True iff the interval holds working time (end after start). */
export function isPositiveInterval(iv: WorkInterval): boolean {
  return iv.endMinutes > iv.startMinutes;
}

function findException(date: Date, calendar: Calendar): CalendarException | undefined {
  return calendar.exceptions.find((ex) => isSameCalendarDay(ex.date, date));
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
