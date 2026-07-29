import type { DependencyType, Link, LinkId, Project, Task, TaskId, TaskSegment } from '../types.js';
import {
  CreateLinkCommand,
  CreateTaskCommand,
  DeleteLinkCommand,
  DeleteTaskCommand,
  type EditCommand,
  MoveTaskCommand,
  MoveTaskToCommand,
  ReparentTaskCommand,
  UpdateLinkCommand,
  UpdateTaskCommand,
} from './commands.js';
import { promoteParentIfLeaf } from './hierarchy.js';

/**
 * Ergonomic factory functions for constructing edit commands with
 * descriptive labels. Consumers call these instead of `new
 * UpdateTaskCommand(...)` so undo UI shows "Rename task to 'Foundation'"
 * rather than the generic "Update task 'a' (text)".
 */

// Re-exported (imported above for internal use in createTask) from the leaf
// `hierarchy.ts` module, which both this file and commands.ts import without
// forming a cycle. Kept on the factories surface because tests + the add-child
// promotion path reference it here.
export { promoteParentIfLeaf };

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

export function createTask(task: Task, parent?: TaskId, insertAfter?: TaskId): EditCommand {
  const withParent = parent !== undefined ? { ...task, parent } : task;
  const label =
    insertAfter === undefined ? `Create task "${task.text}"` : `Insert task "${task.text}"`;
  return {
    kind: 'create-task',
    label,
    apply(project: Project): Project {
      // Capture whether the target parent is a leaf we will promote, so the
      // inverse can demote it back on undo (round-trip correctness).
      const parentWasLeaf =
        parent !== undefined && project.tasks.find((t) => t.id === parent)?.type === 'task';
      let next: Project;
      if (insertAfter === undefined) {
        next = new CreateTaskCommand(withParent).apply(project);
      } else {
        const afterIdx = project.tasks.findIndex((t) => t.id === insertAfter);
        const insertAt = afterIdx === -1 ? project.tasks.length : afterIdx + 1;
        next = new CreateTaskCommand(withParent, insertAt).apply(project);
      }
      next = promoteParentIfLeaf(next, parent);
      (this as { _promoted?: boolean })._promoted = parentWasLeaf;
      return next;
    },
    inverse(_project: Project): EditCommand {
      const promoted = (this as { _promoted?: boolean })._promoted === true;
      const childId = withParent.id;
      const parentId = parent;
      return {
        kind: 'delete-task',
        label: `Delete task "${String(childId)}"`,
        apply(p: Project): Project {
          let out = new DeleteTaskCommand(childId).apply(p);
          if (promoted && parentId !== undefined) {
            const stillHasKids = out.tasks.some((t) => t.parent === parentId);
            if (!stillHasKids) {
              out = {
                ...out,
                tasks: out.tasks.map((t) =>
                  t.id === parentId ? { ...t, type: 'task' as const } : t,
                ),
              };
            }
          }
          return out;
        },
        inverse(_p: Project): EditCommand {
          return createTask(task, parent, insertAfter);
        },
      };
    },
  };
}

export function deleteTask(id: TaskId): EditCommand {
  return new DeleteTaskCommand(id);
}

export function moveTask(id: TaskId, direction: 'up' | 'down'): EditCommand {
  return new MoveTaskCommand(id, direction);
}

/**
 * Positional move: reparent `id` to `target.parent` (undefined = top-level) and
 * place it as the `target.index`-th (0-based, clamped) child among tasks sharing
 * that parent. Promotes a leaf new-parent to summary and demotes a now-childless
 * old parent to task. Unlike `moveTask` (sibling-constrained up/down), this sets
 * both parent and sibling index in one command — the bolt-in drag-reorder bridge
 * (ADR-010 P1.2) translates a row-drop into this.
 */
export function moveTaskTo(id: TaskId, target: { parent?: TaskId; index: number }): EditCommand {
  return new MoveTaskToCommand(id, target);
}

export function indentTask(id: TaskId): EditCommand {
  return new ReparentTaskCommand(id, 'indent');
}

export function outdentTask(id: TaskId): EditCommand {
  return new ReparentTaskCommand(id, 'outdent');
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
