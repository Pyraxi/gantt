// Analysis helpers — consumer-facing summary queries over a scheduled
// Project. Useful for dashboards, management-focus views, and CI-style
// programme-health checks.
//
// Assumes the project has been through `schedule()` (tasks have
// `computed` populated). If not, the helpers return safe defaults
// rather than throwing.

import type { Project, Task } from './types';

/**
 * Return the critical-path leaf tasks (summary tasks excluded), ordered
 * by `earlyStart` ascending. A construction PM reading this list is
 * looking at "the tasks that, if any of them slip, the contract finish
 * slips."
 *
 * The list mirrors what `task.computed.isCritical` says — i.e., includes
 * tasks with negative total slack (already-late tasks).
 */
export function getCriticalPath(project: Project): Task[] {
  const leaves = project.tasks.filter((t) => t.type !== 'summary');
  const critical = leaves.filter((t) => t.computed?.isCritical === true);
  return critical.slice().sort((a, b) => {
    const aTime = a.computed?.earlyStart.getTime() ?? 0;
    const bTime = b.computed?.earlyStart.getTime() ?? 0;
    return aTime - bTime;
  });
}

export interface ProjectStats {
  /** Leaf task count (summaries excluded). */
  totalTasks: number;
  /** Leaf tasks on the critical path (totalSlack <= 0). */
  criticalTasks: number;
  /** Leaf tasks with strictly negative totalSlack (the contract-trouble subset). */
  lateTasks: number;
  /** Latest earlyFinish across leaf tasks. Project's natural finish date. */
  projectFinish?: Date;
  /** Duration-weighted average progress across leaf tasks. 0 if no tasks. */
  weightedProgress: number;
}

/**
 * Summary statistics over a scheduled Project. Useful for status
 * dashboards, programme-health badges in management views, and CI
 * checks that flag "did the critical path grow this commit?".
 */
export function getProjectStats(project: Project): ProjectStats {
  const leaves = project.tasks.filter((t) => t.type !== 'summary');
  if (leaves.length === 0) {
    return {
      totalTasks: 0,
      criticalTasks: 0,
      lateTasks: 0,
      weightedProgress: 0,
    };
  }

  let criticalTasks = 0;
  let lateTasks = 0;
  let projectFinishMs = Number.NEGATIVE_INFINITY;
  let totalDuration = 0;
  let progressDurationProduct = 0;

  for (const t of leaves) {
    if (t.computed?.isCritical) criticalTasks++;
    if ((t.computed?.totalSlack ?? 0) < 0) lateTasks++;
    const finish = t.computed?.earlyFinish?.getTime() ?? t.end.getTime();
    if (finish > projectFinishMs) projectFinishMs = finish;
    totalDuration += t.duration;
    progressDurationProduct += t.duration * t.progress;
  }

  const weightedProgress = totalDuration > 0 ? progressDurationProduct / totalDuration : 0;

  return {
    totalTasks: leaves.length,
    criticalTasks,
    lateTasks,
    projectFinish: Number.isFinite(projectFinishMs) ? new Date(projectFinishMs) : undefined,
    weightedProgress,
  };
}
