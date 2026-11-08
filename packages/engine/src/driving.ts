// Driving path, longest path and float paths (parity row 5) — the planner's
// "why does this start then?" (MS Project Task Path) and P6's Longest Path /
// multiple float paths. Spec: docs/superpowers/specs/2026-10-16-driving-path-design.md
//
// Pure: schedules the project when `computed` is missing. Summaries and
// unscheduled tasks are left out of every path, as are links touching them.

import { createCalendarResolver } from './calendars/effective';
import { earliestStartFromLink, progressState, remainingMinutes, schedule } from './schedule';
import type { Link, LinkId, Project, Task, TaskId } from './types';
import { snapToNextWorkingMoment, workingMinutesBetween } from './working-time';

/**
 * Note: link driving is measured in the SUCCESSOR's calendar, free slack in
 * the predecessor's (ADR-011) — a link can drive while its predecessor still
 * has free slack (a 24 h predecessor finishing Saturday into a Mon–Fri task).
 */
export interface LinkDriving {
  /**
   * The link alone sets the successor's early start (relationship free float
   * ≤ 0). With a status date: into an in-progress successor it's measured to
   * its remaining start; a complete successor (or an in-progress one under
   * progress override) is never driven (float reported as 0).
   */
  driving: boolean;
  /**
   * Working minutes, in the successor's calendar, between the start this link
   * allows and the successor's early start. Negative when a manual task starts
   * before its logic allows.
   */
  relationshipFreeFloat: number;
}

export interface TaskPath {
  /** Tasks on the path, ordered by early start (then project order). */
  taskIds: TaskId[];
  /** Driving links between them, ordered by successor then predecessor early start. */
  linkIds: LinkId[];
}

export interface FloatPath {
  /** 1 = most critical. */
  path: number;
  taskIds: TaskId[];
}

/**
 * One driving analysis of a project, answering every query without re-running
 * it — use this when asking for many tasks (a UI highlighting each one).
 */
export interface DrivingAnalysis {
  /** Relationship free float + driving flag per link between scheduled leaf tasks. */
  links: Map<LinkId, LinkDriving>;
  /** Every task and link that drives `taskId`, including the task. Empty for an unknown / summary / unscheduled id. */
  drivingPath(taskId: TaskId): TaskPath;
  /** Every task and link `taskId` drives (MSP Task Path "driven successors"), including the task. */
  drivenPath(taskId: TaskId): TaskPath;
  /** P6 Longest Path: the driving chain(s) back from the latest early finish. */
  longestPath(): TaskPath;
  /** Ranked float paths; path 1 is the most critical. */
  floatPaths(options?: { endTaskId?: TaskId; maxPaths?: number }): FloatPath[];
}

interface Analysis {
  leaves: Map<string, Task>;
  links: Link[];
  driving: Map<LinkId, LinkDriving>;
  drivingInto: Map<string, Link[]>;
  drivingOutOf: Map<string, Link[]>;
}

/** Analyse once; query many times. Pure; schedules the project when `computed` is missing. */
export function analyseDriving(project: Project): DrivingAnalysis {
  const a = analyse(project);
  return {
    links: a.driving,
    drivingPath: (taskId) => drivingPath(a, [String(taskId)], () => true),
    drivenPath: (taskId) => drivingPath(a, [String(taskId)], () => true, 'driven'),
    longestPath: () => drivingPath(a, latestFinishers(a), () => true),
    floatPaths: (options) => floatPaths(a, options),
  };
}

