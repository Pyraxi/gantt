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
//    required start, or (no successor) to the project's early finish, capped
//    at total slack. isCritical = totalSlack <= 0.
//
// Per ADR-003, negative slack is preserved, not clipped to zero. A task
// with negative slack is already late against a downstream constraint;
// surfacing that is the differentiator vs every existing alternative.
//
// ALAP semantics (consume slack to push the task to its latest position)
// are deferred — full ALAP requires a second forward pass after the
// backward pass to re-flow downstream dates. For now ALAP is parsed but
// behaves like ASAP.

import { createCalendarResolver, type EffectiveCalendar } from './calendars/effective';
import { assertUniqueTaskIds, topologicalSort } from './topological-sort';
import type { Calendar, Constraint, Link, Project, Task, TaskComputed, TaskId } from './types';
import {
  addWorkingMinutes,
  createWorkingMinutesCounter,
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
  // Every id → task map below keeps one row per id: a duplicate would be
  // silently mis-scheduled (or misreported as a cycle), so refuse it up front.
  assertUniqueTaskIds(project.tasks, 'schedule()');
  // Each task works in its effective calendar (task ∩ assigned resources'
  // calendars, base inheritance flattened). Lag runs in the successor's
  // calendar; slack in the task's own. Summaries keep the default calendar.
  const resolver = createCalendarResolver(project);
  const calendar = resolver.defaultCalendar();
  const effectiveById = new Map<TaskId, EffectiveCalendar>();
  const effectiveOf = (t: Task): EffectiveCalendar => {
    let e = effectiveById.get(t.id);
    if (!e) {
      e = resolver.effectiveFor(t);
      effectiveById.set(t.id, e);
    }
    return e;
  };
  const calOf = (t: Task): Calendar => effectiveOf(t).calendar;
  // Lags into a task: its real calendar even when its duration is elapsed.
  const lagCalOf = (t: Task): Calendar => effectiveOf(t).lagCalendar ?? calOf(t);
  const sorted = topologicalSort(project.tasks, project.links);
  const taskById = new Map<TaskId, Task>(sorted.map((t) => [t.id, t]));
  const childrenByParent = groupChildrenByParent(project.tasks);
  const summariesByDepthDesc = summariesDeepestFirst(project.tasks);
  // Index links once — per-task filtering of the whole link array made the
  // passes O(tasks × links), superlinear at 5k tasks.
  const incomingByTarget = groupLinksBy(project.links, 'target');
  const outgoingBySource = groupLinksBy(project.links, 'source');

  // Unscheduled tasks (ADR-007) are excluded from the pass entirely: no
  // computed, no cascade. They pass through to the output untouched.
  const isScheduled = (taskId: TaskId): boolean => !taskById.get(taskId)?.unscheduled;

  // Status-date scheduling (parity row 6). Every branch below is gated on
  // `status`: with no `project.statusDate`, the passes are byte-identical.
  const status = project.statusDate;
  const override = project.progressMode === 'progress-override';
  // MS Project (default): the status date moves nothing; remaining work
  // follows the work done. P6's data date (opt-in): nothing left to do is
  // forecast before the status date.
  const fromStatus = project.rescheduleAfterStatusDate === true;
  const remainingStartById = new Map<TaskId, Date>();
  const outOfSequence = new Set<TaskId>();
  // Manual tasks keep their user dates in status mode too (MS Project): only
  // auto leaves are re-forecast. Their state is still reported.
  const stateFor = (t: Task) =>
    status && t.type !== 'summary' && t.scheduleMode !== 'manual' ? progressState(t) : undefined;

  // A summary's Start No Earlier Than floors every task under it (MS Project).
  const summaryFloorById = summaryStartFloors(project.tasks);

  // Forward pass — leaves first, summaries bottom-up after.
  const forwardById = new Map<TaskId, ForwardDates>();
  // Unsnapped: each task snaps the floor into its own calendar.
  const projectFloor = project.start;

  for (const task of sorted) {
    if (task.type === 'summary') continue; // aggregated below
    if (task.unscheduled) continue; // ADR-007: no pass for unscheduled tasks

    {
      const state = stateFor(task);
      if (state === 'complete') {
        // Fixed at the actuals (falling back to the planned dates).
        forwardById.set(task.id, {
          earlyStart: new Date(task.actualStart ?? task.start),
          earlyFinish: new Date(task.actualFinish ?? task.end),
        });
        continue;
      }
      if (state === 'in-progress') {
        // Start fixed at the actual start. The remaining work follows the
        // work done (MS Project; from the status date with
        // rescheduleAfterStatusDate) and, with retained logic, waits for its
        // predecessors: MS Project then splits the task (desktop run 9).
        const cal = calOf(task);
        const remaining = remainingMinutes(task, { statusDate: status, calendar: cal });
        const remainingTask = { ...task, duration: remaining };
        // A P6 Expected Finish is measured from the status date (remainingMinutes).
        let from: Date =
          fromStatus || task.expectedFinish
            ? (status ?? projectFloor) // stateFor() only yields a state when status is set
            : addWorkingMinutes(
                task.actualStart ?? task.start,
                actualMinutes(task, remaining),
                cal,
              );
        for (const link of incomingByTarget.get(task.id) ?? []) {
          if (!isScheduled(link.source)) continue;
          const source = taskById.get(link.source);
          const sourceFwd = forwardById.get(link.source);
          if (!source || !sourceFwd) continue;
          if (startedOutOfSequence(link, source)) outOfSequence.add(task.id);
          if (override) continue;
          const fromLink = earliestStartFromLink(
            link,
            source,
            remainingTask,
            sourceFwd,
            cal,
            lagCalOf(task),
          );
          if (fromLink > from) from = fromLink;
        }
        // Nothing left: it ends where the work done does (Tue 17:00, not Wed 08:00).
        let remainingStart = remaining > 0 ? snapToNextWorkingMoment(from, cal) : new Date(from);
        let earlyFinish = addWorkingMinutes(remainingStart, remaining, cal);
        // Start constraints no longer apply once work has started; finish
        // constraints still do (MFO pins, FNET floors the finish).
        for (const fc of [task.constraint, secondaryOf(task)]) {
          if (fc?.date && (fc.type === 'MFO' || (fc.type === 'FNET' && fc.date > earlyFinish))) {
            earlyFinish = new Date(fc.date);
            remainingStart = subtractWorkingMinutes(earlyFinish, remaining, cal);
          }
        }
        remainingStartById.set(task.id, remainingStart);
        forwardById.set(task.id, {
          earlyStart: new Date(task.actualStart ?? task.start),
          earlyFinish,
        });
        continue;
      }
    }

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

    // MS Project leaves unstarted work where its logic puts it, even behind
    // the status date (desktop runs 8 and 9). P6's data date floors it,
    // snapped: a milestone takes the project start or a link's moment raw,
    // but a status date is a reporting instant, not a place to sit.
    let earliest =
      fromStatus && status && status > projectFloor
        ? snapToNextWorkingMoment(status, calOf(task))
        : projectFloor;
    const summaryFloor = summaryFloorById.get(task.id);
    if (summaryFloor && summaryFloor > earliest) earliest = summaryFloor;
    for (const link of incomingByTarget.get(task.id) ?? []) {
      if (!isScheduled(link.source)) continue; // ADR-007: inert link from unscheduled
      const source = taskById.get(link.source);
      const sourceFwd = forwardById.get(link.source);
      if (!source || !sourceFwd) continue;
      const fromLink = earliestStartFromLink(
        link,
        source,
        task,
        sourceFwd,
        calOf(task),
        lagCalOf(task),
      );
      if (fromLink > earliest) earliest = fromLink;
    }
    const primaryFwd = applyForwardConstraint(task, earliest, calOf(task));
    const secondary = secondaryOf(task);
    forwardById.set(
      task.id,
      secondary
        ? applyForwardConstraint(
            { ...task, constraint: secondary },
            primaryFwd.earlyStart,
            calOf(task),
          )
        : primaryFwd,
    );
  }

  // Summary forward aggregation: min(child earlyStart), max(child earlyFinish).
  // Deepest-first so a summary that contains other summaries sees its
  // descendants already aggregated.
  for (const summary of summariesByDepthDesc) {
    if (summary.unscheduled) continue; // ADR-007: unscheduled summary → no aggregation
    const aggregated = aggregateFromChildren(summary, childrenByParent, forwardById);
    if (aggregated) forwardById.set(summary.id, aggregated);
  }

  // The project's early finish: free float of a task with no (constraining)
  // successor runs to here (MS Project / P6).
  let projectEarlyFinish: Date | undefined;
  for (const f of forwardById.values()) {
    if (!projectEarlyFinish || f.earlyFinish > projectEarlyFinish)
      projectEarlyFinish = f.earlyFinish;
  }

  // Backward pass — leaves first (reverse-sorted), summaries bottom-up after.
  const projectCeiling = projectFinishAnchor(project, forwardById, calendar);
  const backwardById = new Map<TaskId, BackwardDates>();

  for (const task of [...sorted].reverse()) {
    if (task.type === 'summary') continue;
    if (task.unscheduled) continue; // ADR-007: no pass for unscheduled tasks

    const state = stateFor(task);
    if (state === 'complete') {
      // Done: no float, and its dates are history, not a requirement.
      const done = forwardById.get(task.id);
      if (done) {
        backwardById.set(task.id, {
          lateStart: new Date(done.earlyStart),
          lateFinish: new Date(done.earlyFinish),
        });
      }
      continue;
    }
    // For SS / SF, an in-progress predecessor's late dates cover its remaining work.
    const sourceTask =
      state === 'in-progress'
        ? {
            ...task,
            duration: remainingMinutes(task, { statusDate: status, calendar: calOf(task) }),
          }
        : task;

    // A milestone bounded only by the project finish may sit at its latest
    // equivalent moment (a Fri 17:00 finish ≡ Mon 08:00): nothing reads its clock time.
    let latest =
      task.duration <= 0 ? snapToNextWorkingMoment(projectCeiling, calOf(task)) : projectCeiling;
    for (const link of outgoingBySource.get(task.id) ?? []) {
      if (!isScheduled(link.target)) continue; // ADR-007: inert link to unscheduled
      const target = taskById.get(link.target);
      const targetBwd = backwardById.get(link.target);
      if (!target || !targetBwd) continue;
      if (status) {
        const targetState = stateFor(target);
        // A finished successor no longer constrains; progress override drops
        // logic into work already under way.
        if (targetState === 'complete') continue;
        if (targetState === 'in-progress' && override) continue;
      }
      const fromLink = latestFinishFromLink(
        link,
        sourceTask,
        target,
        targetBwd,
        calOf(task),
        lagCalOf(target),
        task,
        calOf(target),
      );
      if (fromLink < latest) latest = fromLink;
    }
    const fwd = forwardById.get(task.id);
    if (!fwd) continue;
    if (state === 'in-progress') {
      // Late dates of the REMAINING work (successors see its late start),
      // with only finish constraints applying once work has started.
      const isFinish = (x?: Constraint) =>
        x && (x.type === 'FNLT' || x.type === 'MFO' || x.type === 'FNET') ? x : undefined;
      const finishOnly = isFinish(task.constraint);
      const secondaryFinish = isFinish(secondaryOf(task));
      const remainingStart = remainingStartById.get(task.id) ?? fwd.earlyStart;
      const remainingFwd = { earlyStart: remainingStart, earlyFinish: fwd.earlyFinish };
      const firstBwd = applyBackwardConstraint(
        { ...sourceTask, constraint: finishOnly },
        latest,
        remainingFwd,
        calOf(task),
      );
      backwardById.set(
        task.id,
        secondaryFinish
          ? applyBackwardConstraint(
              { ...sourceTask, constraint: secondaryFinish },
              firstBwd.lateFinish,
              remainingFwd,
              calOf(task),
            )
          : firstBwd,
      );
      continue;
    }
    const primaryBwd = applyBackwardConstraint(task, latest, fwd, calOf(task));
    const secondaryBwd = secondaryOf(task);
    backwardById.set(
      task.id,
      secondaryBwd
        ? applyBackwardConstraint(
            { ...task, constraint: secondaryBwd },
            primaryBwd.lateFinish,
            fwd,
            calOf(task),
          )
        : primaryBwd,
    );
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
  // Slack spans can be long (an open-ended leaf floats to the project
  // finish): measure a long one with a memoised counter per calendar rather
  // than a day-by-day walk per task. The counter's set-up covers its span
  // plus a year each side, so short spans (the usual case, and every span of
  // a small programme re-scheduled per edit) keep the walk. Both give the
  // same answer.
  const LONG_SPAN_MS = 60 * 86_400_000;
  const counters = new Map<Calendar, (a: Date, b: Date) => number>();
  const slackBetween = (a: Date, b: Date, cal: Calendar): number => {
    if (Math.abs(b.getTime() - a.getTime()) < LONG_SPAN_MS) return workingMinutesBetween(a, b, cal);
    let c = counters.get(cal);
    if (!c) {
      c = createWorkingMinutesCounter(cal);
      counters.set(cal, c);
    }
    return c(a, b);
  };
  const newTasks = project.tasks.map((t): Task => {
    const f = forwardById.get(t.id);
    const b = backwardById.get(t.id);
    // Tasks the pass skips (e.g. unscheduled) must not retain a stale `computed`
    // from a previous schedule() run — CM re-runs schedule() on prior output, so
    // returning `t` verbatim leaks old dates/slack/criticality (ADR-007: an
    // unscheduled task contributes no computed). Strip it.
    if (!f || !b) return t.computed ? { ...t, computed: undefined } : t;
    const own = t.type === 'summary' ? undefined : effectiveOf(t);
    const ownCal = own?.calendar ?? calendar;
    const state = stateFor(t);
    // In progress: finish float (the start is history). Complete: none.
    const totalSlack =
      state === 'complete'
        ? 0
        : state === 'in-progress'
          ? slackBetween(f.earlyFinish, b.lateFinish, ownCal)
          : slackBetween(f.earlyStart, b.lateStart, ownCal);
    const rawFreeSlack = computeFreeSlack(
      state === 'in-progress'
        ? { ...t, duration: remainingMinutes(t, { statusDate: status, calendar: ownCal }) }
        : t,
      f,
      (id) => {
        const target = taskById.get(id);
        const fwdT = forwardById.get(id);
        if (!status || !target || !fwdT) return fwdT;
        const ts = stateFor(target);
        if (ts === 'complete' || (ts === 'in-progress' && override)) return undefined;
        const rs = ts === 'in-progress' ? remainingStartById.get(id) : undefined;
        return rs ? { earlyStart: rs, earlyFinish: fwdT.earlyFinish } : fwdT;
      },
      outgoingBySource.get(t.id) ?? [],
      ownCal,
      (id) => {
        const target = taskById.get(id);
        return target
          ? { lag: lagCalOf(target), own: calOf(target), milestone: target.duration <= 0 }
          : { lag: calendar, own: calendar, milestone: false };
      },
      t,
    );
    // No constraining successor: float to the project's early finish, in the
    // task's own calendar (as total slack), and never more than total slack.
    const freeSlack =
      state === 'complete'
        ? 0
        : (rawFreeSlack ??
          Math.min(
            totalSlack,
            projectEarlyFinish ? slackBetween(f.earlyFinish, projectEarlyFinish, ownCal) : 0,
          ));
    const computed: TaskComputed = {
      earlyStart: f.earlyStart,
      earlyFinish: f.earlyFinish,
      lateStart: b.lateStart,
      lateFinish: b.lateFinish,
      totalSlack,
      freeSlack,
      isCritical: state === 'complete' ? false : totalSlack <= 0,
    };
    if (t.deadline) {
      computed.deadlineSlackMinutes = workingMinutesBetween(f.earlyFinish, t.deadline, ownCal);
      computed.deadlineMissed = f.earlyFinish.getTime() > t.deadline.getTime();
    }
    if (own?.fallback) computed.calendarFallback = own.fallback;
    const reported = status && t.type !== 'summary' ? progressState(t) : undefined;
    if (reported) {
      computed.status = reported;
      const remainingStart = remainingStartById.get(t.id);
      if (remainingStart) computed.remainingStart = remainingStart;
      if (outOfSequence.has(t.id)) computed.outOfSequence = true;
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
// Progress (status-date scheduling)
// ---------------------------------------------------------------------------

/** Where a task stands: an actual finish or 100% → complete; an actual start or any progress → in progress. */
export function progressState(t: Task): 'complete' | 'in-progress' | 'not-started' {
  const pct = t.progress ?? 0;
  if (t.actualFinish || pct >= 100) return 'complete';
  if (t.actualStart || pct > 0) return 'in-progress';
  return 'not-started';
}

/**
 * A task's P6 secondary constraint, when it applies: SNET / SNLT / FNET / FNLT
 * with a date, under a primary that isn't a (dated) mandatory MSO / MFO.
 */
export function secondaryOf(task: Task): Constraint | undefined {
  const sec = task.secondaryConstraint;
  if (!sec?.date) return undefined;
  const primary = task.constraint;
  if (primary?.date && (primary.type === 'MSO' || primary.type === 'MFO')) return undefined;
  return sec.type === 'SNET' || sec.type === 'SNLT' || sec.type === 'FNET' || sec.type === 'FNLT'
    ? sec
    : undefined;
}

/**
 * Working minutes done on a task under way, given what's left: the share of
 * its duration its % complete says (MS Project's actual duration), or
 * duration − remaining when the remaining is that share.
 */
export function actualMinutes(t: Task, remaining: number): number {
  const duration = Math.max(0, t.duration);
  const pct = Number.isFinite(t.progress) ? Math.min(100, Math.max(0, t.progress)) : 0;
  const share = Math.round(duration * (1 - pct / 100));
  return Math.max(
    0,
    remaining === share ? duration - remaining : Math.round((duration * pct) / 100),
  );
}

/**
 * Working minutes left: P6 Expected Finish (with a status date — from the
 * status date to `expectedFinish` in `calendar`), else `remainingDuration`,
 * else duration × (1 − progress / 100).
 */
export function remainingMinutes(
  t: Task,
  opts: { statusDate?: Date; calendar?: Calendar } = {},
): number {
  // Expected Finish only re-forecasts work under way (as schedule() applies it).
  if (t.expectedFinish && opts.statusDate && opts.calendar && progressState(t) === 'in-progress') {
    const from = snapToNextWorkingMoment(opts.statusDate, opts.calendar);
    return Math.max(0, workingMinutesBetween(from, t.expectedFinish, opts.calendar));
  }
  if (t.remainingDuration !== undefined) return Math.max(0, t.remainingDuration);
  const pct = Math.min(100, Math.max(0, t.progress ?? 0));
  return Math.round(t.duration * (1 - pct / 100));
}

/**
 * Each task's latest SNET date among its summary ancestors, where any has one.
 * Manual and unscheduled summaries don't push their children (MS Project).
 */
function summaryStartFloors(tasks: Task[]): Map<TaskId, Date> {
  const floors = new Map<TaskId, Date>();
  const anchorDate = (t: Task) =>
    t.constraint?.type === 'SNET' && t.scheduleMode !== 'manual' && !t.unscheduled
      ? t.constraint.date
      : undefined;
  if (!tasks.some(anchorDate)) return floors;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // The floor a task passes down: its own SNET or its ancestors', memoised.
  const passed = new Map<TaskId, Date | null>();
  const floorFrom = (id: TaskId): Date | undefined => {
    const known = passed.get(id);
    if (known !== undefined) return known ?? undefined;
    passed.set(id, null); // a parent cycle stops here
    const t = byId.get(id);
    if (!t) return undefined;
    const up = t.parent === undefined ? undefined : floorFrom(t.parent);
    const own = anchorDate(t);
    const floor = own && (!up || own > up) ? own : up;
    passed.set(id, floor ?? null);
    return floor;
  };
  for (const t of tasks) {
    const floor = t.parent === undefined ? undefined : floorFrom(t.parent);
    if (floor) floors.set(t.id, floor);
  }
  return floors;
}

/**
 * Started before its predecessor allowed: an FS predecessor not yet finished,
 * or an SS one not yet started. FF / SF constrain the finish, so starting
 * early is normal sequencing for them. Lags are ignored (as P6 does).
 */
function startedOutOfSequence(link: Link, source: Task): boolean {
  if (source.type === 'summary') return false;
  const state = progressState(source);
  if (link.type === 'FS') return state !== 'complete';
  if (link.type === 'SS') return state === 'not-started';
  return false;
}

// ---------------------------------------------------------------------------
// Constraint application
// ---------------------------------------------------------------------------

function applyForwardConstraint(
  task: Task,
  predecessorEarliestStart: Date,
  calendar: Calendar,
): ForwardDates {
  // A milestone sits where its logic puts it, even in non-working time (a
  // Saturday project start, Fri 17:00 + 10 ehrs = Sat 03:00): MS Project never
  // snaps one (desktop runs 7 and 9).
  const baseStart =
    task.duration <= 0
      ? new Date(predecessorEarliestStart)
      : snapToNextWorkingMoment(predecessorEarliestStart, calendar);
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
  const baseLateFinish =
    task.duration <= 0
      ? new Date(successorLatestFinish) // never snapped (see applyForwardConstraint)
      : snapToPreviousWorkingMoment(successorLatestFinish, calendar);
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

/**
 * Lag and target duration both run in the target (successor) calendar.
 * @internal Also used by driving-path analysis, so both share one definition
 * of the date a link allows.
 */
export function earliestStartFromLink(
  link: Link,
  source: Task,
  target: Task,
  sourceFwd: ForwardDates,
  /** The successor's calendar (its duration). */
  calendar: Calendar,
  /** The calendar the lag runs in: the successor's real one (differs for elapsed durations). */
  lagCalendar: Calendar = calendar,
): Date {
  // A lead counted back in another calendar than the successor's own can land
  // on an interval start (Wed 08:00); in that calendar it equals the previous
  // interval's end (Tue 17:00), and to the successor (an elapsed 24/7 task)
  // the earlier moment is the earliest its logic allows — as the backward pass
  // assumes. Positive / zero lags keep their moment (it may be a real
  // wall-clock finish).
  const lag = (from: Date) => {
    const at = addLag(from, link, source, lagCalendar);
    if (link.lagElapsed || lagCalendar.id === calendar.id || lagMinutes(link, source) >= 0) {
      return at;
    }
    return previousEndIfIntervalStart(at, lagCalendar);
  };
  // A lead into a milestone's finish that lands on an interval start (Tue
  // 08:00) puts it at the end of the previous period (Mon 17:00), as a finish
  // date: MS Project does (desktop runs 7 and 9). A lead into a start lands on
  // the next morning, and no lag keeps the moment as it is.
  const finishBy = (finish: Date) => {
    if (target.duration > 0) return subtractWorkingMinutes(finish, target.duration, calendar);
    if (link.lagElapsed || lagMinutes(link, source) >= 0) return finish;
    return previousEndIfIntervalStart(finish, calendar);
  };
  switch (link.type) {
    case 'FS':
      return lag(sourceFwd.earlyFinish);
    case 'SS':
      return lag(sourceFwd.earlyStart);
    // An elapsed lag can land in non-working time (Sat 17:00). Counting back
    // finishes the successor at the end of the previous working period (Fri
    // 17:00) — no working time lies between, the same as an FNET on a Saturday.
    case 'FF':
      return finishBy(lag(sourceFwd.earlyFinish));
    case 'SF':
      return finishBy(lag(sourceFwd.earlyStart));
  }
}

/** An interval start (Wed 08:00) as the end of the previous period (Tue 17:00); else as is. */
function previousEndIfIntervalStart(at: Date, calendar: Calendar): Date {
  const before = snapToPreviousWorkingMoment(at, calendar);
  return before < at && snapToNextWorkingMoment(at, calendar).getTime() === at.getTime()
    ? before
    : at;
}

/**
 * Lag runs in the successor's calendar; source duration in the source's.
 *
 * A moment computed in the target calendar is handed over as its *latest*
 * equivalent (`snapToNextWorkingMoment` in the target calendar) before the
 * source snaps it back in its own calendar. In one calendar this is a no-op
 * (end-of-interval ≡ next start); across calendars it stops working time the
 * source has, but the target doesn't, from turning into spurious negative slack.
 */
function latestFinishFromLink(
  link: Link,
  source: Task,
  target: Task,
  targetBwd: BackwardDates,
  sourceCalendar: Calendar,
  /** The successor's lag calendar (its real one even when its duration is elapsed). */
  targetCalendar: Calendar,
  /** The task the lag is measured on (full duration — `source` may be its remaining work). */
  lagSource: Task = source,
  /** The successor's own (duration) calendar. */
  targetOwnCalendar: Calendar = targetCalendar,
): Date {
  // Working lag: hand over the latest equivalent working moment (see above).
  // Elapsed lag: measured back from the successor's wall-clock moment, which is
  // exact — snapping the result in the successor's calendar would invent float.
  const handOver = (d: Date) =>
    handOverLag(d, link, lagSource, targetCalendar, targetOwnCalendar, target.duration <= 0);
  // The source's latest start must be a start the forward pass can produce.
  // Within one calendar any equivalent moment will do (Fri 17:00 ≡ Mon 08:00);
  // across calendars — an elapsed lag, or a successor on another calendar —
  // they're different moments to the successor, so take the last valid one.
  const crossCalendar =
    link.lagElapsed ||
    targetCalendar.id !== sourceCalendar.id ||
    targetOwnCalendar.id !== sourceCalendar.id;
  // A milestone can sit anywhere, so any moment is a valid start for one.
  const startBy = (d: Date) =>
    crossCalendar && source.duration > 0
      ? latestStartAtOrBefore(handOver(d), sourceCalendar)
      : handOver(d);
  // A milestone's finish is its start, so it too must be a place it can sit.
  const finishBy = (d: Date) => (source.duration <= 0 ? startBy(d) : handOver(d));
  switch (link.type) {
    case 'FS':
      return finishBy(targetBwd.lateStart);
    case 'SS':
      return addWorkingMinutes(startBy(targetBwd.lateStart), source.duration, sourceCalendar);
    case 'FF':
      return finishBy(targetBwd.lateFinish);
    case 'SF':
      return addWorkingMinutes(startBy(targetBwd.lateFinish), source.duration, sourceCalendar);
  }
}

/**
 * The latest moment at or before `bound` a task can start at. A period end
 * (Tue 17:00) is not one — starting there means starting Wed 08:00 — so a
 * bound in non-working time gives the period's last working minute.
 */
function latestStartAtOrBefore(bound: Date, calendar: Calendar): Date {
  if (snapToNextWorkingMoment(bound, calendar).getTime() === bound.getTime()) return bound;
  return new Date(snapToPreviousWorkingMoment(bound, calendar).getTime() - 60_000);
}

/**
 * The latest moment a link's lag may start from so the successor can still be
 * at `d` (its late — or, for free slack, early — date, in `calendar`).
 *
 * Working lag: subtract, then take the latest equivalent working moment.
 * Elapsed lag: the forward pass snaps the successor forward in its calendar
 * after the wall-clock lag (Wed 17:00 ≡ Thu 08:00), so measure back from the
 * successor's next working moment; snapping the result in the successor's
 * calendar would invent float.
 */
function handOverLag(
  d: Date,
  link: Link,
  lagSource: Task,
  /** The lag's calendar (the successor's real one). */
  calendar: Calendar,
  /** The successor's own (duration) calendar — where the forward pass snaps its start. */
  targetCalendar: Calendar = calendar,
  /** A milestone successor sits at a period end as it is: Tue 17:00 isn't Wed 08:00 to it. */
  targetIsMilestone = false,
): Date {
  const at = targetIsMilestone ? d : snapToNextWorkingMoment(d, targetCalendar);
  if (link.lagElapsed) return subtractLag(at, link, lagSource, calendar);
  // No lag: the forward pass only snaps the predecessor's date in the
  // successor's own calendar, so its latest equivalent moment is there (a
  // 24/7 elapsed successor: Tue 20:00 is not Wed 08:00).
  if (lagMinutes(link, lagSource) === 0) return at;
  return snapToNextWorkingMoment(subtractLag(d, link, lagSource, calendar), calendar);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupLinksBy(links: Link[], end: 'source' | 'target'): Map<TaskId, Link[]> {
  const map = new Map<TaskId, Link[]>();
  for (const l of links) {
    const list = map.get(l[end]);
    if (list) list.push(l);
    else map.set(l[end], [l]);
  }
  return map;
}

function projectFinishAnchor(
  project: Project,
  forwardById: Map<TaskId, ForwardDates>,
  calendar: Calendar,
): Date {
  // Unsnapped: each task snaps the ceiling into its own calendar.
  if (project.end) return new Date(project.end);
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

/** The link's lag in minutes: `lagPercent` of the predecessor's duration, else `lag`. */
export function lagMinutes(link: Link, source: Task): number {
  if (link.lagPercent !== undefined) return Math.round((source.duration * link.lagPercent) / 100);
  return link.lag ?? 0;
}

/** Apply a link's lag forward: working time in `calendar`, or wall-clock when `lagElapsed`. */
function addLag(date: Date, link: Link, source: Task, calendar: Calendar): Date {
  const minutes = lagMinutes(link, source);
  if (link.lagElapsed) return new Date(date.getTime() + minutes * 60_000);
  return addWorkingTime(date, minutes, calendar);
}

/** Mirror of {@link addLag} for the backward pass. */
function subtractLag(date: Date, link: Link, source: Task, calendar: Calendar): Date {
  const minutes = lagMinutes(link, source);
  if (link.lagElapsed) return new Date(date.getTime() - minutes * 60_000);
  return subtractWorkingTime(date, minutes, calendar);
}

/**
 * Sign-aware mirror of `addWorkingTime`: subtract `minutes` of working time,
 * treating a NEGATIVE value as an addition. The raw `subtractWorkingMinutes`
 * no-ops on non-positive input, which silently dropped negative (lead) link lag
 * in the backward pass and free-slack — this is the correct primitive for any
 * `link.lag` subtraction, which can legitimately be negative.
 */
function subtractWorkingTime(date: Date, minutes: number, calendar: Calendar): Date {
  if (minutes > 0) return subtractWorkingMinutes(date, minutes, calendar);
  if (minutes < 0) return addWorkingMinutes(date, -minutes, calendar);
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
  /** The successor's forward dates for free-slack purposes; undefined = it doesn't constrain. */
  targetFwdOf: (id: TaskId) => ForwardDates | undefined,
  outgoing: Link[],
  calendar: Calendar,
  /** A successor's calendars: `lag` (its real one) and `own` (its duration's). */
  targetCalendarOf: (id: TaskId) => { lag: Calendar; own: Calendar; milestone: boolean },
  /** The task percent lags are measured on (full duration — `task` may be its remaining work). */
  lagSource: Task = task,
): number | undefined {
  if (outgoing.length === 0) return undefined;

  let minGap = Number.POSITIVE_INFINITY;
  for (const link of outgoing) {
    const targetFwd = targetFwdOf(link.target);
    if (!targetFwd) continue;
    // Lag in the successor's calendar; the gap itself in this task's.
    const {
      lag: lagCal,
      own: targetOwnCal,
      milestone: targetIsMilestone,
    } = targetCalendarOf(link.target);

    // Same hand-over as latestFinishFromLink: latest equivalent moment in
    // the successor's calendar, then measured in this task's.
    const handOver = (d: Date) =>
      handOverLag(d, link, lagSource, lagCal, targetOwnCal, targetIsMilestone);
    // As in latestFinishFromLink: across calendars, the last valid start.
    const crossCalendar =
      link.lagElapsed || lagCal.id !== calendar.id || targetOwnCal.id !== calendar.id;
    const startBy = (d: Date) =>
      crossCalendar && task.duration > 0
        ? latestStartAtOrBefore(handOver(d), calendar)
        : handOver(d);
    const finishBy = (d: Date) => (task.duration <= 0 ? startBy(d) : handOver(d));
    let requiredEnd: Date;
    switch (link.type) {
      case 'FS':
        requiredEnd = finishBy(targetFwd.earlyStart);
        break;
      case 'SS':
        requiredEnd = addWorkingMinutes(startBy(targetFwd.earlyStart), task.duration, calendar);
        break;
      case 'FF':
        requiredEnd = finishBy(targetFwd.earlyFinish);
        break;
      case 'SF':
        requiredEnd = addWorkingMinutes(startBy(targetFwd.earlyFinish), task.duration, calendar);
        break;
    }
    const gap = workingMinutesBetween(taskFwd.earlyFinish, requiredEnd, calendar);
    if (gap < minGap) minGap = gap;
  }
  // Undefined: no successor constrains it (the caller measures to the project finish).
  return Number.isFinite(minGap) ? minGap : undefined;
}
