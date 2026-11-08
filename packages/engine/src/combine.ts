// Parity row 24: several jobs as one programme (MS Project master project).
// Spec: docs/superpowers/specs/2026-10-16-multi-project-master-design.md
//
// No scheduler change: the parts are namespaced into one ordinary Project, so
// `schedule()` gives float and the critical path across jobs, and every other
// analysis (driving paths, Task Path, quality checks) works on it unchanged.

import { getCriticalPath } from './analysis.js';
import { createCalendarResolver } from './calendars/effective.js';
import { progressState } from './schedule.js';
import type {
  Baseline,
  BaselineIndex,
  CalendarId,
  CodeType,
  DependencyType,
  Link,
  LinkId,
  Project,
  Task,
  TaskId,
} from './types.js';
import { snapToNextWorkingMoment } from './working-time.js';

/** One job in the programme. `key` namespaces its ids, so it must be unique. */
export interface CombinePart {
  key: string;
  /** Summary-row text; defaults to `key`. */
  name?: string;
  project: Project;
}

/** A link between tasks in different parts (or the same part). */
export interface CrossProjectLink {
  id: LinkId;
  from: { key: string; id: TaskId };
  to: { key: string; id: TaskId };
  type: DependencyType;
  lag: number;
  lagPercent?: number;
  lagElapsed?: boolean;
}

export interface CombineOptions {
  /** The programme's one data date. Default: the parts' (which must agree). */
  statusDate?: Date;
  /** Cross-project links; each becomes an ordinary link with id `x:${id}`. */
  links?: CrossProjectLink[];
}

/**
 * A constraint `combineProjects` injected or raised so a part starts no
 * earlier than its own start. It isn't the PM's: strip it before persisting an
 * edited task back to its job.
 */
export interface CombineNote {
  key: string;
  id: TaskId;
  kind: 'start-floor';
}

export interface CombinedProject {
  project: Project;
  /** The part and part-local id behind a combined id; `undefined` for summary rows, cross links and unknown ids. */
  locate(id: TaskId | LinkId | CalendarId): { key: string; id: TaskId } | undefined;
  /** The combined id of a part-local id. */
  idOf(key: string, id: TaskId | LinkId | CalendarId): string;
  /**
   * A combined task back in its own job, ready to persist there: ids
   * un-namespaced, `computed` dropped, and a start floor replaced by the task's
   * original constraint, unless the host has set a different one since.
   * `undefined` for summary rows and tasks the combine didn't create. Throws if
   * the task now sits under another job.
   *
   * Pass the task back with its constraint as you got it. The floor is
   * recognised by its exact date, so a date rewritten (e.g. by a date-only
   * picker) is kept as the host's. An SNET set to exactly the floor date, or the
   * part default set on a task whose own calendar the part didn't define, reads
   * as untouched.
   */
  toPart(task: Task): { key: string; task: Task } | undefined;
  /** Start floors added to later parts, in task order. Persist through {@link CombinedProject.toPart}, which removes them. */
  notes: CombineNote[];
  /** The parts' keys, summary-row text and own finish anchors (`Project.end`), in order. */
  parts: { key: string; name: string; end?: Date }[];
}

// Dateless (ASAP, ALAP) or an SNET the floor may raise. Other constraints are the PM's.
const FLOORED_CONSTRAINT = new Set([undefined, 'ASAP', 'ALAP', 'SNET']);

/**
 * Combine several jobs into one programme for a single `<Gantt>`.
 *
 * - Every task, link, calendar, resource, assignment and baseline snapshot id
 *   becomes `${key}/${id}`.
 * - Each part becomes a summary row (id `key`) over its top-level tasks.
 * - Tasks without a calendar, or with one their part doesn't define, keep
 *   their part's default calendar.
 * - The programme starts at the earliest part start. A part that starts later
 *   floors its auto-scheduled leaf tasks at its own start (snapped into each
 *   task's calendar, as `schedule()` does): an injected SNET, or an earlier SNET
 *   raised to it. Under a status date, only not-started tasks are floored.
 *   These are listed in `notes`; strip them before persisting. Other
 *   constraints are the PM's, and are left alone.
 * - One data date applies to the whole programme: `options.statusDate`, or the
 *   parts' own, which must agree. A part without one is scheduled against it.
 *   `progressMode` and `rescheduleAfterStatusDate` are the first part's that
 *   sets them, so set them on the first part (or every part) to choose.
 * - A part's `end` anchor doesn't bound the programme. It is passed through
 *   on `parts`, and {@link analyseCombined} reports it beside the part's finish.
 *
 * Schedule the result with `schedule()`, then read the programme view with
 * {@link analyseCombined}.
 */
