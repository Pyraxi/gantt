import type { Link, LinkId, Project, Task, TaskId, TaskType } from '../types.js';
import { EditError } from './errors.js';
import { promoteParentIfLeaf } from './hierarchy.js';

/**
 * The contract every edit command must satisfy. apply must be pure
 * (no mutation, no I/O) — returns a new Project. inverse(project)
 * captures the state needed to reverse the edit when applied to the
 * post-edit Project.
 *
 * Per ADR-006: every edit flows through schedule() recompute at the
 * hook layer, not inside apply(). Commands operate on raw data only.
 */
export interface EditCommand {
  /** Discriminator for command kind. */
  readonly kind: string;
  /** Human-readable label for UI undo text (e.g. "Rename Foundation pour"). */
  readonly label: string;
  /** Pure: applies the edit to a Project, returning a new Project. Throws EditError on invalid input. */
  apply(project: Project): Project;
  /**
   * Returns an inverse command: applying inverse(P) on apply(P) yields P.
   *
   * Pre-edit state capture timing varies by command kind:
   * - Create*Command: constructor argument is the inverse's only input
   * - Update*Command, Delete*Command: snapshot pre-state internally during
   *   apply() (single-use per instance). The `project` argument is
   *   accepted for interface consistency but ignored.
   *
   * Consumers (CompositeCommand, CommandHistory) only need to call apply()
   * before inverse() and pass the current project to inverse().
   */
  inverse(project: Project): EditCommand;
}

export class CreateTaskCommand implements EditCommand {
  readonly kind = 'create-task';
  readonly label: string;

  constructor(
    private readonly task: Task,
    private readonly insertAt?: number,
  ) {
    this.label = `Create task "${task.text}"`;
  }

  apply(project: Project): Project {
    if (project.tasks.some((t) => t.id === this.task.id)) {
      throw new EditError(`duplicate task id ${String(this.task.id)}`, this.kind);
    }
    const tasks = [...project.tasks];
    if (this.insertAt === undefined) {
      tasks.push(this.task);
    } else {
      tasks.splice(this.insertAt, 0, this.task);
    }
    return { ...project, tasks };
  }

  inverse(_project: Project): EditCommand {
    return new DeleteTaskCommand(this.task.id);
  }
}

export class UpdateTaskCommand implements EditCommand {
  readonly kind = 'update-task';
  readonly label: string;
  // Snapshot the pre-edit task state during apply() rather than reading it
  // in inverse(project). Required because the patched fields in `project`
  // at inverse() time are the post-edit values; the originals only survive
  // via this capture. Side effect: each command instance is effectively
  // single-use — calling apply() twice overwrites the snapshot, which
  // is fine for the redo-then-undo flow but means consumers should not
  // share a command instance across unrelated apply-sites.
  private originalTask?: Task;

  constructor(
    private readonly taskId: TaskId,
    private readonly patch: Partial<Task>,
    customLabel?: string,
  ) {
    if (customLabel !== undefined) {
      this.label = customLabel;
    } else {
      const keys = Object.keys(patch);
      this.label =
        keys.length === 1
          ? `Update task "${String(taskId)}" (${keys[0]})`
          : `Update task "${String(taskId)}"`;
    }
  }

  apply(project: Project): Project {
    const idx = project.tasks.findIndex((t) => t.id === this.taskId);
    if (idx === -1) {
      throw new EditError(`missing task ${String(this.taskId)}`, this.kind);
    }
    const tasks = [...project.tasks];
    this.originalTask = tasks[idx];
    tasks[idx] = Object.assign({}, tasks[idx], this.patch);
    return { ...project, tasks };
  }

  inverse(_project: Project): EditCommand {
    if (!this.originalTask) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    // Capture the value of each patched key from the original task.
    const previousPatch: Partial<Task> = {};
    for (const key of Object.keys(this.patch)) {
      const k = key as keyof Task;
      (previousPatch as Record<keyof Task, unknown>)[k] = (
        this.originalTask as Record<keyof Task, unknown>
      )[k];
    }
    return new UpdateTaskCommand(this.taskId, previousPatch);
  }
}

