// Schedule comparison (parity row 9b): what changed between two revisions of
// a programme — P6 Claim Digger / MS Project Compare Project Versions.
// Spec: docs/superpowers/specs/2026-10-16-compare-schedules-design.md
//
// Pure: schedules either side when `computed` is missing (or always, with
// `reschedule`); never mutates input; output Dates are copies.

import { createCalendarResolver } from './calendars/effective';
import { progressState, schedule } from './schedule';
import type {
  Baseline,
  BaselineIndex,
  BaselineTaskSnapshot,
  Calendar,
  Constraint,
  DependencyType,
  Link,
  Project,
  Task,
  TaskComputed,
  TaskId,
  TaskType,
} from './types';
import { createWorkingMinutesCounter } from './working-time';

/**
 * A date / duration / float change. `delta` is signed working minutes in the
 * task's own (`after`) calendar — positive = later / longer / more. It can be
 * 0 for a move across non-working time only (Fri 17:00 → Mon 08:00); use
 * `from` / `to` for calendar time.
 */
export interface Delta<T> {
  from: T;
  to: T;
  delta: number;
}

export interface Change<T> {
  from: T;
  to: T;
}

export interface TaskChanges {
  name?: Change<string>;
  type?: Change<TaskType>;
  unscheduled?: Change<boolean>;
  start?: Delta<Date>;
  finish?: Delta<Date>;
  duration?: Delta<number>;
  progress?: Change<number>;
  /** Present when either side has a status date (parity row 6). */
  status?: Change<TaskComputed['status']>;
  actualStart?: Change<Date | undefined>;
  actualFinish?: Change<Date | undefined>;
  remainingDuration?: Change<number | undefined>;
  /** Physical % complete moved (a site judgement, independent of `progress`). */
  physicalProgress?: Change<number | undefined>;
  totalFloat?: Delta<number>;
  critical?: Change<boolean>;
  constraint?: Change<Constraint | undefined>;
  parent?: Change<TaskId | undefined>;
}

export interface TaskComparison {
  id: TaskId;
  /** The task's name (from `after`, or `before` when removed). */
  text: string;
  kind: 'added' | 'removed' | 'changed';
  isSummary: boolean;
  /** Present for `'changed'`: only the fields that differ. */
  changes?: TaskChanges;
}

export interface LinkComparison {
  source: TaskId;
  target: TaskId;
  kind: 'added' | 'removed' | 'changed';
  /** The link's type, for added / removed links. */
  type?: DependencyType;
  /** Present for `'changed'`. */
  changes?: {
    type?: Change<DependencyType>;
    lag?: Change<number>;
    lagPercent?: Change<number | undefined>;
    lagElapsed?: Change<boolean>;
  };
}

export interface ScheduleComparison {
  /** Changed tasks in `after` order, then removed tasks in `before` order. Unchanged tasks are omitted. */
  tasks: TaskComparison[];
  /** Changed links in `after` order, then removed links. Matched by predecessor → successor. */
  links: LinkComparison[];
  /** Counts cover leaf tasks only (summaries are listed in `tasks` but not counted). */
  summary: {
    added: number;
    removed: number;
    /** Tasks whose start or finish changed. */
    moved: number;
    durationChanged: number;
    /** Links added, removed or changed. */
    logicChanged: number;
    becameCritical: number;
    /** Excludes tasks that simply completed. */
    noLongerCritical: number;
    /** Project finish (latest leaf early finish), in `after`'s default calendar. */
    finish: Delta<Date | undefined>;
  };
}

export interface CompareSchedulesOptions {
  /**
   * `'scheduled'` (default) compares `computed` early dates; `'planned'`
   * compares the tasks' own `start` / `end` as given.
   */
  dates?: 'scheduled' | 'planned';
  /** Re-run `schedule()` on both sides even when they carry `computed`. */
  reschedule?: boolean;
}