function analyse(project: Project): Analysis {
  const isLeaf = (t: Task) => t.type !== 'summary' && !t.unscheduled;
  const p = project.tasks.some((t) => isLeaf(t) && !t.computed) ? schedule(project) : project;
  const leaves = new Map(p.tasks.filter(isLeaf).map((t) => [String(t.id), t]));
  const links = p.links.filter((l) => leaves.has(String(l.source)) && leaves.has(String(l.target)));
  const resolver = createCalendarResolver(p);
  const driving = new Map<LinkId, LinkDriving>();
  const drivingInto = new Map<string, Link[]>();
  const drivingOutOf = new Map<string, Link[]>();
  for (const l of links) {
    const source = leaves.get(String(l.source)) as Task;
    const target = leaves.get(String(l.target)) as Task;
    if (!source.computed || !target.computed) continue;
    const eff = resolver.effectiveFor(target);
    const cal = eff.calendar;
    // Status date set (parity row 6): only auto leaves are re-forecast. A
    // finished successor, or one under way with logic overridden, isn't
    // driven by anything; one under way with retained logic is driven via
    // its REMAINING work, measured to its remaining start.
    const state =
      p.statusDate && target.scheduleMode !== 'manual' ? progressState(target) : 'not-started';
    if (
      state === 'complete' ||
      (state === 'in-progress' && p.progressMode === 'progress-override')
    ) {
      driving.set(l.id, { driving: false, relationshipFreeFloat: 0 });
      continue;
    }
    const inProgress = state === 'in-progress';
    const targetForLink = inProgress
      ? {
          ...target,
          duration: remainingMinutes(target, { statusDate: p.statusDate, calendar: cal }),
        }
      : target;
    const targetStart =
      (inProgress && target.computed.remainingStart) || target.computed.earlyStart;
    const allowed = snapToNextWorkingMoment(
      earliestStartFromLink(l, source, targetForLink, source.computed, cal, eff.lagCalendar ?? cal),
      cal,
    );
    // `|| 0`: workingMinutesBetween can return -0.
    const relationshipFreeFloat = workingMinutesBetween(allowed, targetStart, cal) || 0;
    const isDriving = relationshipFreeFloat <= 0;
    driving.set(l.id, { driving: isDriving, relationshipFreeFloat });
    if (isDriving) {
      const into = drivingInto.get(String(l.target));
      if (into) into.push(l);
      else drivingInto.set(String(l.target), [l]);
      const outOf = drivingOutOf.get(String(l.source));
      if (outOf) outOf.push(l);
      else drivingOutOf.set(String(l.source), [l]);
    }
  }
  return { leaves, links, driving, drivingInto, drivingOutOf };
}

/** Relationship free float and the driving flag for every link between scheduled leaf tasks. */
export function getLinkDriving(project: Project): Map<LinkId, LinkDriving> {
  return analyse(project).driving;
}

/**
 * Every task and link that drives `taskId` (its driving predecessors,
 * recursively), including the task. For many tasks, use `analyseDriving`.
 */
export function getDrivingPath(project: Project, taskId: TaskId): TaskPath {
  return analyseDriving(project).drivingPath(taskId);
}

/**
 * Every task and link that `taskId` drives (its driven successors,
 * recursively), including the task — MS Project's Task Path "Driven
 * Successors". For many tasks, use `analyseDriving`.
 */
export function getDrivenPath(project: Project, taskId: TaskId): TaskPath {
  return analyseDriving(project).drivenPath(taskId);
}

/**
 * P6 Longest Path: the driving chain(s) back from the latest early finish
 * among tasks that have logic — so a constrained end milestone with no
 * predecessors (a dangling Practical Completion) can't hijack it. Pass the end
 * explicitly via `getFloatPaths({ endTaskId })` if that milestone is the end.
 */
export function getLongestPath(project: Project): TaskPath {
  return analyseDriving(project).longestPath();
}

/**
 * Multiple float paths. Path 1 is the driving path to `endTaskId` (default:
 * one latest finisher — lowest total float, then project order). Each next
 * path starts from the unassigned task with the lowest total float (ties:
 * later early finish) among predecessors of assigned tasks and the other
 * latest finishers, and follows its driving path through unassigned tasks.
 * Driving path first, then lowest total float — close to, not identical with,
 * P6's total-float mode (which can put a low-float non-driver on path 1).
 */
export function getFloatPaths(
  project: Project,
  options: { endTaskId?: TaskId; maxPaths?: number } = {},
): FloatPath[] {
  return analyseDriving(project).floatPaths(options);
}