export class DeleteTaskCommand implements EditCommand {
  readonly kind = 'delete-task';
  readonly label: string;
  // Snapshot pre-state during apply() — same pattern as UpdateTaskCommand.
  // Required because CommandHistory.undo calls cmd.inverse(currentProject)
  // where currentProject is the POST-delete state (no longer has the task
  // or its incident links to read from).
  private snapshot?: {
    task: Task;
    taskIndex: number;
    // Captured as (linkIndex, link) pairs to restore at original positions.
    incidentLinkPositions: Array<[number, Link]>;
  };

  constructor(private readonly taskId: TaskId) {
    this.label = `Delete task "${String(taskId)}"`;
  }

  apply(project: Project): Project {
    const target = project.tasks.find((t) => t.id === this.taskId);
    if (!target) {
      throw new EditError(`missing task ${String(this.taskId)}`, this.kind);
    }
    const taskIndex = project.tasks.indexOf(target);
    // Capture incident links with their original indices.
    const incidentLinkPositions: Array<[number, Link]> = [];
    for (let i = 0; i < project.links.length; i++) {
      const link = project.links[i];
      if (link && (link.source === this.taskId || link.target === this.taskId)) {
        incidentLinkPositions.push([i, link]);
      }
    }
    this.snapshot = { task: target, taskIndex, incidentLinkPositions };

    const tasks = project.tasks.filter((t) => t.id !== this.taskId);
    const links = project.links.filter((l) => l.source !== this.taskId && l.target !== this.taskId);
    return { ...project, tasks, links };
  }

  inverse(_project: Project): EditCommand {
    if (!this.snapshot) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    const snapshotData = this.snapshot;
    const { task: snapshotTask, taskIndex, incidentLinkPositions } = snapshotData;

    // Return an ad-hoc EditCommand that restores both task + links atomically.
    // Not exported — only reachable as the inverse of DeleteTaskCommand.
    const restoreCommand: EditCommand = {
      kind: 'restore-task',
      label: `Restore task "${String(this.taskId)}"`,
      apply(p: Project): Project {
        if (p.tasks.some((t) => t.id === snapshotTask.id)) {
          throw new EditError(`duplicate task id ${String(snapshotTask.id)}`, 'restore-task');
        }
        // Restore task at original index (clamped to current length).
        const tasks = [...p.tasks];
        const insertTaskAt = Math.min(taskIndex, tasks.length);
        tasks.splice(insertTaskAt, 0, snapshotTask);

        // Restore links at their original indices, adjusting for deletions.
        // INVARIANT: incidentLinkPositions is guaranteed ascending-by-index
        // because the capture loop in apply() walks 0..N. Splice-in-place
        // only produces the correct final order when fed sorted-ascending
        // positions — if a future refactor breaks the capture order, this
        // restoration breaks silently. If insertion order ever becomes
        // unsortable, switch to a single-pass rebuild keyed on original idx.
        const links = [...p.links];
        for (const [originalIdx, link] of incidentLinkPositions) {
          links.splice(originalIdx, 0, link);
        }

        return {
          ...p,
          tasks,
          links,
        };
      },
      inverse(_p: Project): EditCommand {
        return new DeleteTaskCommand(snapshotTask.id);
      },
    };
    return restoreCommand;
  }
}

export class CreateLinkCommand implements EditCommand {
  readonly kind = 'create-link';
  readonly label: string;

  constructor(private readonly link: Link) {
    this.label = `Link ${String(link.source)} → ${String(link.target)}`;
  }

  apply(project: Project): Project {
    if (this.link.source === this.link.target) {
      throw new EditError(`self-link not allowed (${String(this.link.source)})`, this.kind);
    }
    if (project.links.some((l) => l.id === this.link.id)) {
      throw new EditError(`duplicate link id ${String(this.link.id)}`, this.kind);
    }
    if (!project.tasks.some((t) => t.id === this.link.source)) {
      throw new EditError(`source task ${String(this.link.source)} not found`, this.kind);
    }
    if (!project.tasks.some((t) => t.id === this.link.target)) {
      throw new EditError(`target task ${String(this.link.target)} not found`, this.kind);
    }
    return { ...project, links: [...project.links, this.link] };
  }