/** Compare two revisions of a schedule. Throws where `schedule()` would (e.g. a link cycle). */
export function compareSchedules(
  before: Project,
  after: Project,
  options: CompareSchedulesOptions = {},
): ScheduleComparison {
  const b = ensureScheduled(before, options.reschedule);
  const a = ensureScheduled(after, options.reschedule);
  const planned = options.dates === 'planned';
  // Planned mode reads the inputs as given: scheduling rewrites auto tasks' start / end.
  const inputBefore = new Map(before.tasks.map((t) => [String(t.id), t]));
  const inputAfter = new Map(after.tasks.map((t) => [String(t.id), t]));
  const startOf = (t: Task, input: Map<string, Task>) =>
    planned ? (input.get(String(t.id)) ?? t).start : (t.computed?.earlyStart ?? t.start);
  const finishOf = (t: Task, input: Map<string, Task>) =>
    planned ? (input.get(String(t.id)) ?? t).end : (t.computed?.earlyFinish ?? t.end);

  // Deltas in each task's own `after` calendar; one memoised counter per calendar.
  const resolver = createCalendarResolver(a);
  const counters = new Map<Calendar, (x: Date, y: Date) => number>();
  const counterFor = (cal: Calendar) => {
    let c = counters.get(cal);
    if (!c) {
      c = createWorkingMinutesCounter(cal);
      counters.set(cal, c);
    }
    return c;
  };
  const defaultCount = counterFor(resolver.defaultCalendar());
  const statusOf = (p: Project, t: Task) =>
    p.statusDate && t.type !== 'summary' ? progressState(t) : undefined;

  const beforeById = new Map(b.tasks.map((t) => [String(t.id), t]));
  const afterIds = new Set(a.tasks.map((t) => String(t.id)));
  const tasks: TaskComparison[] = [];
  const summary: ScheduleComparison['summary'] = {
    added: 0,
    removed: 0,
    moved: 0,
    durationChanged: 0,
    logicChanged: 0,
    becameCritical: 0,
    noLongerCritical: 0,
    finish: projectFinishDelta(b, a, defaultCount),
  };

  for (const t of a.tasks) {
    const isSummary = t.type === 'summary';
    const old = beforeById.get(String(t.id));
    if (!old) {
      tasks.push({ id: t.id, text: t.text, kind: 'added', isSummary });
      if (!isSummary) summary.added++;
      continue;
    }
    const count = isSummary ? defaultCount : counterFor(resolver.effectiveFor(t).calendar);
    const changes: TaskChanges = {};
    if (old.text !== t.text) changes.name = { from: old.text, to: t.text };
    if (old.type !== t.type) changes.type = { from: old.type, to: t.type };
    const un0 = !!old.unscheduled;
    const un1 = !!t.unscheduled;
    if (un0 !== un1) changes.unscheduled = { from: un0, to: un1 };
    // Dates, float and criticality only mean something when both sides are scheduled.
    const scheduled = !un0 && !un1;
    if (scheduled) {
      const s0 = startOf(old, inputBefore);
      const s1 = startOf(t, inputAfter);
      const f0 = finishOf(old, inputBefore);
      const f1 = finishOf(t, inputAfter);
      if (s0.getTime() !== s1.getTime()) {
        changes.start = { from: new Date(s0), to: new Date(s1), delta: count(s0, s1) || 0 };
      }
      if (f0.getTime() !== f1.getTime()) {
        changes.finish = { from: new Date(f0), to: new Date(f1), delta: count(f0, f1) || 0 };
      }
    }
    if (old.duration !== t.duration) {
      changes.duration = { from: old.duration, to: t.duration, delta: t.duration - old.duration };
    }
    if ((old.progress ?? 0) !== (t.progress ?? 0)) {
      changes.progress = { from: old.progress ?? 0, to: t.progress ?? 0 };
    }
    const st0 = statusOf(b, old);
    const st1 = statusOf(a, t);
    if (st0 !== st1) changes.status = { from: st0, to: st1 };
    for (const key of ['actualStart', 'actualFinish'] as const) {
      const x = old[key];
      const y = t[key];
      if ((x?.getTime() ?? null) !== (y?.getTime() ?? null)) {
        changes[key] = { from: x && new Date(x), to: y && new Date(y) };
      }
    }
    if (old.remainingDuration !== t.remainingDuration) {
      changes.remainingDuration = { from: old.remainingDuration, to: t.remainingDuration };
    }
    if (old.physicalProgress !== t.physicalProgress) {
      changes.physicalProgress = { from: old.physicalProgress, to: t.physicalProgress };
    }
    if (scheduled) {
      const tf0 = old.computed?.totalSlack;
      const tf1 = t.computed?.totalSlack;
      if (tf0 !== undefined && tf1 !== undefined && tf0 !== tf1) {
        changes.totalFloat = { from: tf0, to: tf1, delta: tf1 - tf0 };
      }
      const c0 = old.computed?.isCritical ?? false;
      const c1 = t.computed?.isCritical ?? false;
      if (!isSummary && c0 !== c1) {
        changes.critical = { from: c0, to: c1 };
        if (c1) summary.becameCritical++;
        else if (st1 !== 'complete') summary.noLongerCritical++; // finishing isn't de-risking
      }
    }
    if (!sameConstraint(old.constraint, t.constraint)) {
      changes.constraint = { from: old.constraint, to: t.constraint };
    }
    if (String(old.parent ?? '') !== String(t.parent ?? '')) {
      changes.parent = { from: old.parent, to: t.parent };
    }
    if (Object.keys(changes).length === 0) continue;
    tasks.push({ id: t.id, text: t.text, kind: 'changed', isSummary, changes });
    if (isSummary) continue;
    if (changes.start || changes.finish) summary.moved++;
    if (changes.duration) summary.durationChanged++;
  }
  for (const t of b.tasks) {
    if (afterIds.has(String(t.id))) continue;
    const isSummary = t.type === 'summary';
    tasks.push({ id: t.id, text: t.text, kind: 'removed', isSummary });
    if (!isSummary) summary.removed++;
  }

  const links = compareLinks(b.links, a.links);
  summary.logicChanged = links.length;
  return { tasks, links, summary };
}

