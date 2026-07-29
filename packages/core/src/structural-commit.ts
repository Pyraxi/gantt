import type { EditCommand, Project, Task, TaskId, TaskType } from '@pyraxi/cpm-engine';
import { EditError } from '@pyraxi/cpm-engine';
import { type StructuralEdit, svarPartialToTask } from './svar-adapter.js';

/** The gesture that produced a structural change. */
export type StructuralOp = 'add' | 'delete' | 'move' | 'indent' | 'outdent' | 'paste';

/**
 * Full post-op state of one task affected by a structural gesture. A
 * persistence-only consumer mirrors this verbatim (`parent` + `orderIndex` as
 * sort_order, `type` on flip) without re-deriving engine semantics.
 *
 * Contract invariant: `op:'delete'` ⟺ absent from the post-op project;
 * `op:'add'` ⟺ new in the post-op project; otherwise the positional gesture.
 */
export interface StructuralChange {
  id: TaskId;
  /** Canonical hierarchy pointer; null = top-level. */
  parent: TaskId | null;
  /** 0-based position among same-parent siblings in post-op array order. -1 for tombstones. */
  orderIndex: number;
  type: TaskType;
  op: StructuralOp;
}

const norm = (p: TaskId | undefined): TaskId | null => (p === undefined ? null : p);

/** 0-based position of `id` among tasks sharing its parent, in array order. */
function orderIndexOf(project: Project, id: TaskId): number {
  const self = project.tasks.find((t) => t.id === id);
  if (!self) return -1;
  let idx = 0;
  for (const t of project.tasks) {
    if (t.id === id) return idx;
    if (norm(t.parent) === norm(self.parent)) idx++;
  }
  return -1;
}

/**
 * Diff two projects around a single structural gesture into the affected-task
 * change set. `op` labels **repositioned existing** tasks; removed tasks are
 * forced `op:'delete'` and new tasks `op:'add'`, so the delete-tombstone
 * invariant holds regardless of the gesture. Deterministic order: removed
 * tasks (in prev order), then added+changed tasks (in next order).
 */
export function diffStructural(prev: Project, next: Project, op: StructuralOp): StructuralChange[] {
  const changes: StructuralChange[] = [];
  const nextIds = new Set(next.tasks.map((t) => t.id));

  // Removed → tombstones, in prev order.
  for (const t of prev.tasks) {
    if (!nextIds.has(t.id)) {
      changes.push({
        id: t.id,
        parent: norm(t.parent),
        orderIndex: -1,
        type: t.type,
        op: 'delete',
      });
    }
  }

  // Added + changed, in next order.
  const prevById = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const before = prevById.get(t.id);
    const orderIndex = orderIndexOf(next, t.id);
    if (!before) {
      changes.push({ id: t.id, parent: norm(t.parent), orderIndex, type: t.type, op: 'add' });
      continue;
    }
    const parentChanged = norm(before.parent) !== norm(t.parent);
    const typeChanged = before.type !== t.type;
    const indexChanged = orderIndexOf(prev, t.id) !== orderIndex;
    if (parentChanged || typeChanged || indexChanged) {
      changes.push({ id: t.id, parent: norm(t.parent), orderIndex, type: t.type, op });
    }
  }

  return changes;
}

/**
 * Engine surface `buildStructuralCommit` depends on — injected so the module
 * stays pure/testable without importing the whole engine barrel.
 */
export interface StructuralCommitDeps {
  schedule: (p: Project) => Project;
  createTask: (task: Task, parent?: TaskId, insertAfter?: TaskId) => EditCommand;
  deleteTask: (id: TaskId) => EditCommand;
  moveTask: (id: TaskId, direction: 'up' | 'down') => EditCommand;
  moveTaskTo: (id: TaskId, target: { parent?: TaskId; index: number }) => EditCommand;
  indentTask: (id: TaskId) => EditCommand;
  outdentTask: (id: TaskId) => EditCommand;
}

/** Op passed to `diffStructural` for repositioned existing tasks (add/delete auto-derive). */
function positionalOp(edit: StructuralEdit): StructuralOp {
  if (edit.kind === 'indent') return edit.direction === 'indent' ? 'indent' : 'outdent';
  return 'move';
}

/**
 * Resolve a raw drag-drop reorder (`target` + `before/after/child`) into the
 * `moveTaskTo` `{parent, index}` target, using the live project's sibling order.
 * `index` is the 0-based slot among the destination parent's children with the
 * dragged task excluded (matching `moveTaskTo`'s detach-then-insert semantics).
 */