  inverse(_project: Project): EditCommand {
    return new DeleteLinkCommand(this.link.id);
  }
}

export class UpdateLinkCommand implements EditCommand {
  readonly kind = 'update-link';
  readonly label: string;
  // Snapshot pre-edit link state during apply() — same pattern as
  // UpdateTaskCommand. Required for snapshot-at-apply inverse semantics.
  private originalLink?: Link;

  constructor(
    private readonly linkId: LinkId,
    private readonly patch: Partial<Link>,
    customLabel?: string,
  ) {
    this.label = customLabel ?? `Update link "${String(linkId)}"`;
  }

  apply(project: Project): Project {
    const target = project.links.find((l) => l.id === this.linkId);
    if (!target) {
      throw new EditError(`missing link ${String(this.linkId)}`, this.kind);
    }
    const idx = project.links.indexOf(target);
    const links = [...project.links];
    this.originalLink = target;
    links[idx] = Object.assign({}, target, this.patch);
    return { ...project, links };
  }

  inverse(_project: Project): EditCommand {
    if (!this.originalLink) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    const previousPatch: Partial<Link> = {};
    for (const key of Object.keys(this.patch)) {
      const k = key as keyof Link;
      (previousPatch as Record<keyof Link, unknown>)[k] = (
        this.originalLink as Record<keyof Link, unknown>
      )[k];
    }
    return new UpdateLinkCommand(this.linkId, previousPatch);
  }
}

export class DeleteLinkCommand implements EditCommand {
  readonly kind = 'delete-link';
  readonly label: string;
  // Snapshot link + original index during apply() so inverse restores at
  // its original position in the array (preserving order).
  private snapshot?: { link: Link; linkIndex: number };

  constructor(private readonly linkId: LinkId) {
    this.label = `Delete link "${String(linkId)}"`;
  }

  apply(project: Project): Project {
    const target = project.links.find((l) => l.id === this.linkId);
    if (!target) {
      throw new EditError(`missing link ${String(this.linkId)}`, this.kind);
    }
    const linkIndex = project.links.indexOf(target);
    this.snapshot = { link: target, linkIndex };
    return {
      ...project,
      links: project.links.filter((l) => l.id !== this.linkId),
    };
  }

  inverse(_project: Project): EditCommand {
    if (!this.snapshot) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    const { link: snapshotLink, linkIndex } = this.snapshot;
    const linkId = this.linkId;
    // Ad-hoc 'restore-link' command — not exported. Unlike DeleteTaskCommand's
    // 'restore-task' (which also restores incident links), a link has no
    // incident dependencies — just re-insert it at its original index.
    const restoreCommand: EditCommand = {
      kind: 'restore-link',
      label: `Restore link "${String(linkId)}"`,
      apply(p: Project): Project {
        if (p.links.some((l) => l.id === snapshotLink.id)) {
          throw new EditError(`duplicate link id ${String(snapshotLink.id)}`, 'restore-link');
        }
        const links = [...p.links];
        const insertAt = Math.min(linkIndex, links.length);
        links.splice(insertAt, 0, snapshotLink);
        return { ...p, links };
      },
      inverse(_p: Project): EditCommand {
        return new DeleteLinkCommand(snapshotLink.id);
      },
    };
    return restoreCommand;
  }
}

export class MoveTaskCommand implements EditCommand {
  readonly kind = 'move-task';
  readonly label: string;
  private movedFrom?: { fromIndex: number; toIndex: number };

  constructor(
    private readonly taskId: TaskId,
    private readonly direction: 'up' | 'down',
  ) {
    this.label = `Move task "${String(taskId)}" ${direction}`;
  }