/**
 * Links matched by predecessor → successor. Several links between the same
 * pair are matched by type (one of each type is the norm), so a removed
 * duplicate isn't lost or misreported as a change.
 */
function compareLinks(beforeLinks: Link[], afterLinks: Link[]): LinkComparison[] {
  const pair = (l: Link) => `${String(l.source)}\u0000${String(l.target)}`;
  const group = (ls: Link[]) => {
    const m = new Map<string, Link[]>();
    for (const l of ls) {
      const list = m.get(pair(l));
      if (list) list.push(l);
      else m.set(pair(l), [l]);
    }
    return m;
  };
  const before = group(beforeLinks);
  const afterCount = new Map([...group(afterLinks)].map(([k, v]) => [k, v.length]));
  const consumed = new Set<Link>();
  const out: LinkComparison[] = [];
  const lagOf = (l: Link) => l.lag ?? 0;
  for (const l of afterLinks) {
    const key = pair(l);
    const candidates = (before.get(key) ?? []).filter((x) => !consumed.has(x));
    const single = candidates.length === 1 && afterCount.get(key) === 1;
    const old = single ? candidates[0] : candidates.find((x) => x.type === l.type);
    if (!old) {
      out.push({ source: l.source, target: l.target, kind: 'added', type: l.type });
      continue;
    }
    consumed.add(old);
    const changes: NonNullable<LinkComparison['changes']> = {};
    if (old.type !== l.type) changes.type = { from: old.type, to: l.type };
    if (lagOf(old) !== lagOf(l)) changes.lag = { from: lagOf(old), to: lagOf(l) };
    if (old.lagPercent !== l.lagPercent) {
      changes.lagPercent = { from: old.lagPercent, to: l.lagPercent };
    }
    if (!!old.lagElapsed !== !!l.lagElapsed) {
      changes.lagElapsed = { from: !!old.lagElapsed, to: !!l.lagElapsed };
    }
    if (Object.keys(changes).length > 0) {
      out.push({ source: l.source, target: l.target, kind: 'changed', changes });
    }
  }
  for (const l of beforeLinks) {
    if (!consumed.has(l))
      out.push({ source: l.source, target: l.target, kind: 'removed', type: l.type });
  }
  return out;
}

function ensureScheduled(p: Project, force?: boolean): Project {
  const needs =
    force === true || p.tasks.some((t) => t.type !== 'summary' && !t.unscheduled && !t.computed);
  return needs ? schedule(p) : p;
}

/** ASAP and "no constraint" are the same thing (MSPDI drops ASAP on parse). */
function sameConstraint(x: Constraint | undefined, y: Constraint | undefined): boolean {
  const tx = x?.type ?? 'ASAP';
  const ty = y?.type ?? 'ASAP';
  if (tx !== ty) return false;
  return (x?.date?.getTime() ?? null) === (y?.date?.getTime() ?? null);
}

function projectFinishDelta(
  b: Project,
  a: Project,
  count: (from: Date, to: Date) => number,
): Delta<Date | undefined> {
  const latest = (p: Project) => {
    let max: Date | undefined;
    for (const t of p.tasks) {
      if (t.type === 'summary' || t.unscheduled) continue;
      const f = t.computed?.earlyFinish ?? t.end;
      if (!max || f > max) max = f;
    }
    return max;
  };
  const from = latest(b);
  const to = latest(a);
  return {
    from: from && new Date(from),
    to: to && new Date(to),
    delta: from && to ? count(from, to) || 0 : 0,
  };
}

/**
 * `before` as a baseline, to draw a schedule comparison with the existing
 * baseline rendering: add it to `after.baselines` and show it with
 * `baselineIndices` — `before` becomes ghost bars, and the variance pills are
 * the revision's slip / gain (MS Project "Compare Project Versions").
 *
 * Snapshots `before`'s forecast (its early dates; scheduled when `computed` is
 * missing, as `compareSchedules` does — so it throws where `schedule()` would),
 * or with `dates: 'planned'` its own `start` / `end` as given (it won't derive
 * an end from `duration`: for manually dated inputs). Unscheduled tasks are
 * left out. Pure; dates are copies. `index` is the consumer's choice of one of
 * the 11 baseline slots; pass the revision's date as `capturedAt` (the ghost
 * label reads "captured <date>"; default: now).
 *
 * Baseline variance counts working time in the project's default calendar;
 * `compareSchedules` counts each task in its own. They agree for tasks on the
 * default calendar.
 */
export function baselineFrom(
  before: Project,
  index: BaselineIndex,
  options: { name?: string; capturedAt?: Date; dates?: 'scheduled' | 'planned' } = {},
): Baseline {
  const source = options.dates === 'planned' ? before : ensureScheduled(before);
  const tasks = new Map<TaskId, BaselineTaskSnapshot>();
  for (const task of source.tasks) {
    if (task.unscheduled) continue;
    tasks.set(task.id, {
      start: new Date(task.start),
      end: new Date(task.end),
      duration: task.duration,
    });
  }
  return {
    index,
    name: options.name,
    capturedAt: new Date(options.capturedAt ?? Date.now()),
    tasks,
  };
}
