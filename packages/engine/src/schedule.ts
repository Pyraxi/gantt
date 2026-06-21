// Forward + backward pass + critical path + constraint resolution.
//
// Algorithm:
// 1. Kahn-ordered topological sort over the link graph.
// 2. Forward pass: compute earlyStart/earlyFinish per task. After
//    predecessor-based candidates, apply forward-direction constraints
//    (ASAP/MSO/MFO/SNET/FNET).
// 3. Backward pass: compute lateStart/lateFinish per task working right to
//    left. After successor-based candidates, apply backward-direction
//    constraints (MSO/MFO/SNLT/FNLT). MSO/MFO are hard pins — they lock
//    both early and late dates to the constraint, so predecessors that
//    can't deliver in time get negative slack on themselves.
// 4. Slack: totalSlack = workingMinutesBetween(earlyStart, lateStart) in
//    working time. freeSlack = min working gap to earliest successor's
//    required start. isCritical = totalSlack <= 0.
//
// Per ADR-003, negative slack is preserved, not clipped to zero. A task
// with negative slack is already late against a downstream constraint;
// surfacing that is the differentiator vs every existing alternative.
//
// ALAP semantics (consume slack to push the task to its latest position)
// are deferred — full ALAP requires a second forward pass after the
// backward pass to re-flow downstream dates. For now ALAP is parsed but
// behaves like ASAP.

import { topologicalSort } from './topological-sort';
import type { Calendar, Link, Project, Task, TaskComputed, TaskId } from './types';
import {
  addWorkingMinutes,
  snapToNextWorkingMoment,
  snapToPreviousWorkingMoment,
  subtractWorkingMinutes,
  workingMinutesBetween,
} from './working-time';

interface ForwardDates {
  earlyStart: Date;
  earlyFinish: Date;
}

interface BackwardDates {
  lateStart: Date;
  lateFinish: Date;
}

