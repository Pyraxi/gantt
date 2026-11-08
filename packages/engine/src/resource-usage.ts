// Resource usage and over-allocation (parity row 7, histogram slice): each
// resource's assigned working minutes per period against what its calendar
// can give. Read-only — never moves a task (levelling is out, ADR-003).
// Spec: docs/superpowers/specs/2026-10-16-resource-usage-design.md

import { createCalendarResolver } from './calendars/effective';
import { actualMinutes, remainingMinutes, schedule } from './schedule';
import type { Calendar, Project, ResourceId, Task, TaskId } from './types';
import { addWorkingMinutes, createWorkingMinutesCounter } from './working-time';

export interface UsagePeriod {
  start: Date;
  /** Exclusive. */
  end: Date;
  /** Assigned working minutes: Σ units × the minutes each task works here. */
  load: number;
  /** The resource calendar's working minutes here, at 100%. */
  capacity: number;
  overAllocated: boolean;
  /** Tasks that put load here, in project order. */
  taskIds: TaskId[];
}

export interface ResourceUsage {
  resourceId: ResourceId;
  periods: UsagePeriod[];
}

export interface ResourceUsageOptions {
  /**
   * Buckets are whole days (or Monday-start weeks): `from` / `to` pick the
   * buckets, they don't clip load inside one. Default `from`: the day of the
   * earliest scheduled task.
   */
  from?: Date;
  /** Exclusive. Default: the day after the latest scheduled end. */
  to?: Date;
  /** `'day'` (default) or `'week'` (Monday-start). */
  bucket?: 'day' | 'week';
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A task that can carry work: not a summary, milestone or unscheduled task. */
const carriesWork = (t: Task) =>
  t.type !== 'summary' && t.type !== 'milestone' && !t.unscheduled && t.end > t.start;

const needsSchedule = (p: Project) => p.tasks.some((t) => !t.computed && !t.unscheduled);

/**
 * When a task actually works: its segments (a split task's gap is idle); for
 * an in-progress task under a status date, the work done from its start plus
 * the remaining work from `computed.remainingStart` (not the idle gap
 * between); otherwise start → end.
 */
function workSpans(
  task: Task,
  cal: Calendar,
  statusDate: Date | undefined,
  /** `Project.rescheduleAfterStatusDate`: the remaining work was forecast from the status date. */
  fromStatus = false,
): [Date, Date][] {
  // Splits are manual-only (ADR-007): an auto task's segments are stale, and
  // schedule() and the bars ignore them too.
  if (task.scheduleMode === 'manual' && task.segments && task.segments.length > 0) {
    return task.segments.map((s) => [s.start, s.end] as [Date, Date]);
  }
  const rest = task.computed?.remainingStart;
  if (statusDate && rest && rest > task.start) {
    // Work done is % complete of the duration (MS Project's actual duration):
    // an Expected Finish or a long remaining duration re-forecasts what is
    // left, not what was already done. No % → what the remaining implies.
    // By default (MS Project) exactly what schedule() placed before the remaining work.
    const remaining = remainingMinutes(task, { statusDate, calendar: cal });
    const done = !fromStatus
      ? actualMinutes(task, remaining)
      : task.progress > 0
        ? Math.round((task.duration * Math.min(100, task.progress)) / 100)
        : Math.max(0, task.duration - remaining);
    const spans: [Date, Date][] = [];
    if (done > 0) spans.push([task.start, addWorkingMinutes(task.start, done, cal)]);
    if (task.end > rest) spans.push([rest, task.end]);
    return spans;
  }
  return [[task.start, task.end]];
}

/**
 * Per resource, the load and capacity of each day (or Monday-start week) in
 * `from`..`to`. A task works its work spans on its effective calendar (task ∩
 * resource calendars, ADR-011). Assignments are `project.assignments` plus
 * `Task.resourceIds` (units 1), as the effective calendar reads them.
 * Summaries, milestones and unscheduled tasks carry no work; completed work
 * counts (a plan view, as MS Project's Resource Graph). Pure; schedules the
 * project when `computed` is missing.
 */
export function resourceUsage(
  project: Project,
  options: ResourceUsageOptions = {},
): ResourceUsage[] {
  const p = needsSchedule(project) ? schedule(project) : project;
  const resolver = createCalendarResolver(p);
  const live = p.tasks.filter(carriesWork);
  if (live.length === 0 && (options.from === undefined || options.to === undefined)) {
    return p.resources.map((r) => ({ resourceId: r.id, periods: [] }));
  }
  const from = startOfDay(
    options.from ?? new Date(live.reduce((m, t) => Math.min(m, t.start.getTime()), Infinity)),
  );
  const to =
    options.to ??
    addDays(
      startOfDay(new Date(live.reduce((m, t) => Math.max(m, t.end.getTime()), -Infinity))),
      1,
    );
  const step = options.bucket === 'week' ? 7 : 1;
  const first = options.bucket === 'week' ? addDays(from, -((from.getDay() + 6) % 7)) : from;
  const edges: Date[] = [];
  for (let d = first; d < to; d = addDays(d, step)) edges.push(d);
  if (edges.length === 0) return p.resources.map((r) => ({ resourceId: r.id, periods: [] }));
  edges.push(addDays(edges[edges.length - 1] as Date, step));
  const edgeMs = edges.map((d) => d.getTime());
  /** Index of the bucket containing ms (or the one before it), by binary search. */
  const bucketOf = (ms: number) => {
    let lo = 0;
    let hi = edgeMs.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((edgeMs[mid] as number) <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // One O(1)-per-query counter per calendar.
  const counters = new Map<Calendar, (a: Date, b: Date) => number>();
  const counter = (cal: Calendar) => {
    let c = counters.get(cal);
    if (!c) {
      c = createWorkingMinutesCounter(cal);
      counters.set(cal, c);
    }
    return c;
  };

  // Each calendar's working minutes per whole bucket, filled on demand.
  const fullByCal = new Map<Calendar, Float64Array>();
  const fullBucketMinutes = (cal: Calendar) => {
    let arr = fullByCal.get(cal);
    if (!arr) {
      arr = new Float64Array(edges.length - 1).fill(Number.NaN);
      fullByCal.set(cal, arr);
    }
    const table = arr;
    const count = counter(cal);
    return (i: number) => {
      let v = table[i] as number;
      if (Number.isNaN(v)) {
        v = count(edges[i] as Date, edges[i + 1] as Date);
        table[i] = v;
      }
      return v;
    };
  };

  // Work items per resource: explicit assignments, then resourceIds not
  // already assigned (units 1).
  const byTask = new Map(p.tasks.map((t) => [String(t.id), t]));
  const work = new Map<string, { task: Task; units: number }[]>();
  const add = (rid: ResourceId, task: Task | undefined, units: number, sum: boolean) => {
    if (!task || !carriesWork(task)) return;
    const list = work.get(String(rid)) ?? [];
    const existing = list.find((w) => w.task === task);
    // Two assignments of one resource add up (two part-time slots); a
    // resourceIds entry for an assigned pair adds nothing.
    if (existing) {
      if (sum) existing.units += units;
      return;
    }
    list.push({ task, units });
    work.set(String(rid), list);
  };
  for (const a of p.assignments) {
    add(a.resourceId, byTask.get(String(a.taskId)), a.units ?? 1, true);
  }
  for (const t of p.tasks) for (const rid of t.resourceIds ?? []) add(rid, t, 1, false);

  const order = new Map(p.tasks.map((t, i) => [String(t.id), i]));
  return p.resources.map((r) => {
    const capCal =
      (r.calendarId !== undefined && resolver.resolve(r.calendarId)) || resolver.defaultCalendar();
    const capFull = fullBucketMinutes(capCal);
    const periods: UsagePeriod[] = edges.slice(0, -1).map((start, i) => ({
      start: new Date(start),
      end: new Date(edges[i + 1] as Date),
      load: 0,
      capacity: capFull(i),
      overAllocated: false,
      taskIds: [],
    }));
    // The last task added to each period: visits of one task are consecutive,
    // so this replaces a scan of the period's list.
    const lastAdded: (string | undefined)[] = new Array(periods.length);
    for (const { task, units } of work.get(String(r.id)) ?? []) {
      const cal = resolver.effectiveFor(task).calendar;
      const count = counter(cal);
      const full = fullBucketMinutes(cal);
      const taskKey = String(task.id);
      for (const [a, b] of workSpans(task, cal, p.statusDate, p.rescheduleAfterStatusDate)) {
        const aMs = Math.max(a.getTime(), edgeMs[0] as number);
        const bMs = Math.min(b.getTime(), edgeMs[edgeMs.length - 1] as number);
        if (bMs <= aMs) continue;
        // Only the buckets this span overlaps; a fully covered bucket is the
        // calendar's per-bucket minutes, the partial ends go to the counter.
        for (let i = bucketOf(aMs); i < periods.length && (edgeMs[i] as number) < bMs; i++) {
          const e0 = edgeMs[i] as number;
          const e1 = edgeMs[i + 1] as number;
          const lo = Math.max(aMs, e0);
          const hi = Math.min(bMs, e1);
          if (hi <= lo) continue;
          const base = lo === e0 && hi === e1 ? full(i) : count(new Date(lo), new Date(hi));
          const minutes = units * base;
          if (minutes <= 0) continue;
          const period = periods[i] as UsagePeriod;
          period.load += minutes;
          if (lastAdded[i] !== taskKey) {
            lastAdded[i] = taskKey;
            if (!period.taskIds.some((id) => String(id) === taskKey)) period.taskIds.push(task.id);
          }
        }
      }
    }
    for (const period of periods) {
      period.overAllocated = period.load > period.capacity;
      period.taskIds.sort((x, y) => (order.get(String(x)) ?? 0) - (order.get(String(y)) ?? 0));
    }
    return { resourceId: r.id, periods };
  });
}

export interface OverAllocation {
  resourceId: ResourceId;
  start: Date;
  /** Exclusive. */
  end: Date;
  load: number;
  capacity: number;
  /** Tasks that load the stretch, in project order. */
  taskIds: TaskId[];
}

/**
 * The over-allocated stretches: consecutive over-allocated days (or weeks)
 * merged, with the tasks that load them — ready to list, or to feed
 * `<Gantt highlights>`.
 */
export function overAllocations(
  project: Project,
  options: ResourceUsageOptions = {},
): OverAllocation[] {
  const order = new Map(project.tasks.map((t, i) => [String(t.id), i]));
  const out: OverAllocation[] = [];
  for (const usage of resourceUsage(project, options)) {
    let run: OverAllocation | undefined;
    for (const period of usage.periods) {
      if (!period.overAllocated) {
        run = undefined;
        continue;
      }
      if (!run) {
        run = {
          resourceId: usage.resourceId,
          start: period.start,
          end: period.end,
          load: 0,
          capacity: 0,
          taskIds: [],
        };
        out.push(run);
      }
      run.end = period.end;
      run.load += period.load;
      run.capacity += period.capacity;
      for (const id of period.taskIds) {
        if (!run.taskIds.some((x) => String(x) === String(id))) run.taskIds.push(id);
      }
    }
  }
  for (const o of out) {
    o.taskIds.sort((x, y) => (order.get(String(x)) ?? 0) - (order.get(String(y)) ?? 0));
  }
  return out;
}