export function combineProjects(
  parts: CombinePart[],
  options: CombineOptions = {},
): CombinedProject {
  const first = parts[0];
  if (!first) throw new Error('combineProjects: needs at least one part');
  const keys = new Set<string>();
  for (const { key } of parts) {
    if (!key || /[/:]/.test(key)) {
      throw new Error(
        `combineProjects: part key "${key}" must be non-empty and contain no "/" or ":"`,
      );
    }
    if (keys.has(key)) throw new Error(`combineProjects: duplicate part key "${key}"`);
    keys.add(key);
  }

  const idOf = (key: string, id: TaskId | LinkId | CalendarId) => `${key}/${id}`;
  const located = new Map<string, { key: string; id: TaskId }>();
  // Combined task id → its part's original task, and the floor it was given.
  const originals = new Map<string, { key: string; task: Task; calendar: string; floor?: Date }>();
  const remember = (key: string, id: TaskId | LinkId | CalendarId) => {
    const combined = idOf(key, id);
    if (!located.has(combined)) located.set(combined, { key, id });
    return combined;
  };

  const starts = parts.map((p) => p.project.start.getTime());
  const start = new Date(Math.min(...starts));
  const statusDate = options.statusDate ?? agreedStatusDate(parts);
  const progressMode = parts.map((p) => p.project.progressMode).find((m) => m !== undefined);
  const reschedule = parts
    .map((p) => p.project.rescheduleAfterStatusDate)
    .find((r) => r !== undefined);

  const tasks: Task[] = [];
  const links: Link[] = [];
  const notes: CombineNote[] = [];
  const project: Project = {
    start,
    defaultCalendarId: idOf(first.key, first.project.defaultCalendarId),
    tasks,
    links,
    resources: [],
    calendars: [],
    baselines: [],
    assignments: [],
    ...(statusDate ? { statusDate } : {}),
    ...(progressMode ? { progressMode } : {}),
    ...(reschedule !== undefined ? { rescheduleAfterStatusDate: reschedule } : {}),
  };

  for (const { key, name, project: p } of parts) {
    const floored = p.start.getTime() > start.getTime();
    const resolver = floored ? createCalendarResolver(p) : undefined;
    const calendarIds = new Set(p.calendars.map((c) => String(c.id)));
    tasks.push({
      id: key,
      text: name ?? key,
      type: 'summary',
      scheduleMode: 'auto',
      duration: 0,
      start: new Date(p.start),
      end: new Date(p.start),
      progress: 0,
      open: true,
    });
    for (const task of p.tasks) {
      const { computed: _computed, ...rest } = task;
      const id = idOf(key, task.id);
      if (located.has(id)) throw new Error(`combineProjects: two tasks become "${id}"`);
      const ownCalendar =
        task.calendarId !== undefined && calendarIds.has(String(task.calendarId))
          ? task.calendarId
          : p.defaultCalendarId;
      const next: Task = {
        ...rest,
        id: remember(key, task.id),
        // remember(), not idOf(): a parent or resource the job doesn't define is still job-local.
        parent: task.parent == null ? key : remember(key, task.parent),
        calendarId: idOf(key, ownCalendar),
      };
      if (task.resourceIds) next.resourceIds = task.resourceIds.map((r) => remember(key, r));
      const floor = resolver && floorFor(task, p, resolver, statusDate);
      if (floor) {
        next.constraint = { type: 'SNET', date: floor };
        originals.set(id, { key, task, calendar: String(next.calendarId), floor });
        notes.push({ key, id: task.id, kind: 'start-floor' });
      }
      if (!originals.has(id)) originals.set(id, { key, task, calendar: String(next.calendarId) });
      tasks.push(next);
    }
    for (const l of p.links) {
      links.push({
        ...l,
        id: remember(key, l.id),
        source: idOf(key, l.source),
        target: idOf(key, l.target),
      });
    }
    for (const c of p.calendars) {
      project.calendars.push({
        ...c,
        id: remember(key, c.id),
        ...(c.baseCalendarId !== undefined ? { baseCalendarId: idOf(key, c.baseCalendarId) } : {}),
      });
    }
    for (const r of p.resources) {
      const resource = { ...r, id: remember(key, r.id) };
      if (r.calendarId !== undefined) resource.calendarId = idOf(key, r.calendarId);
      project.resources.push(resource);
    }
    for (const a of p.assignments) {
      project.assignments.push({
        ...a,
        id: remember(key, a.id),
        taskId: idOf(key, a.taskId),
        resourceId: idOf(key, a.resourceId),
      });
    }
  }

  project.baselines = combineBaselines(parts, idOf);
  const codeTypes = combineCodeTypes(parts);
  if (codeTypes) project.codeTypes = codeTypes;

  const taskIds = new Set(tasks.map((x) => String(x.id)));
  for (const x of options.links ?? []) {
    const source = idOf(x.from.key, x.from.id);
    const target = idOf(x.to.key, x.to.id);
    for (const end of [source, target]) {
      if (!taskIds.has(end))
        throw new Error(`combineProjects: cross link "${x.id}" names unknown task "${end}"`);
    }
    const l: Link = { id: `x:${x.id}`, source, target, type: x.type, lag: x.lag };
    if (x.lagPercent !== undefined) l.lagPercent = x.lagPercent;
    if (x.lagElapsed !== undefined) l.lagElapsed = x.lagElapsed;
    links.push(l);
  }

  return {
    project,
    locate: (id) => located.get(String(id)),
    toPart: (task) => toPart(task, originals, located),
    idOf,
    notes,
    parts: parts.map(({ key, name, project: p }) => ({
      key,
      name: name ?? key,
      ...(p.end ? { end: new Date(p.end) } : {}),
    })),
  };
}

