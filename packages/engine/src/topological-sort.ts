import type { Link, Task, TaskId } from './types';

/**
 * Order tasks so that every predecessor appears before its successors.
 *
 * Operates on link-based ordering only (all dependency types FS/SS/FF/SF
 * establish "source must be visited before target" for scheduling-pass
 * purposes). Hierarchy (parent/summary) is not considered here — summary
 * task dates are derived from children after the forward/backward pass.
 *
 * Throws if two tasks share an id, or if the link graph contains a cycle (the
 * message names every loop's tasks, e.g. `[A1 → A2 → A1], [B1 → B2 → B1]`).
 */
export function topologicalSort(tasks: Task[], links: Link[]): Task[] {
  assertUniqueTaskIds(tasks, 'topologicalSort()');
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
    const loops = describeLoops(tasks, successors, new Set(ordered.map((t) => t.id)));
    throw new Error(
      `Link graph contains a cycle; topological sort is not possible — loops: ${loops.join(', ')}`,
    );
  }

  return ordered;
}

/**
 * Throws `<caller>: duplicate task id "a"` if any id appears on more than one
 * task. Every id → task map in the engine would otherwise keep only one row.
 */
export function assertUniqueTaskIds(tasks: readonly Task[], caller: string): void {
  const seen = new Set<TaskId>();
  const dupes = new Set<TaskId>();
  for (const t of tasks) {
    if (seen.has(t.id)) dupes.add(t.id);
    else seen.add(t.id);
  }
  if (dupes.size === 0) return;
  const list = [...dupes].map((id) => `"${String(id)}"`).join(', ');
  throw new Error(`${caller}: duplicate task id${dupes.size > 1 ? 's' : ''} ${list}`);
}

/**
 * Every loop left after Kahn's pass: each strongly connected component of the
 * unsorted tasks with more than one task, or a task linked to itself. Each is
 * shown as its shortest cycle through its first task (in task order), with any
 * other tasks of the same tangle listed after it.
 */
function describeLoops(
  tasks: Task[],
  successors: Map<TaskId, TaskId[]>,
  sorted: Set<TaskId>,
): string[] {
  const remaining = tasks.map((t) => t.id).filter((id) => !sorted.has(id));
  const next = (id: TaskId) => (successors.get(id) ?? []).filter((s) => !sorted.has(s));

  // Tarjan's SCC, iterative (a long chain must not overflow the stack).
  const index = new Map<TaskId, number>();
  const low = new Map<TaskId, number>();
  const onStack = new Set<TaskId>();
  const stack: TaskId[] = [];
  const componentOf = new Map<TaskId, TaskId[]>();
  let counter = 0;
  for (const root of remaining) {
    if (index.has(root)) continue;
    const work: { id: TaskId; succ: TaskId[]; i: number }[] = [];
    const visit = (id: TaskId) => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, succ: next(id), i: 0 });
    };
    visit(root);
    while (work.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by the loop condition
      const frame = work[work.length - 1]!;
      if (frame.i < frame.succ.length) {
        // biome-ignore lint/style/noNonNullAssertion: bounded by the check above
        const s = frame.succ[frame.i++]!;
        if (!index.has(s)) visit(s);
        else if (onStack.has(s)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(s) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: TaskId[] = [];
        let member: TaskId | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        for (const m of component) componentOf.set(m, component);
      }
    }
  }

  const loops: string[] = [];
  const reported = new Set<TaskId[]>();
  const order = new Map(remaining.map((id, i) => [id, i]));
  for (const start of remaining) {
    const component = componentOf.get(start);
    if (!component || reported.has(component)) continue;
    reported.add(component);
    const members = new Set(component);
    const selfLinked = next(start).includes(start);
    if (component.length === 1 && !selfLinked) continue; // downstream of a loop, not in one
    // Shortest path start → … → start inside the component (BFS).
    const parentOf = new Map<TaskId, TaskId>();
    const queue: TaskId[] = [start];
    let closing: TaskId | undefined;
    for (let q = 0; q < queue.length && closing === undefined; q++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by the loop condition
      const id = queue[q]!;
      for (const s of next(id)) {
        if (s === start) {
          closing = id;
          break;
        }
        if (!members.has(s) || parentOf.has(s)) continue;
        parentOf.set(s, id);
        queue.push(s);
      }
    }
    const path: TaskId[] = [];
    for (let id = closing; id !== undefined && id !== start; id = parentOf.get(id))
      path.unshift(id);
    const cycle = [start, ...path, start];
    const onCycle = new Set(cycle);
    // The tangle's other tasks, in task order (only the component, not all remaining).
    const others = component
      .filter((id) => !onCycle.has(id))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const text = cycle.map(String).join(' → ');
    loops.push(others.length > 0 ? `[${text} (+ ${others.map(String).join(', ')})]` : `[${text}]`);
  }
  return loops;
}