export function schedule(project: Project): Project {
  const calendar = getDefaultCalendar(project);
  const sorted = topologicalSort(project.tasks, project.links);
  const taskById = new Map<TaskId, Task>(sorted.map((t) => [t.id, t]));
  const childrenByParent = groupChildrenByParent(project.tasks);
  const summariesByDepthDesc = summariesDeepestFirst(project.tasks);

  // Unscheduled tasks (ADR-007) are excluded from the pass entirely: no
  // computed, no cascade. They pass through to the output untouched.
  const isScheduled = (taskId: TaskId): boolean => !taskById.get(taskId)?.unscheduled;

  // Forward pass — leaves first, summaries bottom-up after.
  const forwardById = new Map<TaskId, ForwardDates>();
  const projectFloor = snapToNextWorkingMoment(project.start, calendar);

  for (const task of sorted) {
    if (task.type === 'summary') continue; // aggregated below
    if (task.unscheduled) continue; // ADR-007: no pass for unscheduled tasks

    if (task.scheduleMode === 'manual') {
      // Manual: user-set dates are authoritative. Skip predecessor logic and
      // constraint application — MS Project semantics. We still populate
      // forwardById so the backward pass can compute slack against the
      // network the user has drawn.
      //
      // Split tasks (ADR-007): outer bounds come from the segment list; the
      // engine treats the segments as fixed working spans with non-working
      // gaps. segments[] is authoritative over task.start/end when present.
      const segs = task.segments;
      if (segs && segs.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by segs.length > 0
        const firstSeg = segs[0]!;
        // biome-ignore lint/style/noNonNullAssertion: guarded by segs.length > 0
        const lastSeg = segs[segs.length - 1]!;
        forwardById.set(task.id, {
          earlyStart: new Date(firstSeg.start),
          earlyFinish: new Date(lastSeg.end),
        });
      } else {
        forwardById.set(task.id, {
          earlyStart: new Date(task.start),
          earlyFinish: new Date(task.end),
        });
      }
      continue;
    }

    let earliest = projectFloor;
    for (const link of incomingLinks(task.id, project.links)) {
      if (!isScheduled(link.source)) continue; // ADR-007: inert link from unscheduled
      const source = taskById.get(link.source);
      const sourceFwd = forwardById.get(link.source);
      if (!source || !sourceFwd) continue;
      const fromLink = earliestStartFromLink(link, source, task, sourceFwd, calendar);
      if (fromLink > earliest) earliest = fromLink;
    }
    forwardById.set(task.id, applyForwardConstraint(task, earliest, calendar));
  }

  // Summary forward aggregation: min(child earlyStart), max(child earlyFinish).
  // Deepest-first so a summary that contains other summaries sees its
  // descendants already aggregated.
  for (const summary of summariesByDepthDesc) {
    if (summary.unscheduled) continue; // ADR-007: unscheduled summary → no aggregation
    const aggregated = aggregateFromChildren(summary, childrenByParent, forwardById);
    if (aggregated) forwardById.set(summary.id, aggregated);
  }

  // Backward pass — leaves first (reverse-sorted), summaries bottom-up after.
  const projectCeiling = projectFinishAnchor(project, forwardById, calendar);
  const backwardById = new Map<TaskId, BackwardDates>();

  for (const task of [...sorted].reverse()) {
    if (task.type === 'summary') continue;
    if (task.unscheduled) continue; // ADR-007: no pass for unscheduled tasks

    let latest = projectCeiling;
    for (const link of outgoingLinks(task.id, project.links)) {
      if (!isScheduled(link.target)) continue; // ADR-007: inert link to unscheduled
      const target = taskById.get(link.target);
      const targetBwd = backwardById.get(link.target);
      if (!target || !targetBwd) continue;
      const fromLink = latestFinishFromLink(link, task, target, targetBwd, calendar);
      if (fromLink < latest) latest = fromLink;
    }
    const fwd = forwardById.get(task.id);
    if (!fwd) continue;
    backwardById.set(task.id, applyBackwardConstraint(task, latest, fwd, calendar));
  }

  // Summary backward aggregation: min(child lateStart), max(child lateFinish).
  for (const summary of summariesByDepthDesc) {
    if (summary.unscheduled) continue; // ADR-007: unscheduled summary → no aggregation
    const aggregated = aggregateBackwardFromChildren(summary, childrenByParent, backwardById);
    if (aggregated) backwardById.set(summary.id, aggregated);
  }

  // Assemble final tasks with computed slack + critical.
  // For auto-mode tasks, write the scheduled dates back to task.start/end
  // (MS Project default behavior). Manual-mode tasks keep their user-set
  // dates regardless.
  const newTasks = project.tasks.map((t): Task => {
    const f = forwardById.get(t.id);
    const b = backwardById.get(t.id);
    if (!f || !b) return t;
    const totalSlack = workingMinutesBetween(f.earlyStart, b.lateStart, calendar);
    const freeSlack = computeFreeSlack(t, f, forwardById, project.links, calendar);
    const computed: TaskComputed = {
      earlyStart: f.earlyStart,
      earlyFinish: f.earlyFinish,
      lateStart: b.lateStart,
      lateFinish: b.lateFinish,
      totalSlack,
      freeSlack,
      isCritical: totalSlack <= 0,
    };
    if (t.deadline) {
      computed.deadlineSlackMinutes = workingMinutesBetween(f.earlyFinish, t.deadline, calendar);
      computed.deadlineMissed = f.earlyFinish.getTime() > t.deadline.getTime();
    }
    if (t.type === 'summary') {
      // Summary: dates + duration derived from child span; always overwritten.
      return {
        ...t,
        start: new Date(f.earlyStart),
        end: new Date(f.earlyFinish),
        duration: workingMinutesBetween(f.earlyStart, f.earlyFinish, calendar),
        computed,
      };
    }
    if (t.scheduleMode === 'auto') {
      return { ...t, start: new Date(f.earlyStart), end: new Date(f.earlyFinish), computed };
    }
    return { ...t, computed };
  });

  return { ...project, tasks: newTasks };
}

// ---------------------------------------------------------------------------
// Constraint application
// ---------------------------------------------------------------------------

function applyForwardConstraint(
  task: Task,
  predecessorEarliestStart: Date,
  calendar: Calendar,
): ForwardDates {
  const baseStart = snapToNextWorkingMoment(predecessorEarliestStart, calendar);
  const baseFinish = addWorkingMinutes(baseStart, task.duration, calendar);
  const base: ForwardDates = { earlyStart: baseStart, earlyFinish: baseFinish };

  const c = task.constraint;
  if (!c) return base;

  switch (c.type) {
    case 'ASAP':
    case 'ALAP': // ALAP applied (or rather, not applied) at this layer
      return base;

    // For constraint dates we trust the user-supplied moment as-is. Snapping
    // gets fiddly for finish-end-of-interval boundaries (5pm is a valid
    // finish but not a valid start). Document: constraint dates should be
    // working-time moments; weird inputs produce weird outputs.

    case 'MSO': {
      if (!c.date) return base;
      const earlyStart = new Date(c.date);
      const earlyFinish = addWorkingMinutes(earlyStart, task.duration, calendar);
      return { earlyStart, earlyFinish };
    }

    case 'MFO': {
      if (!c.date) return base;
      const earlyFinish = new Date(c.date);
      const earlyStart = subtractWorkingMinutes(earlyFinish, task.duration, calendar);
      return { earlyStart, earlyFinish };
    }

    case 'SNET': {
      if (!c.date) return base;
      const earlyStart = c.date > baseStart ? new Date(c.date) : baseStart;
      const earlyFinish = addWorkingMinutes(earlyStart, task.duration, calendar);
      return { earlyStart, earlyFinish };
    }

    case 'FNET': {
      if (!c.date) return base;
      if (c.date <= baseFinish) return base;
      const earlyFinish = new Date(c.date);
      const earlyStart = subtractWorkingMinutes(earlyFinish, task.duration, calendar);
      return { earlyStart, earlyFinish };
    }

    case 'SNLT':
    case 'FNLT':
      // Backward-direction constraints; no forward-pass effect.
      return base;
  }
}