function resolveReorder(
  project: Project,
  edit: { id: TaskId; target: TaskId; mode: 'before' | 'after' | 'child' },
): { parent?: TaskId; index: number } | null {
  const target = project.tasks.find((t) => t.id === edit.target);
  if (!target) return null;
  if (edit.mode === 'child') {
    const childCount = project.tasks.filter(
      (t) => t.id !== edit.id && norm(t.parent) === target.id,
    ).length;
    return { parent: target.id, index: childCount };
  }
  const newParent = target.parent;
  // Group siblings with the SAME strict predicate `moveTaskTo` uses (`t.parent
  // === newParent`), not `norm()` — mirror of the resolveAdd fix. `moveTaskTo`
  // consumes this `index`, so the grouping must match exactly; a project mixing
  // null/undefined top-level parents (CM persists a null-parent sentinel) would
  // otherwise index against a wider sibling set than the command inserts into
  // and land the drop in the wrong slot (visible half-way revert).
  const siblings = project.tasks.filter((t) => t.id !== edit.id && t.parent === newParent);
  const k = siblings.findIndex((t) => t.id === target.id);
  if (k === -1) return null;
  return { parent: newParent, index: edit.mode === 'before' ? k : k + 1 };
}

/**
 * Resolve a native SVAR add (`target` + `before`/`after`/`child` mode) into an
 * engine placement, replicating SVAR's own `add-task` reducer:
 *  - `child` (or no/unknown target): the new task nests **under** `target`
 *    (appended as its last child), or lands top-level when there's no target.
 *  - `before`/`after`: the new task is a **sibling** of `target` (shares its
 *    parent) positioned just above / below it.
 *
 * Returns `{ parent }` alone for the append cases (SVAR appends), or
 * `{ parent, index }` (0-based among the destination parent's children) for a
 * positioned sibling insert. Kept faithful to SVAR so a native add and our
 * bridged add land in the same place.
 */
export function resolveAdd(
  project: Project,
  edit: { target?: TaskId; mode?: 'before' | 'after' | 'child' },
): { parent?: TaskId; index?: number } {
  const mode = edit.mode ?? 'child';
  if (edit.target === undefined) return { parent: undefined };
  const target = project.tasks.find((t) => t.id === edit.target);
  if (!target) return { parent: undefined };
  if (mode === 'child') return { parent: edit.target };
  const parent = target.parent;
  // Group siblings with the SAME strict predicate `moveTaskTo` uses (`t.parent
  // === newParent`), not `norm()`. `moveTaskTo` consumes this `index`, so the
  // grouping must match exactly — otherwise a project mixing null/undefined
  // top-level parents (CM persists a null-parent sentinel) would compute an
  // index against a wider sibling set than the command inserts into, landing
  // the new task at the wrong slot.
  const siblings = project.tasks.filter((t) => t.parent === parent);
  const k = siblings.findIndex((t) => t.id === edit.target);
  return { parent, index: mode === 'before' ? k : k + 1 };
}

/**
 * Same SVAR add semantics as `resolveAdd`, but shaped for the thin `onTaskAdd`
 * callback's `{ parent?, insertAfter? }` contract (a task id, not a sibling
 * index). `after` → insertAfter the target; `before` → insertAfter the target's
 * previous sibling (undefined when it's already first — the consumer's
 * `createTask` then appends, the one placement this shape can't express).
 */
export function resolveAddPosition(
  project: Project,
  edit: { target?: TaskId; mode?: 'before' | 'after' | 'child' },
): { parent?: TaskId; insertAfter?: TaskId } {
  const mode = edit.mode ?? 'child';
  if (edit.target === undefined) return {};
  const target = project.tasks.find((t) => t.id === edit.target);
  if (!target) return {};
  if (mode === 'child') return { parent: edit.target };
  const parent = target.parent;
  if (mode === 'after') return { parent, insertAfter: edit.target };
  const siblings = project.tasks.filter((t) => norm(t.parent) === norm(parent));
  const k = siblings.findIndex((t) => t.id === edit.target);
  return { parent, insertAfter: k > 0 ? siblings[k - 1]?.id : undefined };
}

