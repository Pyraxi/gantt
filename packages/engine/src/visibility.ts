// Render-only visibility filter for <Gantt> tasks.
//
// Per ADR-005 (engine-first; no BYO-CPM mode), consumer domain rules around
// hiding tasks must surface as render-time props, never as engine bypasses.
// This is the canonical example: the engine always runs on the full task
// set; the visibility filter applies only to the rendered output.
//
// The filter sits AFTER schedule() in the pipeline so computed fields on
// the visible tasks reflect the full schedule — hiding a predecessor must
// not cause a dependent task's early-start to collapse to 0.

import type { Task, TaskId } from './types.js';

/**
 * Return the subset of `tasks` whose ids appear in `visibleTaskIds`.
 *
 * - `undefined` → no filter; the original array reference is returned
 *   so React's `useMemo` identity stays stable on the noop path.
 * - empty set → returns an empty array (hide everything).
 * - set containing ids not present in `tasks` → unknown ids ignored;
 *   only matching tasks survive.
 *
 * Crucially: this is a pure projection. `task.computed` is preserved
 * exactly — no recomputation, no clipping, no slack adjustment. The
 * engine already ran on the full set; we trust its result.
 */
export function filterTasksByVisibility(
  tasks: Task[],
  visibleTaskIds: ReadonlySet<TaskId> | undefined,
): Task[] {
  if (visibleTaskIds === undefined) return tasks;
  return tasks.filter((t) => visibleTaskIds.has(t.id));
}