function toPart(
  task: Task,
  originals: Map<string, { key: string; task: Task; calendar: string; floor?: Date }>,
  located: Map<string, { key: string; id: TaskId }>,
): { key: string; task: Task } | undefined {
  const origin = originals.get(String(task.id));
  if (!origin) return undefined;
  const { key, task: original, calendar, floor } = origin;
  const local = (id: TaskId | CalendarId, what: string): TaskId => {
    const at = located.get(String(id));
    if (!at || at.key !== key) {
      throw new Error(
        `combineProjects.toPart: ${what} "${id}" of "${task.id}" is not in job "${key}"`,
      );
    }
    return at.id;
  };
  const { computed: _computed, ...rest } = task;
  const back: Task = { ...rest, id: original.id };
  if (task.parent == null || String(task.parent) === key) delete back.parent;
  else back.parent = local(task.parent, 'parent');
  // Still the calendar the combine assigned: give back the original (none, or
  // an id the part didn't define). A calendar the host chose since is its own.
  if (task.calendarId === undefined) delete back.calendarId;
  else if (String(task.calendarId) === calendar) {
    if (original.calendarId === undefined) delete back.calendarId;
    else back.calendarId = original.calendarId;
  } else back.calendarId = local(task.calendarId, 'calendar');
  if (task.resourceIds) back.resourceIds = task.resourceIds.map((r) => local(r, 'resource'));
  const c = task.constraint;
  const stillFloor = floor && c?.type === 'SNET' && c.date?.getTime() === floor.getTime();
  if (stillFloor) {
    if (original.constraint) back.constraint = original.constraint;
    else delete back.constraint;
  }
  return { key, task: back };
}

/** The SNET date that floors `task` at its part's start, or undefined if it needs none. */
function floorFor(
  task: Task,
  part: Project,
  resolver: ReturnType<typeof createCalendarResolver>,
  statusDate: Date | undefined,
): Date | undefined {
  if (task.type === 'summary' || task.scheduleMode !== 'auto' || task.unscheduled) return undefined;
  if (!FLOORED_CONSTRAINT.has(task.constraint?.type)) return undefined;
  // Under a status date, started work is placed by its actuals, not the floor.
  if (statusDate && progressState(task) !== 'not-started') return undefined;
  let floor: Date;
  try {
    // A milestone takes the start as it is, as schedule() does (MS Project).
    floor =
      task.duration <= 0
        ? new Date(part.start)
        : snapToNextWorkingMoment(part.start, resolver.effectiveFor(task).calendar);
  } catch {
    floor = new Date(part.start); // a calendar with no working time: schedule() reports it
  }
  const own = task.constraint?.type === 'SNET' ? task.constraint.date : undefined;
  return own && own.getTime() >= floor.getTime() ? undefined : floor;
}