  apply(project: Project): Project {
    const fromIndex = project.tasks.findIndex((t) => t.id === this.taskId);
    if (fromIndex === -1) {
      throw new EditError(`missing task ${String(this.taskId)}`, this.kind);
    }
    const self = project.tasks[fromIndex] as Task;
    const parent = self.parent;
    // Nearest sibling (same parent) in the chosen direction.
    let siblingIndex = -1;
    if (this.direction === 'up') {
      for (let i = fromIndex - 1; i >= 0; i--) {
        if (project.tasks[i]?.parent === parent) {
          siblingIndex = i;
          break;
        }
      }
    } else {
      for (let i = fromIndex + 1; i < project.tasks.length; i++) {
        if (project.tasks[i]?.parent === parent) {
          siblingIndex = i;
          break;
        }
      }
    }
    if (siblingIndex === -1) return project; // boundary: no-op
    const tasks = [...project.tasks];
    const [moved] = tasks.splice(fromIndex, 1);
    // After removal, recompute the sibling's index and insert before (up) / after (down).
    const targetId = project.tasks[siblingIndex]?.id;
    const newSiblingIndex = tasks.findIndex((t) => t.id === targetId);
    const insertAt = this.direction === 'up' ? newSiblingIndex : newSiblingIndex + 1;
    tasks.splice(insertAt, 0, moved as Task);
    this.movedFrom = { fromIndex, toIndex: insertAt };
    return { ...project, tasks };
  }

  inverse(_project: Project): EditCommand {
    if (!this.movedFrom) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    const { fromIndex } = this.movedFrom;
    const taskId = this.taskId;
    const direction = this.direction;
    // Ad-hoc 'restore-move' command — not exported. A direction flip
    // ('up'<->'down') is NOT a valid inverse: if the moved task has
    // children, a single "down" past a summary carries its subtree along,
    // and a plain flip lands the task one sibling-slot short of its
    // original position (see commands.ts:21 round-trip contract). Instead,
    // restore the task to its exact original array index captured by
    // apply() in this.movedFrom.
    const restoreCommand: EditCommand = {
      kind: 'restore-move',
      label: `Restore task "${String(taskId)}" position`,
      apply(p: Project): Project {
        const idx = p.tasks.findIndex((t) => t.id === taskId);
        if (idx === -1) {
          throw new EditError(`missing task ${String(taskId)}`, 'restore-move');
        }
        const tasks = [...p.tasks];
        const [moved] = tasks.splice(idx, 1);
        const insertAt = Math.min(fromIndex, tasks.length);
        tasks.splice(insertAt, 0, moved as Task);
        return { ...p, tasks };
      },
      inverse(_p: Project): EditCommand {
        return new MoveTaskCommand(taskId, direction);
      },
    };
    return restoreCommand;
  }
}

export class MoveTaskToCommand implements EditCommand {
  readonly kind = 'move-task-to';
  readonly label: string;
  // Snapshot for round-trip inverse: original array index, original parent,
  // and the pre-op type of every parent this move mutated (new + old).
  private snapshot?: {
    fromIndex: number;
    prevParent: TaskId | undefined;
    prevTypes: Array<[TaskId, TaskType]>;
  };

  constructor(
    private readonly taskId: TaskId,
    private readonly target: { parent?: TaskId; index: number },
  ) {
    this.label = `Move task "${String(taskId)}"`;
  }