function floatPaths(
  a: Analysis,
  options: { endTaskId?: TaskId; maxPaths?: number } = {},
): FloatPath[] {
  const maxPaths = options.maxPaths ?? 10;
  const out: FloatPath[] = [];
  if (maxPaths <= 0) return out;
  const assigned = new Set<string>();
  const unassigned = (id: string) => !assigned.has(id);
  const finishers = latestFinishers(a);
  const byFloat = (x: Task, y: Task) =>
    (x.computed?.totalSlack ?? 0) - (y.computed?.totalSlack ?? 0) ||
    (y.computed?.earlyFinish.getTime() ?? 0) - (x.computed?.earlyFinish.getTime() ?? 0);
  const order = new Map([...a.leaves.keys()].map((id, i) => [id, i]));
  const pick = (ids: Iterable<string>) =>
    [...ids]
      .map((id) => a.leaves.get(id) as Task)
      .sort(
        (x, y) => byFloat(x, y) || (order.get(String(x.id)) ?? 0) - (order.get(String(y.id)) ?? 0),
      )[0];
  const take = (from: string) => {
    const path = drivingPath(a, [from], unassigned);
    if (path.taskIds.length === 0) return false;
    for (const id of path.taskIds) assigned.add(String(id));
    out.push({ path: out.length + 1, taskIds: path.taskIds });
    return true;
  };
  const first = options.endTaskId !== undefined ? String(options.endTaskId) : pick(finishers)?.id;
  if (first === undefined || !take(String(first))) return out;
  while (out.length < maxPaths) {
    const candidates = new Set<string>(finishers.filter(unassigned));
    for (const l of a.links) {
      if (assigned.has(String(l.target)) && unassigned(String(l.source))) {
        candidates.add(String(l.source));
      }
    }
    const next = candidates.size > 0 ? pick(candidates) : undefined;
    if (!next || !take(String(next.id))) break;
  }
  return out;
}

/**
 * Leaf tasks at the latest early finish, among tasks with at least one
 * incoming link (logic); all leaves if none has logic.
 */
function latestFinishers(a: Analysis): string[] {
  const withLogic = new Set(a.links.map((l) => String(l.target)));
  const pool = [...a.leaves.values()].filter((t) => withLogic.has(String(t.id)));
  const candidates = pool.length > 0 ? pool : [...a.leaves.values()];
  let latest = Number.NEGATIVE_INFINITY;
  for (const t of candidates) {
    latest = Math.max(latest, t.computed?.earlyFinish.getTime() ?? Number.NEGATIVE_INFINITY);
  }
  return candidates
    .filter((t) => t.computed?.earlyFinish.getTime() === latest)
    .map((t) => String(t.id));
}

/** Walk driving links (through tasks `allow` admits) back to the drivers (`'driving'`) or forward to the driven. */
function drivingPath(
  a: Analysis,
  from: string[],
  allow: (id: string) => boolean,
  direction: 'driving' | 'driven' = 'driving',
): TaskPath {
  const tasks = new Set<string>();
  const links: Link[] = [];
  const queue = from.filter((id) => a.leaves.has(id) && allow(id));
  for (const id of queue) tasks.add(id);
  const step = direction === 'driving' ? a.drivingInto : a.drivingOutOf;
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const l of step.get(id) ?? []) {
      const next = String(direction === 'driving' ? l.source : l.target);
      if (!allow(next)) continue;
      links.push(l);
      if (!tasks.has(next)) {
        tasks.add(next);
        queue.push(next);
      }
    }
  }
  const order = new Map([...a.leaves.keys()].map((id, i) => [id, i]));
  const es = (id: string) => a.leaves.get(id)?.computed?.earlyStart.getTime() ?? 0;
  const byStart = (x: string, y: string) =>
    es(x) - es(y) || (order.get(x) ?? 0) - (order.get(y) ?? 0);
  const taskIds = [...tasks].sort(byStart).map((id) => (a.leaves.get(id) as Task).id);
  links.sort(
    (x, y) =>
      byStart(String(x.target), String(y.target)) || byStart(String(x.source), String(y.source)),
  );
  return { taskIds, linkIds: links.map((l) => l.id) };
}
