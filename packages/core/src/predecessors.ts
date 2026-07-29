import type { Link, Task, TaskId } from '@pyraxi/cpm-engine';
import type { FC } from 'react';
import { createElement } from 'react';
import type { GanttColumn } from './Gantt.js';

/** Options for {@link formatPredecessors} / {@link predecessorsColumn}. */
export interface PredecessorFormatOptions {
  /**
   * Ordered task list. When supplied, predecessors are referenced by **row
   * number** (1-based position in this list) like MS Project — e.g. `9`,
   * `4FS+3 days` — instead of by raw task id. Pair with {@link idColumn} so the
   * numbers line up. Omit for the legacy id-based form.
   */
  tasks?: Task[];
  /**
   * Working minutes per day, used to render lag in **days** (`+3 days`) rather
   * than raw working-minutes (`+1440m`). Omit to keep the minute form.
   */
  minutesPerDay?: number;
}

/** 1-based row-number index for each task id, in the given order (MS-Project ID). */
function rowNumberById(tasks: Task[]): Map<string, number> {
  return new Map(tasks.map((t, i) => [String(t.id), i + 1]));
}

/** Format a link's lag as MS-Project-style `+3 days` / `-1 day`, or `+1440m`
 *  when no `minutesPerDay` is available. `lag` is working-minutes. */
function formatLag(lag: number, minutesPerDay?: number): string {
  if (lag === 0) return '';
  const sign = lag > 0 ? '+' : '-';
  if (minutesPerDay && minutesPerDay > 0) {
    const days = Math.abs(lag) / minutesPerDay;
    const rounded = Number.isInteger(days) ? days : Math.round(days * 100) / 100;
    return `${sign}${rounded} ${rounded === 1 ? 'day' : 'days'}`;
  }
  return `${sign}${Math.abs(lag)}m`;
}

/**
 * MS-Project-style predecessor string for a task, from its incoming links.
 * By default references the link's raw `source` id + lag in working-minutes
 * (backward-compatible). Pass `opts.tasks` to reference by **row number**
 * (MS-Project ID) and `opts.minutesPerDay` to show lag in **days** —
 * e.g. `9, 4FS+3 days`. FS is implicit (shown only when a lag is present, to
 * match MS Project); SS/FF/SF are always shown.
 */
export function formatPredecessors(
  taskId: TaskId,
  links: Link[],
  opts?: PredecessorFormatOptions,
): string {
  const rowById = opts?.tasks ? rowNumberById(opts.tasks) : undefined;
  return links
    .filter((l) => String(l.target) === String(taskId))
    .map((l) => {
      const ref = rowById?.get(String(l.source)) ?? String(l.source);
      let s = String(ref);
      // MS Project omits "FS" unless the link carries a lag (then it's shown to
      // disambiguate, e.g. "4FS+3 days"); other types are always shown.
      if (l.type !== 'FS' || l.lag !== 0) s += l.type;
      s += formatLag(l.lag, opts?.minutesPerDay);
      return s;
    })
    .join(', ');
}

/**
 * Built-in **ID** column — the 1-based row number of each task (MS-Project's
 * left-most `#` column). Right-aligned by convention. Pair with
 * {@link predecessorsColumn} (given the same `tasks`) so predecessor references
 * line up with these numbers.
 */
export function idColumn(tasks: Task[], opts?: { header?: string; width?: number }): GanttColumn {
  const rowById = rowNumberById(tasks);
  const Cell: FC<{ task: Task }> = ({ task }) =>
    createElement('span', null, String(rowById.get(String(task.id)) ?? ''));
  return {
    id: '_id',
    header: opts?.header ?? 'ID',
    width: opts?.width ?? 44,
    align: 'right',
    render: Cell,
  };
}

/**
 * Built-in Predecessors column (computed from project links). Pass
 * `opts.tasks` + `opts.minutesPerDay` for MS-Project-style row-number
 * references with day lag (recommended, and what the component wires by
 * default); omit for the legacy id + minute form.
 */
export function predecessorsColumn(
  links: Link[],
  opts?: { header?: string; width?: number } & PredecessorFormatOptions,
): GanttColumn {
  const Cell: FC<{ task: Task }> = ({ task }) =>
    createElement('span', null, formatPredecessors(task.id, links, opts));
  return {
    id: 'predecessors',
    header: opts?.header ?? 'Predecessors',
    width: opts?.width ?? 120,
    render: Cell,
  };
}
