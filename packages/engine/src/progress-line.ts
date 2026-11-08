// Progress line points (parity row 6, core rendering). The line runs down the
// chart from the status date and bends to each task's progress point — left
// when it's behind, right when it's ahead (MS Project / P6 / Bryntum).
// Spec: docs/superpowers/specs/2026-10-16-progress-line-design.md

import { createCalendarResolver } from './calendars/effective';
import { actualMinutes, progressState, remainingMinutes, schedule } from './schedule';
import type { Project, Task, TaskId } from './types';
import { addWorkingMinutes } from './working-time';

/**
 * Each scheduled leaf task's progress point against `statusDate` (default
 * `project.statusDate`; none → empty). On the status line: complete tasks and
 * not-started tasks not yet due (start ≥ status date) — the engine's own
 * `progressState`. Otherwise: the start plus the work done, in working time
 * on the task's effective calendar — a due task with nothing done sits at its
 * start; one started early is right of the line. Work done is what the
 * engine scheduled as done: `progress%` of the duration (MS Project's actual
 * duration, where an auto task's remaining work starts). With
 * `rescheduleAfterStatusDate`, and for manual tasks, it's
 * `duration − remainingMinutes(task)`, so an explicit `remainingDuration`
 * (P6's duration % complete) agrees with the forecast. Summaries and unscheduled tasks are
 * left out. Pure; schedules the project when `computed` is missing.
 */
export function progressPoints(
  project: Project,
  statusDate?: Date,
  options: {
    /**
     * `'duration'` (default): work done is the duration minus what remains.
     * `'physical'`: work done is `physicalProgress`% of the duration (P6's
     * progress line on physical % complete); a task without one falls back
     * to its duration basis.
     */
    basis?: 'duration' | 'physical';
  } = {},
): Map<TaskId, Date> {
  const points = new Map<TaskId, Date>();
  const status = statusDate ?? project.statusDate;
  if (!status) return points;
  const isLeaf = (t: Task) => t.type !== 'summary' && !t.unscheduled;
  const p = project.tasks.some((t) => isLeaf(t) && !t.computed) ? schedule(project) : project;
  const resolver = createCalendarResolver(p);
  const doneMinutes = (task: Task, remaining: number) =>
    p.rescheduleAfterStatusDate || task.scheduleMode === 'manual'
      ? Math.max(0, task.duration - remaining)
      : actualMinutes(task, remaining);
  for (const task of p.tasks) {
    if (!isLeaf(task)) continue;
    const state = progressState(task);
    const start = task.actualStart ?? task.start;
    if (state === 'complete' || (state === 'not-started' && start >= status)) {
      points.set(task.id, new Date(status));
      continue;
    }
    const cal = resolver.effectiveFor(task).calendar;
    const done =
      options.basis === 'physical' && task.physicalProgress !== undefined
        ? Math.round((task.duration * Math.min(100, Math.max(0, task.physicalProgress))) / 100)
        : doneMinutes(task, remainingMinutes(task, { statusDate: status, calendar: cal }));
    points.set(task.id, addWorkingMinutes(start, done, cal));
  }
  return points;
}
