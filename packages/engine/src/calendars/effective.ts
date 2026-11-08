// Effective calendars: which calendar a task actually works in (parity row 4,
// spec docs/superpowers/specs/2026-10-16-effective-calendars-design.md).
//
// - `resolveCalendar` flattens `baseCalendarId` inheritance: `inheritedDays`
//   take the base's weekly intervals, and the base's exceptions apply on dates
//   the derived calendar doesn't override. Recursive, cycle-safe.
// - `intersectCalendars` keeps only time both calendars work. Exceptions from
//   either side are materialised per date as the intersection for that date.
// - `getEffectiveCalendar` = task calendar (or the default) ∩ every assigned
//   resource with an explicit calendar, unless `ignoreResourceCalendar`.
//   Resources without a calendar contribute nothing (deliberate deviation from
//   MS Project, where they'd clip a 24h task calendar back to Standard).
//
// Never throws for a calendar a project could already contain: an unknown or
// all-non-working task calendar falls back to the default, an empty
// intersection falls back to the task's own calendar, and each reports it via
// `fallback`. Summaries always get the default (as schedule() derives them).

import type {
  Calendar,
  CalendarException,
  CalendarId,
  Project,
  ResourceId,
  Task,
  TaskComputed,
  TaskId,
  WorkInterval,
} from '../types';
import { isPositiveInterval } from '../working-time';

export type CalendarFallback = NonNullable<TaskComputed['calendarFallback']>;

export interface EffectiveCalendar {
  calendar: Calendar;
  fallback?: CalendarFallback;
  /**
   * The calendar lags INTO this task run in, when it isn't `calendar`: an
   * elapsed-duration task's duration runs 24/7, but a "1d" lag into it is
   * still a working day of its real calendar (MS Project). Undefined = `calendar`.
   */
  lagCalendar?: Calendar;
}

/**
 * The calendar an elapsed-duration task's duration runs on: every minute of
 * every day works. Synthetic (id `__elapsed__`) — never in `project.calendars`;
 * `getEffectiveCalendar` returns it for elapsed tasks, with the task's real
 * calendar as `lagCalendar`.
 */
export const ELAPSED_CALENDAR: Calendar = {
  id: '__elapsed__',
  name: 'Elapsed (24/7)',
  workWeek: Array.from({ length: 7 }, () => [{ startMinutes: 0, endMinutes: 1440 }]),
  exceptions: [],
};

/** Ids compare as strings: MSPDI UIDs parse as strings, hand-built data often uses numbers. */
const key = (id: CalendarId | ResourceId | TaskId): string => String(id);

/**
 * Flatten `baseCalendarId` inheritance for calendar `id`. Returns `undefined`
 * if no calendar has that id. A calendar without a base is returned as-is.
 */
export function resolveCalendar(project: Project, id: CalendarId): Calendar | undefined {
  return createCalendarResolver(project).resolve(id);
}

/**
 * The calendar `schedule()` works task `taskId` in. Throws only if the
 * project's default calendar is missing (as `schedule()` always has).
 */
export function getEffectiveCalendar(project: Project, taskId: TaskId): EffectiveCalendar {
  const resolver = createCalendarResolver(project);
  const task = project.tasks.find((t) => key(t.id) === key(taskId));
  return task ? resolver.effectiveFor(task) : { calendar: resolver.defaultCalendar() };
}

/** Time both calendars work. The result has no base and no inherited days. */
export function intersectCalendars(a: Calendar, b: Calendar): Calendar {
  const workWeek = a.workWeek.map((day, i) => intersectIntervals(day, b.workWeek[i] ?? []));
  const aEx = exceptionsByDay(a);
  const bEx = exceptionsByDay(b);
  const dates = new Map<string, Date>();
  for (const ex of [...a.exceptions, ...b.exceptions]) dates.set(dateKey(ex.date), ex.date);
  const exceptions: CalendarException[] = [];
  for (const [k, date] of dates) {
    const intervals = intersectIntervals(
      intervalsOn(date, a, aEx.get(k)),
      intervalsOn(date, b, bEx.get(k)),
    );
    exceptions.push(
      intervals.length > 0
        ? { date: new Date(date), isWorking: true, intervals }
        : { date: new Date(date), isWorking: false },
    );
  }
  return { id: `${key(a.id)}∩${key(b.id)}`, name: `${a.name} ∩ ${b.name}`, workWeek, exceptions };
}

// ---------------------------------------------------------------------------
// Resolver: memoises resolution and intersections for one pass over a project.
// Not cached across calls, so in-place edits to project.calendars are seen.
// ---------------------------------------------------------------------------

export interface CalendarResolver {
  resolve(id: CalendarId): Calendar | undefined;
  defaultCalendar(): Calendar;
  effectiveFor(task: Task): EffectiveCalendar;
}

