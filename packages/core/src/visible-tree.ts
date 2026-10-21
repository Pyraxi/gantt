// Render-side companion to the engine's `filterTasksByVisibility` (ADR-005).
// SVAR builds its tree from `parent`; a task whose parent isn't rendered is
// attached to no node and silently disappears. The contract is that every
// matching task renders, so an orphan is re-rooted under its nearest visible
// ancestor (or the top level). Render-only: structural edits resolve against
// the full project, never these rows' `parent`.
import type { Task, TaskId } from '@pyraxi/cpm-engine';

/**
 * `visible` with each orphan's `parent` moved to its nearest visible ancestor
 * in `all`, or removed (top level). Untouched tasks keep their identity, and
 * with no orphan the same array is returned.
 */
export function reRootOrphans(visible: Task[], all: readonly Task[]): Task[] {
  const shown = new Set(visible.map((t) => String(t.id)));
  const parentOf = new Map<string, TaskId | undefined>(
    all.map((t) => [String(t.id), t.parent ?? undefined]),
  );
  let changed = false;
  const out = visible.map((t) => {
    const self = String(t.parent) === String(t.id); // SVAR never attaches a self-parent
    if (t.parent === undefined || t.parent === null || (shown.has(String(t.parent)) && !self))
      return t;
    // Walk up through hidden ancestors; a parent cycle stops at the first repeat.
    const seen = new Set<string>([String(t.id)]);
    let p: TaskId | undefined = t.parent;
    while (p !== undefined && !shown.has(String(p)) && !seen.has(String(p))) {
      seen.add(String(p));
      p = parentOf.get(String(p));
    }
    // A cycle walks back to the task itself: that is no parent, not a self-parent.
    const parent =
      p !== undefined && String(p) !== String(t.id) && shown.has(String(p)) ? p : undefined;
    changed = true;
    const { parent: _hidden, ...rest } = t;
    return parent === undefined ? (rest as Task) : { ...rest, parent };
  });
  return changed ? out : visible;
}

/**
 * Whether a structural result files a task under a parent the user can't see
 * (filtered out by `visibleTaskIds`). Only a *new* placement counts: a task
 * whose parent is unchanged (e.g. a hidden summary demoted as a side effect)
 * passes. No filter → never.
 */
export function placesUnderHidden(
  /** `id` undefined: a new task (no parent before). */
  changes: readonly { id?: TaskId; parent: TaskId | null | undefined }[],
  before: readonly Task[],
  visible: ReadonlySet<TaskId> | undefined,
): boolean {
  if (visible === undefined) return false;
  const shown = new Set([...visible].map(String));
  const parentBefore = new Map(before.map((t) => [String(t.id), t.parent ?? null]));
  return changes.some((c) => {
    if (c.parent === null || c.parent === undefined || shown.has(String(c.parent))) return false;
    const was = c.id === undefined ? undefined : parentBefore.get(String(c.id));
    return was === undefined || String(was) !== String(c.parent);
  });
}
