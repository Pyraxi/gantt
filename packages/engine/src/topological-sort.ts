import type { Link, Task, TaskId } from './types';

/**
 * Order tasks so that every predecessor appears before its successors.
 *
 * Operates on link-based ordering only (all dependency types FS/SS/FF/SF
 * establish "source must be visited before target" for scheduling-pass
 * purposes). Hierarchy (parent/summary) is not considered here — summary
 * task dates are derived from children after the forward/backward pass.
 *
 * Throws if the link graph contains a cycle.
 */
export function topologicalSort(tasks: Task[], links: Link[]): Task[] {
  const taskById = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const successors = new Map<TaskId, TaskId[]>();
  const inDegree = new Map<TaskId, number>();

  for (const t of tasks) {
    successors.set(t.id, []);
    inDegree.set(t.id, 0);
  }

  for (const link of links) {
    if (!taskById.has(link.source) || !taskById.has(link.target)) continue;
    successors.get(link.source)?.push(link.target);
    inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1);
  }

  const queue: TaskId[] = [];
  for (const t of tasks) {
    if ((inDegree.get(t.id) ?? 0) === 0) queue.push(t.id);
  }

  const ordered: Task[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as TaskId;
    const t = taskById.get(id);
    if (t) ordered.push(t);
    for (const succId of successors.get(id) ?? []) {
      const newDegree = (inDegree.get(succId) ?? 0) - 1;
      inDegree.set(succId, newDegree);
      if (newDegree === 0) queue.push(succId);
    }
  }

  if (ordered.length !== tasks.length) {
    throw new Error('Link graph contains a cycle; topological sort is not possible');
  }

  return ordered;
}