/**
 * Positioned add: create the task under `parent` (SVAR appends), then
 * `moveTaskTo` it to the exact sibling `index`. Composed because the engine's
 * `createTask` places by insert-after-id and can't express "prepend at index 0";
 * `moveTaskTo`'s detach-then-insert handles every slot uniformly. Not invertible
 * (buildStructuralCommit never inverts), matching `deleteSubtreeCommand`.
 */
function addPositionedCommand(
  deps: Pick<StructuralCommitDeps, 'createTask' | 'moveTaskTo'>,
  task: Task,
  parent: TaskId | undefined,
  index: number,
): EditCommand {
  return {
    kind: 'create-task-positioned',
    label: `Insert task "${task.text}"`,
    apply(p: Project): Project {
      const created = deps.createTask(task, parent).apply(p);
      return deps.moveTaskTo(task.id, { parent, index }).apply(created);
    },
    inverse(): EditCommand {
      throw new Error('create-task-positioned is not invertible');
    },
  };
}

/** `rootId` plus every descendant (transitive children), in breadth-first order. */
function collectSubtree(project: Project, rootId: TaskId): TaskId[] {
  const ids: TaskId[] = [rootId];
  const queue: TaskId[] = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift() as TaskId;
    for (const t of project.tasks) {
      if (norm(t.parent) === parentId && !ids.includes(t.id)) {
        ids.push(t.id);
        queue.push(t.id);
      }
    }
  }
  return ids;
}

/**
 * Delete a task **and its whole subtree** — the engine's `deleteTask` removes a
 * single row, which would orphan a summary's children (dangling `parent`). The
 * bolt-in contract tombstones every removed descendant, so cascade here. Applies
 * each `deleteTask` in turn; not invertible (buildStructuralCommit never inverts).
 */
function deleteSubtreeCommand(
  project: Project,
  rootId: TaskId,
  deleteTask: StructuralCommitDeps['deleteTask'],
): EditCommand {
  const ids = collectSubtree(project, rootId);
  return {
    kind: 'delete-subtree',
    label: `Delete subtree "${String(rootId)}"`,
    apply(p: Project): Project {
      let out = p;
      for (const id of ids) {
        if (out.tasks.some((t) => t.id === id)) out = deleteTask(id).apply(out);
      }
      return out;
    },
    inverse(): EditCommand {
      throw new Error('delete-subtree is not invertible');
    },
  };
}

/**
 * Map a classified `StructuralEdit` to its `EditCommand`, apply it, re-run
 * `schedule()`, and diff into a `StructuralChange[]` + the scheduled next
 * project. Returns `null` when the edit can't be built. This is the pure core
 * the Gantt wiring calls before emitting `onStructuralCommit`.
 */
export function buildStructuralCommit(
  project: Project,
  edit: StructuralEdit,
  deps: StructuralCommitDeps,
): { changes: StructuralChange[]; nextProject: Project } | null {
  // Defence-in-depth: a stale/unknown id (e.g. numeric-vs-string drift, or a row
  // that vanished mid-gesture) makes the engine command factories / `apply`
  // throw `EditError`. This runs inside SVAR's `api.intercept`, so an uncaught
  // throw would propagate through SVAR's event dispatch and crash the gesture.
  // Swallow it and return null → the caller lets SVAR handle / vetoes cleanly.
  try {
    let command: EditCommand | null = null;
    switch (edit.kind) {
      case 'delete':
        command = deleteSubtreeCommand(project, edit.id, deps.deleteTask);
        break;
      case 'move':
        command = deps.moveTask(edit.id, edit.direction);
        break;
      case 'indent':
        command =
          edit.direction === 'indent' ? deps.indentTask(edit.id) : deps.outdentTask(edit.id);
        break;
      case 'reorder': {
        const resolved = resolveReorder(project, edit);
        if (!resolved) return null;
        command = deps.moveTaskTo(edit.id, resolved);
        break;
      }
      case 'add': {
        const full = svarPartialToTask(edit.task, project.start);
        const { parent, index } = resolveAdd(project, edit);
        command =
          index === undefined
            ? deps.createTask(full, parent)
            : addPositionedCommand(deps, full, parent, index);
        break;
      }
    }
    if (!command) return null;
    const nextProject = deps.schedule(command.apply(project));
    const changes = diffStructural(project, nextProject, positionalOp(edit));
    return { changes, nextProject };
  } catch (err) {
    if (err instanceof EditError) return null;
    throw err;
  }
}
