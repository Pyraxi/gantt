import {
  computeWbs,
  type Link,
  predecessorsCreateCycle,
  type Task,
  type TaskId,
} from '@pyraxi/cpm-engine';
import type { FC } from 'react';
import { createElement } from 'react';
import { CellText } from './cell-text.js';
import type { GanttColumn } from './Gantt.js';
import { parsePredecessors } from './predecessor-input.js';

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

/** Format a link's lag MS-Project-style in the largest unit that is exact —
 *  `+3 days`, `+4 hrs`, `+30 mins` (`e` prefix when elapsed), so editing the
 *  cell reads back the same minutes — or `+1440m` when no `minutesPerDay` is
 *  available. `lag` is working-minutes. */
function formatLag(link: Link, minutesPerDay?: number): string {
  const e = link.lagElapsed ? 'e' : '';
  if (link.lagPercent !== undefined) {
    if (link.lagPercent === 0) return '';
    return `${link.lagPercent > 0 ? '+' : '-'}${Math.abs(link.lagPercent)}${e}%`;
  }
  const lag = link.lag;
  if (lag === 0) return '';
  const sign = lag > 0 ? '+' : '-';
  // An elapsed day is 24 h, whatever the calendar's working day.
  const perDay = link.lagElapsed ? 1440 : minutesPerDay;
  if (!perDay || perDay <= 0) return `${sign}${Math.abs(lag)}${e}m`;
  const abs = Math.abs(lag);
  // Up to 2 decimals, and only when that is the exact value.
  const exact = (per: number) => {
    const v = Math.round((abs / per) * 100) / 100;
    return Math.abs(v * per - abs) < 1e-6 ? v : undefined;
  };
  const days = exact(perDay);
  if (days !== undefined) return `${sign}${days} ${e}${days === 1 ? 'day' : 'days'}`;
  const hrs = exact(60);
  if (hrs !== undefined) return `${sign}${hrs} ${e}${hrs === 1 ? 'hr' : 'hrs'}`;
  return `${sign}${abs} ${e}${abs === 1 ? 'min' : 'mins'}`;
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
      const lag = formatLag(l, opts?.minutesPerDay);
      if (l.type !== 'FS' || lag !== '') s += l.type;
      s += lag;
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
    // 56: SVAR's header cell takes 19 px of padding plus a sort-icon slot; at
    // 44 the bold "ID" header truncated to "I." (Chromium-measured), and 56
    // still fits a 4-digit row number.
    width: opts?.width ?? 56,
    align: 'right',
    render: Cell,
  };
}

/**
 * Built-in WBS column (MS Project's WBS / outline number): `1`, `1.2`, `1.2.3`
 * from the parent / child structure, in `tasks` order (the engine's
 * `computeWbs`). Rebuild it when the tasks change, as with {@link idColumn}.
 *
 * - `opts.code(task)` returns a host-owned code (`task.codes`, an imported WBS,
 *   CM's `extra.wbsCode`) that wins where it's non-empty; `''` / undefined fall
 *   back to the outline number (MS Project's WBS is never blank).
 * - Grouped views: pass the **source** project's tasks, not the `groupProject`
 *   output, so members keep their real numbers. Group rows are always blank,
 *   as are other rows not in `tasks` (phantom baseline rows).
 */
export function wbsColumn(
  tasks: Task[],
  opts?: { header?: string; width?: number; code?: (task: Task) => string | undefined },
): GanttColumn {
  // String keys, as idColumn: the cell gets a SVAR row, not the Task.
  const outline = new Map([...computeWbs({ tasks })].map(([id, n]) => [String(id), n]));
  const Cell: FC<{ task: Task }> = ({ task }) => {
    // A SVAR group row carries `is_group_row`; a raw Task carries `group`.
    const isGroup = Boolean(task.group || (task as { is_group_row?: boolean }).is_group_row);
    const value = isGroup ? '' : opts?.code?.(task) || outline.get(String(task.id)) || '';
    return createElement(CellText, null, value);
  };
  return {
    id: '_wbs',
    header: opts?.header ?? 'WBS',
    width: opts?.width ?? 72,
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
  opts?: { header?: string; width?: number } & PredecessorFormatOptions &
    (
      | { editable?: false }
      | {
          /**
           * Click to edit in `editMode`, MS Project style (`3FS+2d, 5SS`), by
           * row number in `tasks` (required). Commits fire
           * `onCellEdit(id, 'predecessors', text)`; apply them with
           * `parsePredecessors` + the engine's `setPredecessors` (one undo
           * step). Unreadable text, unknown rows, self-references and loops
           * stay open with the reason as the tooltip.
           */
          editable: true;
          tasks: Task[];
        }
    ),
): GanttColumn {
  // Ellipsis + hover title when clipped (CM 2026-07-14: clipped predecessor cells).
  const Cell: FC<{ task: Task }> = ({ task }) =>
    createElement(CellText, null, formatPredecessors(task.id, links, opts));
  return {
    id: 'predecessors',
    header: opts?.header ?? 'Predecessors',
    width: opts?.width ?? 120,
    render: Cell,
    ...(opts?.editable
      ? {
          editor: {
            type: 'text' as const,
            getValue: (task: Task) => formatPredecessors(task.id, links, opts),
            validate: (value: string, task: Task) => {
              const parsed = parsePredecessors(value, {
                tasks: opts.tasks,
                minutesPerDay: opts.minutesPerDay,
                targetId: task.id,
              });
              if (!parsed.ok) return parsed.error;
              return predecessorsCreateCycle(task.id, links, parsed.preds)
                ? 'these predecessors would create a dependency loop'
                : undefined;
            },
          },
        }
      : {}),
  };
}