function applyBackwardConstraint(
  task: Task,
  successorLatestFinish: Date,
  forward: ForwardDates,
  calendar: Calendar,
): BackwardDates {
  const baseLateFinish = snapToPreviousWorkingMoment(successorLatestFinish, calendar);
  const baseLateStart = subtractWorkingMinutes(baseLateFinish, task.duration, calendar);
  const base: BackwardDates = { lateStart: baseLateStart, lateFinish: baseLateFinish };

  const c = task.constraint;
  if (!c) return base;

  switch (c.type) {
    case 'ASAP':
    case 'ALAP':
    case 'SNET':
    case 'FNET':
      return base;

    case 'MSO':
    case 'MFO':
      // Hard pin: task is locked at the forward-pass date. Slack on the
      // task itself is zero; impossibility propagates back to predecessors.
      return { lateStart: forward.earlyStart, lateFinish: forward.earlyFinish };

    case 'SNLT': {
      if (!c.date) return base;
      const lateStart = c.date < baseLateStart ? new Date(c.date) : baseLateStart;
      const lateFinish = addWorkingMinutes(lateStart, task.duration, calendar);
      return { lateStart, lateFinish };
    }

    case 'FNLT': {
      if (!c.date) return base;
      const lateFinish = c.date < baseLateFinish ? new Date(c.date) : baseLateFinish;
      const lateStart = subtractWorkingMinutes(lateFinish, task.duration, calendar);
      return { lateStart, lateFinish };
    }
  }
}

// ---------------------------------------------------------------------------
// Link semantics
// ---------------------------------------------------------------------------

function earliestStartFromLink(
  link: Link,
  _source: Task,
  target: Task,
  sourceFwd: ForwardDates,
  calendar: Calendar,
): Date {
  switch (link.type) {
    case 'FS':
      return addWorkingTime(sourceFwd.earlyFinish, link.lag, calendar);
    case 'SS':
      return addWorkingTime(sourceFwd.earlyStart, link.lag, calendar);
    case 'FF': {
      const finishConstraint = addWorkingTime(sourceFwd.earlyFinish, link.lag, calendar);
      return subtractWorkingMinutes(finishConstraint, target.duration, calendar);
    }
    case 'SF': {
      const finishConstraint = addWorkingTime(sourceFwd.earlyStart, link.lag, calendar);
      return subtractWorkingMinutes(finishConstraint, target.duration, calendar);
    }
  }
}

