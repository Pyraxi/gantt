import type { Link, LinkId, Project, Task, TaskId } from '../types.js';
import { EditError } from './errors.js';

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