  apply(project: Project): Project {
    const fromIndex = project.tasks.findIndex((t) => t.id === this.taskId);
    if (fromIndex === -1) {
      throw new EditError(`missing task ${String(this.taskId)}`, this.kind);
    }
    const self = project.tasks[fromIndex] as Task;
    const prevParent = self.parent;
    const newParent = this.target.parent;

    // Cycle guard: reject moving a task under itself or one of its own
    // descendants — that would persist a parent cycle (this command is the
    // ADR-010 drag-reorder bridge target, so a bad SVAR drop payload would
    // otherwise write a `parent` cycle straight into the consumer's DB with no
    // engine-side backstop). Walking `newParent`'s ancestor chain reaches
    // `taskId` iff the destination is inside the moved task's subtree.
    if (newParent !== undefined) {
      const parentById = new Map(project.tasks.map((t) => [t.id, t.parent]));
      const seen = new Set<TaskId>();
      let ancestor: TaskId | undefined = newParent;
      while (ancestor !== undefined) {
        if (ancestor === this.taskId) {
          throw new EditError('cannot move a task under itself or its descendant', this.kind);
        }
        if (seen.has(ancestor)) break; // don't loop on a pre-existing cycle
        seen.add(ancestor);
        ancestor = parentById.get(ancestor);
      }
    }

    // 1. Detach the task and reparent it.
    const detached = project.tasks.filter((t) => t.id !== this.taskId);
    const moved: Task = { ...self, parent: newParent };

    // 2. Find the insertion array-index: position it as the target.index-th
    //    child among tasks sharing newParent (0-based, clamped). No siblings
    //    → place immediately after the parent task, or at array end for
    //    top-level with no siblings.
    const siblingArrayIdxs = detached
      .map((t, i) => (t.parent === newParent ? i : -1))
      .filter((i) => i !== -1);
    let insertAt: number;
    if (siblingArrayIdxs.length === 0) {
      const parentIdx =
        newParent === undefined ? -1 : detached.findIndex((t) => t.id === newParent);
      insertAt = parentIdx === -1 ? detached.length : parentIdx + 1;
    } else {
      const clamped = Math.min(Math.max(this.target.index, 0), siblingArrayIdxs.length);
      insertAt =
        clamped === siblingArrayIdxs.length
          ? (siblingArrayIdxs[clamped - 1] as number) + 1
          : (siblingArrayIdxs[clamped] as number);
    }
    const tasks = [...detached];
    tasks.splice(insertAt, 0, moved);
    let next: Project = { ...project, tasks };

    // 3. Promote a leaf new-parent; demote a now-childless old parent.
    const prevTypes: Array<[TaskId, TaskType]> = [];
    if (newParent !== undefined) {
      const np = next.tasks.find((t) => t.id === newParent);
      if (np) prevTypes.push([newParent, np.type]);
      next = promoteParentIfLeaf(next, newParent);
    }
    if (prevParent !== undefined && prevParent !== newParent) {
      const op = next.tasks.find((t) => t.id === prevParent);
      const stillHasKids = next.tasks.some((t) => t.parent === prevParent);
      if (op && !stillHasKids) {
        prevTypes.push([prevParent, op.type]);
        next = {
          ...next,
          tasks: next.tasks.map((t) => (t.id === prevParent ? { ...t, type: 'task' as const } : t)),
        };
      }
    }

    this.snapshot = { fromIndex, prevParent, prevTypes };
    return next;
  }

  inverse(_project: Project): EditCommand {
    if (!this.snapshot) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    const { fromIndex, prevParent, prevTypes } = this.snapshot;
    const taskId = this.taskId;
    return {
      kind: 'move-task-to-restore',
      label: `Restore task "${String(taskId)}" position`,
      apply(p: Project): Project {
        const idx = p.tasks.findIndex((t) => t.id === taskId);
        if (idx === -1) {
          throw new EditError(`missing task ${String(taskId)}`, 'move-task-to-restore');
        }
        // Restore parent + original array index.
        const detached = p.tasks.filter((t) => t.id !== taskId);
        const moved: Task = { ...(p.tasks[idx] as Task), parent: prevParent };
        const tasks = [...detached];
        tasks.splice(Math.min(fromIndex, tasks.length), 0, moved);
        // Restore the pre-op type of every parent the forward move mutated.
        const restoredTypes = tasks.map((t) => {
          const hit = prevTypes.find(([id]) => id === t.id);
          return hit ? { ...t, type: hit[1] } : t;
        });
        return { ...p, tasks: restoredTypes };
      },
      inverse(_p: Project): EditCommand {
        throw new EditError('move-task-to-restore is not re-invertible', 'move-task-to-restore');
      },
    };
  }
}

