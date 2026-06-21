// Baseline capture + variance API.
//
// Baselines snapshot the schedule at a point in time so we can compare the
// live programme against it later. Construction PMs need multiple
// baselines for variation-claim delay analysis under NZS 3910 / AS 4000
// (per ADR-003). We match MS Project's data model: up to 11 baselines
// (BaselineIndex 0..10) per project.

import type {
  Baseline,
  BaselineIndex,
  BaselineTaskSnapshot,
  Calendar,
  Project,
  Task,
  TaskId,
} from './types';
import { workingMinutesBetween } from './working-time';

/**
 * Snapshot the current schedule (task starts, ends, durations) as a baseline
 * at the given index. Returns a new Project with the baseline added; the
 * input is not mutated. If a baseline already exists at this index, it is
 * replaced (matches MS Project "Save Baseline" behavior).
 */
export function captureBaseline(
  project: Project,
  index: BaselineIndex,
  options?: { name?: string; capturedAt?: Date },
): Project {
  const tasks = new Map<TaskId, BaselineTaskSnapshot>();
  for (const task of project.tasks) {
    tasks.set(task.id, {
      start: new Date(task.start),
      end: new Date(task.end),
      duration: task.duration,
    });
  }
  const baseline: Baseline = {
    index,
    name: options?.name,
    capturedAt: options?.capturedAt ? new Date(options.capturedAt) : new Date(),
    tasks,
  };
  const existing = project.baselines.findIndex((b) => b.index === index);
  const newBaselines = [...project.baselines];
  if (existing >= 0) {
    newBaselines[existing] = baseline;
  } else {
    newBaselines.push(baseline);
  }
  return { ...project, baselines: newBaselines };
}

export interface TaskBaselineVariance {
  /** Working-minute drift in start. Positive = task is later than baseline. */
  startVariance: number;
  /** Working-minute drift in finish. Positive = task is later than baseline. */
  finishVariance: number;
  /** Change in duration (calendar-minute units of the task model). */
  durationVariance: number;
}

/**
 * Compute baseline variance for every task in `project`. Returns a Map
 * keyed by TaskId. Tasks not present in the named baseline are omitted
 * from the returned map.
 *
 * `baselineIndex` selects the baseline on `project.baselines`. If the
 * project has no baseline at that index, returns an empty Map (caller
 * decides whether to treat this as a soft error or hard error).
 *
 * The calendar used for working-time variance arithmetic is the project
 * default calendar, looked up by `project.defaultCalendarId`. If that
 * lookup fails, throw an Error (consistent with `schedule()`'s behavior
 * on a missing default calendar).
 */
export function getTaskBaselineVarianceAll(
  project: Project,
  baselineIndex: BaselineIndex,
): Map<TaskId, TaskBaselineVariance> {
  const baseline = project.baselines.find((b) => b.index === baselineIndex);
  if (!baseline) return new Map();

  const calendar = project.calendars.find((c) => c.id === project.defaultCalendarId);
  if (!calendar) {
    throw new Error(
      `Default calendar '${project.defaultCalendarId}' not found. Cannot compute baseline variance.`,
    );
  }

  const result = new Map<TaskId, TaskBaselineVariance>();
  for (const task of project.tasks) {
    const variance = getTaskBaselineVariance(task, baseline, calendar);
    if (variance !== undefined) {
      result.set(task.id, variance);
    }
  }
  return result;
}

/**
 * Compute working-time variance between a task's current dates and its
 * snapshot in a baseline. Returns undefined if the task isn't in the
 * baseline (added after the baseline was captured).
 */
export function getTaskBaselineVariance(
  task: Task,
  baseline: Baseline,
  calendar: Calendar,
): TaskBaselineVariance | undefined {
  const snap = baseline.tasks.get(task.id);
  if (!snap) return undefined;
  return {
    startVariance: workingMinutesBetween(snap.start, task.start, calendar),
    finishVariance: workingMinutesBetween(snap.end, task.end, calendar),
    durationVariance: task.duration - snap.duration,
  };
}