export function createCalendarResolver(project: Project): CalendarResolver {
  const byId = new Map<string, Calendar>();
  for (const c of project.calendars) if (!byId.has(key(c.id))) byId.set(key(c.id), c);
  const resolved = new Map<string, Calendar | undefined>();
  const effective = new Map<string, EffectiveCalendar>();
  const resourceCal = new Map<string, CalendarId>();
  for (const r of project.resources) {
    if (r.calendarId !== undefined) resourceCal.set(key(r.id), r.calendarId);
  }
  const resourcesByTask = new Map<string, Set<string>>();
  for (const a of project.assignments) {
    const set = resourcesByTask.get(key(a.taskId)) ?? new Set<string>();
    set.add(key(a.resourceId));
    resourcesByTask.set(key(a.taskId), set);
  }

  function resolveWith(id: CalendarId, seen: Set<string>): Calendar | undefined {
    const k = key(id);
    if (resolved.has(k)) return resolved.get(k);
    const cal = byId.get(k);
    if (!cal) return undefined;
    let out: Calendar = cal;
    if (cal.baseCalendarId !== undefined || cal.inheritedDays !== undefined) {
      const { baseCalendarId, inheritedDays, ...own } = cal;
      const base =
        baseCalendarId !== undefined && !seen.has(key(baseCalendarId))
          ? resolveWith(baseCalendarId, new Set([...seen, k]))
          : undefined;
      if (!base) {
        out = own;
      } else {
        const inherited = new Set<number>(inheritedDays ?? []);
        const ownDates = new Set(cal.exceptions.map((e) => dateKey(e.date)));
        out = {
          ...own,
          // Always 7 days: a short hand-built workWeek still inherits.
          workWeek: Array.from({ length: 7 }, (_, i) =>
            inherited.has(i) ? (base.workWeek[i] ?? []) : (cal.workWeek[i] ?? []),
          ),
          exceptions: [
            ...cal.exceptions,
            ...base.exceptions.filter((e) => !ownDates.has(dateKey(e.date))),
          ],
        };
      }
    }
    // Only cache top-level resolutions: a cycle-broken inner result depends on `seen`.
    if (seen.size === 0) resolved.set(k, out);
    return out;
  }

  const resolve = (id: CalendarId) => resolveWith(id, new Set());

  function defaultCalendar(): Calendar {
    const cal = resolve(project.defaultCalendarId);
    if (!cal) throw new Error(`Project default calendar "${project.defaultCalendarId}" not found`);
    return cal;
  }

  function effectiveFor(task: Task): EffectiveCalendar {
    // Summaries span their children; schedule() derives them in the default.
    if (task.type === 'summary') return { calendar: defaultCalendar() };
    // An elapsed duration runs through all time, whatever the calendars say
    // (MSP); lags into it stay in its real calendar.
    if (task.durationElapsed) {
      const real = effectiveFor({ ...task, durationElapsed: false });
      return { ...real, calendar: ELAPSED_CALENDAR, lagCalendar: real.calendar };
    }
    let fallback: CalendarFallback | undefined;
    let own: Calendar | undefined;
    if (task.calendarId !== undefined) {
      own = resolve(task.calendarId);
      if (!own) fallback = 'unknown-calendar';
      else if (!hasWorkingTime(own)) {
        // All non-working (or a broken base chain): working-time maths would throw.
        own = undefined;
        fallback = 'empty-calendar';
      }
    }
    const ownCal = own ?? defaultCalendar();

    const resCalIds: string[] = [];
    if (!task.ignoreResourceCalendar) {
      const resourceIds = new Set(resourcesByTask.get(key(task.id)));
      for (const rid of task.resourceIds ?? []) resourceIds.add(key(rid));
      for (const rid of resourceIds) {
        const cid = resourceCal.get(rid);
        if (cid !== undefined && resolve(cid)) resCalIds.push(key(cid));
      }
    }
    const resKey = [...new Set(resCalIds)].sort();
    if (resKey.length === 0)
      return fallback ? { calendar: ownCal, fallback } : { calendar: ownCal };

    const cacheKey = `${key(ownCal.id)}|${resKey.join('|')}`;
    let combined = effective.get(cacheKey);
    if (!combined) {
      let cal = ownCal;
      // biome-ignore lint/style/noNonNullAssertion: resKey entries were resolved above
      for (const cid of resKey) cal = intersectCalendars(cal, resolve(cid)!);
      combined = hasWorkingTime(cal)
        ? { calendar: cal }
        : { calendar: ownCal, fallback: 'empty-intersection' };
      effective.set(cacheKey, combined);
    }
    // An unknown task calendar outranks an empty intersection in the report.
    return fallback ? { calendar: combined.calendar, fallback } : combined;
  }

  return { resolve, defaultCalendar, effectiveFor };
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

function intersectIntervals(a: WorkInterval[], b: WorkInterval[]): WorkInterval[] {
  const as = [...a].sort((x, y) => x.startMinutes - y.startMinutes);
  const bs = [...b].sort((x, y) => x.startMinutes - y.startMinutes);
  const out: WorkInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < as.length && j < bs.length) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by the loop condition
    const x = as[i]!;
    // biome-ignore lint/style/noNonNullAssertion: bounded by the loop condition
    const y = bs[j]!;
    const start = Math.max(x.startMinutes, y.startMinutes);
    const end = Math.min(x.endMinutes, y.endMinutes);
    if (end > start) out.push({ startMinutes: start, endMinutes: end });
    if (x.endMinutes < y.endMinutes) i++;
    else j++;
  }
  return out;
}

/** First exception per day wins, matching working-time's `findException`. */
function exceptionsByDay(cal: Calendar): Map<string, CalendarException> {
  const map = new Map<string, CalendarException>();
  for (const e of cal.exceptions) if (!map.has(dateKey(e.date))) map.set(dateKey(e.date), e);
  return map;
}

function intervalsOn(date: Date, cal: Calendar, ex: CalendarException | undefined): WorkInterval[] {
  if (ex) return ex.isWorking ? (ex.intervals ?? []) : [];
  return cal.workWeek[date.getDay()] ?? [];
}

function hasWorkingTime(cal: Calendar): boolean {
  return (
    cal.workWeek.some((d) => d.some(isPositiveInterval)) ||
    cal.exceptions.some((e) => e.isWorking && (e.intervals ?? []).some(isPositiveInterval))
  );
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