export class ReparentTaskCommand implements EditCommand {
  readonly kind = 'reparent-task';
  readonly label: string;
  private prevParent?: TaskId;
  // Pre-op type of every parent this reparent promoted/demoted, so the inverse
  // can restore them — indent promotes the new parent to `summary`, outdent
  // demotes a now-childless old parent to `task`. Same snapshot discipline as
  // MoveTaskToCommand.prevTypes.
  private prevTypes: Array<[TaskId, TaskType]> = [];
  private applied = false;

  constructor(
    private readonly taskId: TaskId,
    private readonly mode: 'indent' | 'outdent',
  ) {
    this.label = `${mode === 'indent' ? 'Indent' : 'Outdent'} task "${String(taskId)}"`;
  }

  apply(project: Project): Project {
    const idx = project.tasks.findIndex((t) => t.id === this.taskId);
    if (idx === -1) throw new EditError(`missing task ${String(this.taskId)}`, this.kind);
    const self = project.tasks[idx] as Task;
    this.prevParent = self.parent;
    this.prevTypes = [];
    this.applied = true;

    let newParent: TaskId | undefined;
    if (this.mode === 'indent') {
      // preceding sibling (same current parent)
      let sib: Task | undefined;
      for (let i = idx - 1; i >= 0; i--) {
        const t = project.tasks[i];
        if (t?.parent === self.parent) {
          sib = t;
          break;
        }
      }
      if (!sib) return project; // no-op
      newParent = sib.id;
    } else {
      if (self.parent === undefined) return project; // no-op
      const parentTask = project.tasks.find((t) => t.id === self.parent);
      newParent = parentTask?.parent; // grandparent (or undefined = top level)
    }

    let tasks = project.tasks.map((t) => (t.id === this.taskId ? { ...t, parent: newParent } : t));
    // New parent (indent target) becomes a summary. Snapshot its pre-op type
    // (only when we actually change it) so undo can restore it.
    if (this.mode === 'indent' && newParent !== undefined) {
      const np = tasks.find((t) => t.id === newParent);
      if (np && np.type !== 'summary') {
        this.prevTypes.push([newParent, np.type]);
        tasks = tasks.map((t) => (t.id === newParent ? { ...t, type: 'summary' as const } : t));
      }
    }
    // Old parent left childless (outdent) reverts to task — likewise snapshotted.
    if (this.mode === 'outdent' && self.parent !== undefined) {
      const oldParentId = self.parent;
      const stillHasKids = tasks.some((t) => t.parent === oldParentId);
      if (!stillHasKids) {
        const op = tasks.find((t) => t.id === oldParentId);
        if (op && op.type !== 'task') {
          this.prevTypes.push([oldParentId, op.type]);
          tasks = tasks.map((t) => (t.id === oldParentId ? { ...t, type: 'task' as const } : t));
        }
      }
    }
    return { ...project, tasks };
  }

  inverse(_project: Project): EditCommand {
    if (!this.applied) {
      throw new EditError(`inverse: apply() was not called on this command`, this.kind);
    }
    // Restore the exact previous parent + the pre-op type of every parent the
    // forward reparent promoted/demoted. Ad-hoc command — not exported.
    const taskId = this.taskId;
    const prevParent = this.prevParent;
    const prevTypes = this.prevTypes;
    return {
      kind: 'reparent-restore',
      label: `Restore parent of "${String(taskId)}"`,
      apply(p: Project): Project {
        return {
          ...p,
          tasks: p.tasks.map((t) => {
            if (t.id === taskId) return { ...t, parent: prevParent };
            const hit = prevTypes.find(([id]) => id === t.id);
            return hit ? { ...t, type: hit[1] } : t;
          }),
        };
      },
      inverse(_p: Project): EditCommand {
        throw new EditError('reparent-restore is not re-invertible', 'reparent-restore');
      },
    };
  }
}
