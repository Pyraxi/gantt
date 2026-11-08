// WBS numbering, grouping by activity code, and filtering (parity row 8).
// Spec: docs/superpowers/specs/2026-10-16-wbs-codes-grouping-design.md
//
// Ids match strictly (no String() coercion), as schedule() does.

import type { Project, Task, TaskComputed, TaskId } from './types';

/**
 * Outline numbers (`1`, `1.2`, `1.2.3`) from the parent / child structure, in
 * array order. Every task gets one: tasks caught in a parent cycle (or
 * self-parented) are numbered as extra roots.
 */
export function computeWbs(project: Pick<Project, 'tasks'>): Map<TaskId, string> {
  const ids = new Set<TaskId>(project.tasks.map((t) => t.id));
  const children = new Map<TaskId, Task[]>();
  const roots: Task[] = [];
  for (const t of project.tasks) {
    const p = t.parent;
    if (p === undefined || p === null || !ids.has(p) || p === t.id) roots.push(t);
    else {
      const list = children.get(p);
      if (list) list.push(t);
      else children.set(p, [t]);
    }
  }
  const out = new Map<TaskId, string>();
  let rootCount = 0;
  const walk = (list: Task[], prefix: string) => {
    list.forEach((t, i) => {
      if (out.has(t.id)) return;
      const n = prefix ? `${prefix}.${i + 1}` : String(++rootCount);
      out.set(t.id, n);
      walk(children.get(t.id) ?? [], n);
    });
  };
  walk(roots, '');
  // Cycle members never reach a root: number them as roots too.
  const leftovers = project.tasks.filter((t) => !out.has(t.id));
  if (leftovers.length > 0) walk(leftovers, '');
  return out;
}

export interface GroupProjectOptions {
  /** Id prefix for the virtual group rows. Default `'group:'`. */
  idPrefix?: string;
  /** Title of the group for tasks with no value. Default `'(none)'`. */
  noneLabel?: string;
  /** Name recorded in `group.by` for a function key (default `'custom'`). */
  label?: string;
}

/**
 * A display-only copy of `project` with its leaf tasks re-parented under one
 * virtual summary row per value of `by` — a code-type id, or a function of the
 * task. Original summaries are dropped; links are kept. Group rows carry a
 * typed `group` marker, and span their members' dates (with `computed` when
 * every member is scheduled, so a `preScheduled` view draws them). Pass it to
 * `<Gantt>` to view by trade / area / subcontractor; send edits to the
 * original. Throws if a group row id would collide with a task id.
 */
export function groupProject(
  project: Project,
  by: string | ((task: Task) => string | undefined),
  options: GroupProjectOptions = {},
): Project {
  const prefix = options.idPrefix ?? 'group:';
  const none = options.noneLabel ?? '(none)';
  const codeType = typeof by === 'string' ? project.codeTypes?.find((c) => c.id === by) : undefined;
  const keyOf = typeof by === 'string' ? (t: Task) => t.codes?.[by] : by;
  const byLabel = typeof by === 'string' ? by : (options.label ?? 'custom');
  const groups = new Map<string, Task[]>();
  for (const t of project.tasks) {
    if (t.type === 'summary') continue;
    const k = keyOf(t);
    // String(): a loose-JSON numeric 1 and '1' are the same group.
    const key = k === undefined || k === null || k === '' ? none : String(k);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  // Code-type order first, then first appearance; "(none)" last; no repeats.
  const declared = (codeType?.values ?? []).map((v) => v.value).filter((v) => groups.has(v));
  const order = [
    ...new Set([
      ...declared.filter((v) => v !== none),
      ...[...groups.keys()].filter((k) => k !== none),
      ...(groups.has(none) ? [none] : []),
    ]),
  ];
  const taskIds = new Set(project.tasks.filter((t) => t.type !== 'summary').map((t) => t.id));
  const tasks: Task[] = [];
  for (const key of order) {
    const members = groups.get(key) ?? [];
    const meta = codeType?.values.find((v) => v.value === key);
    const id = `${prefix}${key}`;
    if (taskIds.has(id)) {
      throw new Error(
        `groupProject: group row id "${id}" collides with a task id; pass a different idPrefix`,
      );
    }
    tasks.push({
      id,
      text: meta?.description ?? key,
      type: 'summary',
      scheduleMode: 'auto',
      duration: 0,
      ...span(members, project.start),
      progress: 0,
      group: { by: byLabel, value: key, ...(meta?.color ? { color: meta.color } : {}) },
    });
    for (const m of members) tasks.push({ ...m, parent: id });
  }
  return { ...project, tasks };
}

/** A group row's dates: its members' span, plus `computed` when all are scheduled. */
function span(members: Task[], fallback: Date): Pick<Task, 'start' | 'end' | 'computed'> {
  const live = members.filter((m) => !m.unscheduled);
  if (live.length === 0) return { start: new Date(fallback), end: new Date(fallback) };
  const min = (xs: number[]) => Math.min(...xs);
  const max = (xs: number[]) => Math.max(...xs);
  const startOf = (m: Task) => (m.computed?.earlyStart ?? m.start).getTime();
  const endOf = (m: Task) => (m.computed?.earlyFinish ?? m.end).getTime();
  const start = new Date(min(live.map(startOf)));
  const end = new Date(max(live.map(endOf)));
  if (!live.every((m) => m.computed)) return { start, end };
  const cs = live.map((m) => m.computed as TaskComputed);
  const computed: TaskComputed = {
    earlyStart: new Date(start),
    earlyFinish: new Date(end),
    lateStart: new Date(min(cs.map((c) => c.lateStart.getTime()))),
    lateFinish: new Date(max(cs.map((c) => c.lateFinish.getTime()))),
    totalSlack: min(cs.map((c) => c.totalSlack)),
    freeSlack: 0,
    isCritical: cs.some((c) => c.isCritical),
  };
  return { start, end, computed };
}

/**
 * Ids of the tasks matching `predicate` plus all their ancestors, in project
 * order — ready for `visibleTaskIds`, so a filtered tree keeps its context.
 */
export function filterProject(project: Project, predicate: (task: Task) => boolean): TaskId[] {
  const byId = new Map<TaskId, Task>(project.tasks.map((t) => [t.id, t]));
  const keep = new Set<TaskId>();
  for (const t of project.tasks) {
    if (!predicate(t)) continue;
    let cur: Task | undefined = t;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parent !== undefined && cur.parent !== null ? byId.get(cur.parent) : undefined;
    }
  }
  return project.tasks.filter((t) => keep.has(t.id)).map((t) => t.id);
}
