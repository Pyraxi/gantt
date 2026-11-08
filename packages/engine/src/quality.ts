// Schedule quality checks (parity row 11): a DCMA-14-style health report over
// a programme — the "is this schedule well-built?" pass a planner runs before
// trusting its dates. Spec: docs/superpowers/specs/2026-10-16-schedule-quality-checks-design.md
//
// Pure: schedules the project itself when `computed` is missing, never mutates
// the input. Summaries and unscheduled tasks are excluded throughout.

import { createCalendarResolver } from './calendars/effective';
import { progressState, remainingMinutes, schedule, secondaryOf } from './schedule';
import type { ConstraintType, LinkId, Project, Task, TaskId } from './types';
import { workingMinutesPerDay } from './working-time';

export type ScheduleCheckId =
  | 'missing-logic'
  | 'leads'
  | 'lags'
  | 'relationship-types'
  | 'start-to-finish'
  | 'hard-constraints'
  | 'high-float'
  | 'negative-float'
  | 'high-duration'
  | 'invalid-dates'
  | 'critical-path';

export interface ScheduleCheck {
  id: ScheduleCheckId;
  /** The DCMA 14-point assessment number this corresponds to (planners cite by number). */
  dcma: number;
  label: string;
  /** What `count` / `total` count. */
  unit: 'tasks' | 'links' | 'project';
  /** Offending items. */
  count: number;
  /** The population tested (tasks or links, per check). */
  total: number;
  /** count / total (0 when total is 0). */
  ratio: number;
  /** Highest passing ratio. */
  threshold: number;
  pass: boolean;
  /** Offending tasks, in project order. */
  taskIds: TaskId[];
  /** Offending links, in project order (link checks only). */
  linkIds: LinkId[];
}

export interface ScheduleCheckResult {
  /** Every check passed. */
  pass: boolean;
  checks: ScheduleCheck[];
}

export interface CheckScheduleOptions {
  /** Override any check's maximum passing ratio (0–1). */
  thresholds?: Partial<Record<ScheduleCheckId, number>>;
  /** Float above this many working days is "high". Default 44 (DCMA). */
  highFloatDays?: number;
  /** Duration above this many working days is "high". Default 44 (DCMA). */
  highDurationDays?: number;
  /**
   * Data / status date (default: `project.statusDate`). When set, `invalid-dates` also flags unfinished work
   * due before it and progress recorded on work that starts after it.
   */
  statusDate?: Date;
  /** Re-run `schedule()` even when tasks already carry `computed` (e.g. after unscheduled edits). */
  reschedule?: boolean;
}

const DEFAULT_THRESHOLDS: Record<ScheduleCheckId, number> = {
  'missing-logic': 0.05,
  leads: 0,
  lags: 0.05,
  'relationship-types': 0.1,
  'start-to-finish': 0,
  'hard-constraints': 0.05,
  'high-float': 0.05,
  'negative-float': 0,
  'high-duration': 0.05,
  'invalid-dates': 0,
  'critical-path': 0,
};

const LABELS: Record<ScheduleCheckId, string> = {
  'missing-logic': 'Tasks missing a predecessor or successor',
  leads: 'Links with a lead (negative lag)',
  lags: 'Links with a lag',
  'relationship-types': 'Links that are not finish-to-start',
  'start-to-finish': 'Start-to-finish links',
  'hard-constraints': 'Tasks with a hard constraint',
  'high-float': 'Tasks with high total float',
  'negative-float': 'Tasks with negative total float',
  'high-duration': 'Tasks with a long duration',
  'invalid-dates': 'Tasks with invalid dates',
  'critical-path': 'No critical path drives the finish',
};

const HARD_CONSTRAINTS = new Set<ConstraintType>(['MSO', 'MFO', 'SNLT', 'FNLT']);

/** DCMA 14-point assessment number each check corresponds to. */
const DCMA: Record<ScheduleCheckId, number> = {
  'missing-logic': 1,
  leads: 2,
  lags: 3,
  'relationship-types': 4,
  'start-to-finish': 4,
  'hard-constraints': 5,
  'high-float': 6,
  'negative-float': 7,
  'high-duration': 8,
  'invalid-dates': 9,
  'critical-path': 12,
};

/**
 * Run the schedule quality checks. Returns every check (in a fixed order) with
 * its offending tasks / links, so a UI can list and highlight them.
 *
 * Populations follow DCMA as P6 / Acumen apply it:
 * - Task checks cover incomplete leaf tasks. Summaries and unscheduled tasks
 *   are excluded.
 * - Link checks cover links between leaf tasks whose successor is incomplete.
 *   Summary links are a defect elsewhere, so they never count as logic.
 * - The 44-day limits are measured in each task's own working day.
 *
 * Schedules the project when any leaf lacks `computed` (or with
 * `reschedule: true`); otherwise it trusts `computed` as-is, so call
 * `schedule()` first after edits. Throws where `schedule()` would (a link
 * cycle, a missing default calendar).
 */
