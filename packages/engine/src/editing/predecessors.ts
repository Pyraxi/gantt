// Set a task's predecessors as a whole (MS Project's predecessor cell): the
// link diff, a cycle check, and an undoable command. The text form ("4FS+2d")
// is parsed in @pyraxi/gantt (parsePredecessors); this is the engine side.
import type { DependencyType, Link, LinkId, Project, TaskId } from '../types.js';
import type { EditCommand } from './commands.js';
import { EditError } from './errors.js';

export interface PredecessorSpec {
  source: TaskId;
  type: DependencyType;
  /** Minutes (working, or wall-clock when `lagElapsed`); 0 with `lagPercent`. */
  lag: number;
  lagPercent?: number;
  lagElapsed?: boolean;
}

export interface PredecessorDiff {
  create: PredecessorSpec[];
  remove: LinkId[];
  update: { id: LinkId; patch: Partial<Link> }[];
}

/**
 * The link changes that make `targetId`'s predecessors match `preds`, matched
 * by predecessor (one link per predecessor, as MS Project keys them):
 * unchanged links are kept, changed ones updated (type / lag / lag kind),
 * missing ones removed, new ones created. Other tasks' links are untouched.
 */
export function diffPredecessors(
  targetId: TaskId,
  links: readonly Link[],
  preds: readonly PredecessorSpec[],
): PredecessorDiff {
  const incoming = links.filter((l) => String(l.target) === String(targetId));
  const bySource = new Map(incoming.map((l) => [String(l.source), l]));
  const create: PredecessorSpec[] = [];
  const update: { id: LinkId; patch: Partial<Link> }[] = [];
  const kept = new Set<LinkId>();
  for (const p of preds) {
    const link = bySource.get(String(p.source));
    if (!link) {
      create.push(p);
      continue;
    }
    kept.add(link.id);
    const same =
      link.type === p.type &&
      (link.lag ?? 0) === p.lag &&
      link.lagPercent === p.lagPercent &&
      Boolean(link.lagElapsed) === Boolean(p.lagElapsed);
    if (same) continue;
    const patch: Partial<Link> = { type: p.type, lag: p.lag };
    if (link.lagPercent !== undefined || p.lagPercent !== undefined)
      patch.lagPercent = p.lagPercent;
    if (link.lagElapsed !== undefined || p.lagElapsed !== undefined)
      patch.lagElapsed = p.lagElapsed;
    update.push({ id: link.id, patch });
  }
  const remove = incoming.filter((l) => !kept.has(l.id)).map((l) => l.id);
  return { create, remove, update };
}

/** Whether giving `targetId` these predecessors would close a dependency cycle. */
export function predecessorsCreateCycle(
  targetId: TaskId,
  links: readonly Link[],
  preds: readonly PredecessorSpec[],
): boolean {
  const target = String(targetId);
  // Successors in the graph WITHOUT the target's current incoming links.
  const next = new Map<string, string[]>();
  for (const l of links) {
    if (String(l.target) === target) continue;
    const list = next.get(String(l.source));
    if (list) list.push(String(l.target));
    else next.set(String(l.source), [String(l.target)]);
  }
  // A cycle: some new predecessor is reachable from the target.
  const sources = new Set(preds.map((p) => String(p.source)));
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const n of next.get(id) ?? []) {
      if (sources.has(n)) return true;
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return false;
}

/**
 * Replace `targetId`'s predecessors with `preds` (one undo step). Refuses a
 * self-reference, an unknown task, a task listed twice or a cycle (EditError). New links get ids
 * `source->target` (suffixed if taken).
 */
export class SetPredecessorsCommand implements EditCommand {
  readonly kind = 'set-predecessors';
  readonly label: string;
  private before: Link[] | undefined;

  constructor(
    private readonly targetId: TaskId,
    private readonly preds: readonly PredecessorSpec[],
  ) {
    this.label = `Set predecessors of ${String(targetId)}`;
  }

  apply(project: Project): Project {
    // Ids match by String() (as everywhere in the command); links get the
    // task's own id, so a "1" for task 1 isn't a link the scheduler ignores.
    const ids = new Map(project.tasks.map((t) => [String(t.id), t.id]));
    if (!ids.has(String(this.targetId))) {
      throw new EditError(`task ${String(this.targetId)} not found`, this.kind);
    }
    const listed = new Set<string>();
    for (const p of this.preds) {
      if (listed.has(String(p.source))) {
        throw new EditError(`predecessor ${String(p.source)} is listed twice`, this.kind);
      }
      listed.add(String(p.source));
      if (String(p.source) === String(this.targetId)) {
        throw new EditError('a task can’t be its own predecessor', this.kind);
      }
      if (!ids.has(String(p.source))) {
        throw new EditError(`predecessor ${String(p.source)} not found`, this.kind);
      }
    }
    if (predecessorsCreateCycle(this.targetId, project.links, this.preds)) {
      throw new EditError('these predecessors would create a dependency loop', this.kind);
    }
    this.before = project.links;
    const diff = diffPredecessors(this.targetId, project.links, this.preds);
    const removed = new Set(diff.remove);
    const patches = new Map(diff.update.map((u) => [u.id, u.patch]));
    const links = project.links
      .filter((l) => !removed.has(l.id))
      .map((l) => {
        const patch = patches.get(l.id);
        if (!patch) return l;
        const next: Link = { ...l, ...patch };
        if (next.lagPercent === undefined) delete next.lagPercent;
        if (next.lagElapsed === undefined) delete next.lagElapsed;
        return next;
      });
    const taken = new Set(links.map((l) => String(l.id)));
    for (const p of diff.create) {
      let id = `${String(p.source)}->${String(this.targetId)}`;
      for (let n = 2; taken.has(id); n++) id = `${String(p.source)}->${String(this.targetId)}#${n}`;
      taken.add(id);
      links.push({
        id: id as LinkId,
        source: ids.get(String(p.source)) ?? p.source,
        target: ids.get(String(this.targetId)) ?? this.targetId,
        type: p.type,
        lag: p.lag,
        ...(p.lagPercent !== undefined ? { lagPercent: p.lagPercent } : {}),
        ...(p.lagElapsed ? { lagElapsed: true } : {}),
      });
    }
    return { ...project, links };
  }

  inverse(_project: Project): EditCommand {
    const before = this.before;
    if (!before) throw new EditError('inverse: apply() was not called on this command', this.kind);
    return new RestoreLinksCommand(before, `Undo: ${this.label}`);
  }
}

/** Restore a links array snapshot (the inverse of SetPredecessorsCommand; history is linear). */
class RestoreLinksCommand implements EditCommand {
  readonly kind = 'restore-links';
  private before: Link[] | undefined;
  constructor(
    private readonly links: Link[],
    readonly label: string,
  ) {}
  apply(project: Project): Project {
    this.before = project.links;
    return { ...project, links: this.links };
  }
  inverse(_project: Project): EditCommand {
    return new RestoreLinksCommand(this.before ?? this.links, this.label);
  }
}

/** Replace a task's predecessors (one undo step). See {@link SetPredecessorsCommand}. */
export function setPredecessors(targetId: TaskId, preds: readonly PredecessorSpec[]): EditCommand {
  return new SetPredecessorsCommand(targetId, preds);
}
