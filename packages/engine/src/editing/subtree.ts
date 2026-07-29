import type { Link, Project, Task, TaskId } from '../types.js';
import type { EditCommand } from './commands.js';
import { EditError } from './errors.js';

export interface SubtreeClipboard {
  tasks: Task[];
  links: Link[];
  rootId: TaskId;
}

/** Root + all descendants, plus links fully inside the subtree. Pure read. */
export function copySubtree(project: Project, rootId: TaskId): SubtreeClipboard {
  const root = project.tasks.find((t) => t.id === rootId);
  if (!root) throw new EditError(`missing task ${String(rootId)}`, 'copy-subtree');
  const inSubtree = new Set<TaskId>([rootId]);
  // Iterate to fixpoint: a child is in-subtree if its parent is.
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of project.tasks) {
      if (t.parent !== undefined && inSubtree.has(t.parent) && !inSubtree.has(t.id)) {
        inSubtree.add(t.id);
        grew = true;
      }
    }
  }
  const tasks = project.tasks.filter((t) => inSubtree.has(t.id));
  const links = project.links.filter((l) => inSubtree.has(l.source) && inSubtree.has(l.target));
  return { tasks, links, rootId };
}

function defaultIdGen(): TaskId {
  // Node 24 + modern browsers expose globalThis.crypto.
  return globalThis.crypto.randomUUID();
}

/** Clone the clipboard with fresh ids, remap parent + links, insert into a project. */
export function pasteSubtree(
  clip: SubtreeClipboard,
  opts: { parent?: TaskId; insertAfter?: TaskId; idGen?: (oldId: TaskId) => TaskId } = {},
): EditCommand {
  const gen = opts.idGen ?? (() => defaultIdGen());
  // Build the id map eagerly (at command construction) so apply() stays pure.
  const idMap = new Map<TaskId, TaskId>();
  for (const t of clip.tasks) idMap.set(t.id, gen(t.id));
  const linkIdMap = new Map<TaskId, TaskId>();
  for (const l of clip.links) linkIdMap.set(l.id, gen(l.id));
  const rootOldId = clip.rootId;

  const clonedTasks: Task[] = clip.tasks.map((t) => {
    const newId = idMap.get(t.id) as TaskId;
    // Root re-parents to opts.parent; inner nodes remap to their cloned parent.
    const newParent =
      t.id === rootOldId ? opts.parent : t.parent !== undefined ? idMap.get(t.parent) : undefined;
    return {
      ...t,
      id: newId,
      parent: newParent,
    };
  });
  const clonedLinks: Link[] = clip.links.map((l) => ({
    ...l,
    id: linkIdMap.get(l.id) as TaskId,
    source: idMap.get(l.source) as TaskId,
    target: idMap.get(l.target) as TaskId,
  }));

  const label = `Paste ${clonedTasks.length} task(s)`;
  return {
    kind: 'paste-subtree',
    label,
    apply(project: Project): Project {
      for (const t of clonedTasks) {
        if (project.tasks.some((x) => x.id === t.id)) {
          throw new EditError(`duplicate task id ${String(t.id)}`, 'paste-subtree');
        }
      }
      for (const l of clonedLinks) {
        if (project.links.some((x) => x.id === l.id)) {
          throw new EditError(`duplicate link id ${String(l.id)}`, 'paste-subtree');
        }
      }
      const tasks = [...project.tasks];
      const afterIdx =
        opts.insertAfter !== undefined ? tasks.findIndex((t) => t.id === opts.insertAfter) : -1;
      const insertAt = afterIdx === -1 ? tasks.length : afterIdx + 1;
      tasks.splice(insertAt, 0, ...clonedTasks);
      return { ...project, tasks, links: [...project.links, ...clonedLinks] };
    },
    inverse(_project: Project): EditCommand {
      const rootNewId = idMap.get(rootOldId as TaskId) as TaskId;
      // Deleting the cloned root cascades: rebuild a delete for each cloned task.
      const clonedIds = clonedTasks.map((t) => t.id);
      return {
        kind: 'paste-undo',
        label: `Remove pasted "${String(rootNewId)}"`,
        apply(p: Project): Project {
          return {
            ...p,
            tasks: p.tasks.filter((t) => !clonedIds.includes(t.id)),
            links: p.links.filter(
              (l) => !clonedIds.includes(l.source) && !clonedIds.includes(l.target),
            ),
          };
        },
        inverse(_p: Project): EditCommand {
          throw new EditError('paste-undo is not re-invertible', 'paste-undo');
        },
      };
    },
  };
}