function latestFinishFromLink(
  link: Link,
  source: Task,
  _target: Task,
  targetBwd: BackwardDates,
  calendar: Calendar,
): Date {
  switch (link.type) {
    case 'FS':
      return subtractWorkingMinutes(targetBwd.lateStart, link.lag, calendar);
    case 'SS': {
      const sourceLateStart = subtractWorkingMinutes(targetBwd.lateStart, link.lag, calendar);
      return addWorkingMinutes(sourceLateStart, source.duration, calendar);
    }
    case 'FF':
      return subtractWorkingMinutes(targetBwd.lateFinish, link.lag, calendar);
    case 'SF': {
      const sourceLateStart = subtractWorkingMinutes(targetBwd.lateFinish, link.lag, calendar);
      return addWorkingMinutes(sourceLateStart, source.duration, calendar);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultCalendar(project: Project): Calendar {
  const calendar = project.calendars.find((c) => c.id === project.defaultCalendarId);
  if (!calendar) {
    throw new Error(`Project default calendar "${project.defaultCalendarId}" not found`);
  }
  return calendar;
}

function incomingLinks(taskId: TaskId, links: Link[]): Link[] {
  return links.filter((l) => l.target === taskId);
}

function outgoingLinks(taskId: TaskId, links: Link[]): Link[] {
  return links.filter((l) => l.source === taskId);
}

function projectFinishAnchor(
  project: Project,
  forwardById: Map<TaskId, ForwardDates>,
  calendar: Calendar,
): Date {
  if (project.end) return snapToPreviousWorkingMoment(project.end, calendar);
  let latest: Date | undefined;
  for (const f of forwardById.values()) {
    if (!latest || f.earlyFinish > latest) latest = f.earlyFinish;
  }
  return latest ?? snapToNextWorkingMoment(project.start, calendar);
}

function addWorkingTime(date: Date, minutes: number, calendar: Calendar): Date {
  if (minutes > 0) return addWorkingMinutes(date, minutes, calendar);
  if (minutes < 0) return subtractWorkingMinutes(date, -minutes, calendar);
  return new Date(date);
}

// ---------------------------------------------------------------------------
// Summary task hierarchy
// ---------------------------------------------------------------------------

function groupChildrenByParent(tasks: Task[]): Map<TaskId, Task[]> {
  const map = new Map<TaskId, Task[]>();
  for (const t of tasks) {
    if (t.parent === undefined) continue;
    const list = map.get(t.parent) ?? [];
    list.push(t);
    map.set(t.parent, list);
  }
  return map;
}

function summariesDeepestFirst(tasks: Task[]): Task[] {
  const parentById = new Map<TaskId, TaskId | undefined>();
  for (const t of tasks) parentById.set(t.id, t.parent);

  const depthCache = new Map<TaskId, number>();
  function depthOf(id: TaskId): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const parent = parentById.get(id);
    const d = parent === undefined ? 0 : depthOf(parent) + 1;
    depthCache.set(id, d);
    return d;
  }

  return tasks
    .filter((t) => t.type === 'summary')
    .map((t) => ({ task: t, depth: depthOf(t.id) }))
    .sort((a, b) => b.depth - a.depth)
    .map((x) => x.task);
}

function aggregateFromChildren(
  summary: Task,
  childrenByParent: Map<TaskId, Task[]>,
  forwardById: Map<TaskId, ForwardDates>,
): ForwardDates | undefined {
  const children = childrenByParent.get(summary.id) ?? [];
  const dates = children
    .map((c) => forwardById.get(c.id))
    .filter((d): d is ForwardDates => d !== undefined);
  if (dates.length === 0) return undefined;
  let earlyStartMs = Number.POSITIVE_INFINITY;
  let earlyFinishMs = Number.NEGATIVE_INFINITY;
  for (const d of dates) {
    if (d.earlyStart.getTime() < earlyStartMs) earlyStartMs = d.earlyStart.getTime();
    if (d.earlyFinish.getTime() > earlyFinishMs) earlyFinishMs = d.earlyFinish.getTime();
  }
  return {
    earlyStart: new Date(earlyStartMs),
    earlyFinish: new Date(earlyFinishMs),
  };
}

function aggregateBackwardFromChildren(
  summary: Task,
  childrenByParent: Map<TaskId, Task[]>,
  backwardById: Map<TaskId, BackwardDates>,
): BackwardDates | undefined {
  const children = childrenByParent.get(summary.id) ?? [];
  const dates = children
    .map((c) => backwardById.get(c.id))
    .filter((d): d is BackwardDates => d !== undefined);
  if (dates.length === 0) return undefined;
  let lateStartMs = Number.POSITIVE_INFINITY;
  let lateFinishMs = Number.NEGATIVE_INFINITY;
  for (const d of dates) {
    if (d.lateStart.getTime() < lateStartMs) lateStartMs = d.lateStart.getTime();
    if (d.lateFinish.getTime() > lateFinishMs) lateFinishMs = d.lateFinish.getTime();
  }
  return {
    lateStart: new Date(lateStartMs),
    lateFinish: new Date(lateFinishMs),
  };
}

function computeFreeSlack(
  task: Task,
  taskFwd: ForwardDates,
  forwardById: Map<TaskId, ForwardDates>,
  links: Link[],
  calendar: Calendar,
): number {
  const outgoing = links.filter((l) => l.source === task.id);
  if (outgoing.length === 0) return 0;

  let minGap = Number.POSITIVE_INFINITY;
  for (const link of outgoing) {
    const targetFwd = forwardById.get(link.target);
    if (!targetFwd) continue;

    let requiredEnd: Date;
    switch (link.type) {
      case 'FS':
        requiredEnd = subtractWorkingMinutes(targetFwd.earlyStart, link.lag, calendar);
        break;
      case 'SS':
        requiredEnd = addWorkingMinutes(
          subtractWorkingMinutes(targetFwd.earlyStart, link.lag, calendar),
          task.duration,
          calendar,
        );
        break;
      case 'FF':
        requiredEnd = subtractWorkingMinutes(targetFwd.earlyFinish, link.lag, calendar);
        break;
      case 'SF':
        requiredEnd = addWorkingMinutes(
          subtractWorkingMinutes(targetFwd.earlyFinish, link.lag, calendar),
          task.duration,
          calendar,
        );
        break;
    }
    const gap = workingMinutesBetween(taskFwd.earlyFinish, requiredEnd, calendar);
    if (gap < minGap) minGap = gap;
  }
  return Number.isFinite(minGap) ? minGap : 0;
}