export function checkSchedule(
  project: Project,
  options: CheckScheduleOptions = {},
): ScheduleCheckResult {
  const isLeaf = (t: Task) => t.type !== 'summary' && !t.unscheduled;
  const progress = (t: Task) => t.progress ?? 0;
  // With a project status date, use the engine's own progress model (actual
  // dates count, remainingDuration wins) so the checks agree with schedule().
  const engineProgress = project.statusDate !== undefined;
  const isComplete = (t: Task) =>
    engineProgress ? progressState(t) === 'complete' : progress(t) >= 100;
  const isNotStarted = (t: Task) =>
    engineProgress ? progressState(t) === 'not-started' : progress(t) === 0;
  const needsSchedule =
    options.reschedule === true || project.tasks.some((t) => isLeaf(t) && !t.computed);
  const p = needsSchedule ? schedule(project) : project;

  const leaves = p.tasks.filter(isLeaf);
  const incomplete = leaves.filter((t) => !isComplete(t));
  const leafIds = new Set(leaves.map((t) => String(t.id)));
  const incompleteIds = new Set(incomplete.map((t) => String(t.id)));
  // Logic between leaf tasks only.
  const leafLinks = p.links.filter(
    (l) => leafIds.has(String(l.source)) && leafIds.has(String(l.target)),
  );
  const hasPred = new Set(leafLinks.map((l) => String(l.target)));
  const hasSucc = new Set(leafLinks.map((l) => String(l.source)));
  // Relationship checks: links still to be worked (incomplete successor).
  const links = leafLinks.filter((l) => incompleteIds.has(String(l.target)));

  // Working day per task, in its effective calendar (ADR-011), flattened.
  const resolver = createCalendarResolver(p);
  const dayOf = (t: Task) => workingMinutesPerDay(resolver.effectiveFor(t).calendar);
  const highFloatDays = options.highFloatDays ?? 44;
  const highDurationDays = options.highDurationDays ?? 44;
  // Defaults to the project's status date (parity row 6).
  const status = (options.statusDate ?? p.statusDate)?.getTime();

  const thresholdOf = (id: ScheduleCheckId) => options.thresholds?.[id] ?? DEFAULT_THRESHOLDS[id];
  const make = (
    id: ScheduleCheckId,
    unit: ScheduleCheck['unit'],
    total: number,
    taskIds: TaskId[],
    linkIds: LinkId[] = [],
    count = taskIds.length + linkIds.length,
  ): ScheduleCheck => {
    const ratio = total > 0 ? count / total : 0;
    const threshold = thresholdOf(id);
    return {
      id,
      dcma: DCMA[id],
      label: LABELS[id],
      unit,
      count,
      total,
      ratio,
      threshold,
      pass: ratio <= threshold,
      taskIds,
      linkIds,
    };
  };
  const ids = (ts: Task[]) => ts.map((t) => t.id);
  const linkIds = (pred: (l: (typeof links)[number]) => boolean) =>
    links.filter(pred).map((l) => l.id);

  const startOf = (t: Task) => (t.computed?.earlyStart ?? t.start).getTime();
  const finishOf = (t: Task) => (t.computed?.earlyFinish ?? t.end).getTime();
  const remaining = (t: Task) =>
    remainingMinutes(t, {
      statusDate: options.statusDate ?? p.statusDate,
      calendar: resolver.effectiveFor(t).calendar,
    });
  const noCriticalPath = incomplete.length > 0 && !incomplete.some((t) => t.computed?.isCritical);

  const checks: ScheduleCheck[] = [
    make(
      'missing-logic',
      'tasks',
      incomplete.length,
      ids(incomplete.filter((t) => !hasPred.has(String(t.id)) || !hasSucc.has(String(t.id)))),
    ),
    make(
      'leads',
      'links',
      links.length,
      [],
      linkIds((l) => lagSign(l) < 0),
    ),
    make(
      'lags',
      'links',
      links.length,
      [],
      linkIds((l) => lagSign(l) > 0),
    ),
    make(
      'relationship-types',
      'links',
      links.length,
      [],
      linkIds((l) => l.type !== 'FS'),
    ),
    make(
      'start-to-finish',
      'links',
      links.length,
      [],
      linkIds((l) => l.type === 'SF'),
    ),
    make(
      'hard-constraints',
      'tasks',
      incomplete.length,
      ids(
        incomplete.filter((t) =>
          [t.constraint, secondaryOf(t)].some((c) => c && HARD_CONSTRAINTS.has(c.type)),
        ),
      ),
    ),
    make(
      'high-float',
      'tasks',
      incomplete.length,
      ids(incomplete.filter((t) => (t.computed?.totalSlack ?? 0) > highFloatDays * dayOf(t))),
    ),
    make(
      'negative-float',
      'tasks',
      incomplete.length,
      ids(incomplete.filter((t) => (t.computed?.totalSlack ?? 0) < 0)),
    ),
    // Remaining duration (P6 "large durations"), over all incomplete tasks.
    make(
      'high-duration',
      'tasks',
      incomplete.length,
      ids(incomplete.filter((t) => remaining(t) > highDurationDays * dayOf(t))),
    ),
    make(
      'invalid-dates',
      'tasks',
      leaves.length,
      ids(
        leaves.filter((t) => {
          if (finishOf(t) < startOf(t)) return true;
          if (status === undefined) return false;
          const notStarted = isNotStarted(t);
          const complete = isComplete(t);
          if (notStarted && startOf(t) < status) return true; // not started, forecast start passed
          if (!complete && finishOf(t) < status) return true; // unfinished, due already
          if (!notStarted && startOf(t) > status) return true; // progress on future work
          if (complete && finishOf(t) > status) return true; // finished in the future
          return false;
        }),
      ),
    ),
    // Project-level: one item, failing when nothing remaining drives the
    // finish (typically a `project.end` set beyond the natural finish).
    make('critical-path', 'project', incomplete.length > 0 ? 1 : 0, [], [], noCriticalPath ? 1 : 0),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

/** A link's lag direction, counting percent lags (row 1) by their sign. */
function lagSign(l: { lag?: number; lagPercent?: number }): number {
  return Math.sign(l.lagPercent ?? l.lag ?? 0);
}