function agreedStatusDate(parts: CombinePart[]): Date | undefined {
  let agreed: Date | undefined;
  for (const { key, project } of parts) {
    const d = project.statusDate;
    if (!d) continue;
    if (agreed && agreed.getTime() !== d.getTime()) {
      throw new Error(
        `combineProjects: part "${key}" has a different status date; pass options.statusDate to set one for the programme`,
      );
    }
    agreed = d;
  }
  return agreed;
}

function combineBaselines(
  parts: CombinePart[],
  idOf: (key: string, id: TaskId) => string,
): Baseline[] {
  const byIndex = new Map<BaselineIndex, Baseline>();
  for (const { key, project } of parts) {
    for (const b of project.baselines) {
      let into = byIndex.get(b.index);
      if (!into) {
        into = { ...b, tasks: new Map() };
        byIndex.set(b.index, into);
      }
      for (const [id, snap] of b.tasks) into.tasks.set(idOf(key, id), snap);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function combineCodeTypes(parts: CombinePart[]): CodeType[] | undefined {
  const byId = new Map<string, CodeType>();
  for (const { project } of parts) {
    for (const ct of project.codeTypes ?? []) {
      const into = byId.get(ct.id);
      if (!into) {
        byId.set(ct.id, { ...ct, values: [...ct.values] });
        continue;
      }
      const seen = new Set(into.values.map((v) => v.value));
      for (const v of ct.values) if (!seen.has(v.value)) into.values.push(v);
    }
  }
  return byId.size > 0 ? [...byId.values()] : undefined;
}

/** One job's place in the programme. */
export interface CombinedPartAnalysis {
  key: string;
  name: string;
  /** Earliest leaf start; absent if the part has no scheduled leaf tasks. */
  start?: Date;
  /** Latest leaf finish. */
  finish?: Date;
  /** The part's own finish anchor (`Project.end`), if it had one: compare with `finish`. */
  end?: Date;
  /** The part's float against the programme finish: the least total slack of its unfinished leaf tasks (minutes). */
  totalSlack?: number;
  /** True when one of its tasks is critical (on the programme's critical path, or pinned with no float). */
  driving: boolean;
}

export interface CombinedAnalysis {
  /** Latest leaf finish across all parts. */
  finish?: Date;
  /** Critical leaf tasks across jobs, by early start, each located to its part. */
  criticalPath: { key: string; id: TaskId; task: Task }[];
  parts: CombinedPartAnalysis[];
}

/**
 * The programme view of a scheduled combined project: the critical path across
 * jobs, and each job's dates, float and whether it is critical.
 */
export function analyseCombined(scheduled: Project, combined: CombinedProject): CombinedAnalysis {
  const leavesByPart = new Map<string, Task[]>(combined.parts.map((p) => [p.key, []]));
  let finish: number | undefined;
  for (const task of scheduled.tasks) {
    if (task.type === 'summary' || task.unscheduled) continue;
    const at = combined.locate(task.id);
    if (!at) continue;
    leavesByPart.get(at.key)?.push(task);
    finish = Math.max(finish ?? -Infinity, task.end.getTime());
  }
  const criticalPath = getCriticalPath(scheduled).flatMap((task) => {
    const at = combined.locate(task.id);
    return at ? [{ ...at, task }] : [];
  });
  return {
    ...(finish !== undefined ? { finish: new Date(finish) } : {}),
    criticalPath,
    parts: combined.parts.map(({ key, name, end }) => {
      const anchor = end ? { end } : {};
      const leaves = leavesByPart.get(key) ?? [];
      if (leaves.length === 0) return { key, name, ...anchor, driving: false };
      // Complete work has no float left to report (schedule() pins it at 0).
      const slacks = leaves
        .filter((x) => x.computed?.status !== 'complete')
        .map((x) => x.computed?.totalSlack)
        .filter((s): s is number => s !== undefined);
      return {
        key,
        name,
        ...anchor,
        start: new Date(Math.min(...leaves.map((x) => x.start.getTime()))),
        finish: new Date(Math.max(...leaves.map((x) => x.end.getTime()))),
        ...(slacks.length > 0 ? { totalSlack: Math.min(...slacks) } : {}),
        driving: leaves.some((x) => x.computed?.isCritical === true),
      };
    }),
  };
}
