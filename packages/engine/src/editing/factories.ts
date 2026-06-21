import type { DependencyType, Link, LinkId, Task, TaskId, TaskSegment } from '../types.js';
import {
  CreateLinkCommand,
  CreateTaskCommand,
  DeleteLinkCommand,
  DeleteTaskCommand,
  type EditCommand,
  UpdateLinkCommand,
  UpdateTaskCommand,
} from './commands.js';

/**
 * Ergonomic factory functions for constructing edit commands with
 * descriptive labels. Consumers call these instead of `new
 * UpdateTaskCommand(...)` so undo UI shows "Rename task to 'Foundation'"
 * rather than the generic "Update task 'a' (text)".
 */

export function renameTask(id: TaskId, text: string): EditCommand {
  return new UpdateTaskCommand(id, { text }, `Rename task to "${text}"`);
}

export function setTaskStart(id: TaskId, start: Date): EditCommand {
  return new UpdateTaskCommand(id, { start }, `Move task "${String(id)}" (Start)`);
}

export function setTaskDuration(id: TaskId, minutes: number): EditCommand {
  return new UpdateTaskCommand(
    id,
    { duration: minutes },
    `Change duration of task "${String(id)}"`,
  );
}

export function setTaskProgress(id: TaskId, percent: number): EditCommand {
  return new UpdateTaskCommand(
    id,
    { progress: percent },
    `Update progress of task "${String(id)}" to ${percent}%`,
  );
}

export function updateTask(id: TaskId, patch: Partial<Task>): EditCommand {
  return new UpdateTaskCommand(id, patch);
}

export function createTask(task: Task, _parent?: TaskId, _insertAfter?: TaskId): EditCommand {
  // _parent and _insertAfter are accepted at the public surface but not
  // wired into the underlying CreateTaskCommand in v0.4 foundation —
  // hierarchy reordering and parent-changes are downstream concerns.
  return new CreateTaskCommand(task);
}

export function deleteTask(id: TaskId): EditCommand {
  return new DeleteTaskCommand(id);
}

/**
 * Creates a CreateLinkCommand with a **deterministic** link id derived
 * from `${source}->${target}`. This means calling `linkTasks('a', 'b')`
 * twice produces the same id — and the second `apply()` will throw
 * `EditError: duplicate link id`. By design: duplicate enqueues are a
 * consumer bug we surface loudly rather than silently coalesce.
 *
 * Consumers who legitimately need to re-add a previously-deleted link
 * (e.g. delete A→B, then re-create it without bringing the deleted one
 * back via undo) should use `new CreateLinkCommand({ id: customId, … })`
 * directly with a fresh id.
 */
export function linkTasks(
  source: TaskId,
  target: TaskId,
  type: DependencyType = 'FS',
  lag = 0,
): EditCommand {
  const link: Link = {
    id: `${String(source)}->${String(target)}` as LinkId,
    source,
    target,
    type,
    lag,
  };
  return new CreateLinkCommand(link);
}

export function updateLink(id: LinkId, patch: Partial<Link>): EditCommand {
  return new UpdateLinkCommand(id, patch);
}

export function deleteLink(id: LinkId): EditCommand {
  return new DeleteLinkCommand(id);
}

// ---------------------------------------------------------------------------
// ADR-007: split-task + unscheduled-task factories
// ---------------------------------------------------------------------------

/**
 * Set the task's split segments, converting a contiguous task into a split
 * task rendered as multiple bar rectangles with connectors across the gaps
 * (via SVAR's native splitTasks support). The caller is responsible for
 * providing valid non-overlapping segments in chronological order.
 *
 * @remarks **Manual-mode precondition (ADR-007):** splits are only honoured by
 * the scheduling engine when the task has `scheduleMode: 'manual'`. On an
 * `auto`-mode task the segments patch is accepted by the command but the
 * scheduler ignores the `segments` field and re-derives bounds from the
 * forward pass. Always set `scheduleMode: 'manual'` before or alongside
 * calling `splitTask`.
 *
 * Undo: restores the previous `segments` value (including undefined).
 */
export function splitTask(id: TaskId, segments: TaskSegment[]): EditCommand {
  return new UpdateTaskCommand(id, { segments }, `Split task "${String(id)}"`);
}

/**
 * Clear a task's segments, reverting it to a contiguous task. The task's
 * `start`, `end`, and `duration` are not touched — the caller should update
 * those to reflect the merged contiguous span.
 *
 * Undo: restores the previous `segments` value.
 */
export function unsetSplit(id: TaskId): EditCommand {
  return new UpdateTaskCommand(
    id,
    { segments: undefined },
    `Remove split from task "${String(id)}"`,
  );
}

/**
 * Set or clear the `unscheduled` flag on a task. When true, the task is
 * excluded from the forward/backward pass, rendered in the grid but not the
 * timeline, and contributes nothing to summary aggregation or critical path
 * (per ADR-007).
 *
 * Undo: restores the previous `unscheduled` value.
 */
export function setUnscheduled(id: TaskId, value: boolean): EditCommand {
  return new UpdateTaskCommand(
    id,
    { unscheduled: value },
    `${value ? 'Mark' : 'Unmark'} task "${String(id)}" as unscheduled`,
  );
}
