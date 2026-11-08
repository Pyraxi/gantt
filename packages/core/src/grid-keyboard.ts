// Keyboard navigation between inline grid editors (parity row 16):
// Enter / Shift+Enter → same column, next / previous row; Tab / Shift+Tab →
// next / previous editable column in the row. Works on SVAR's rendered grid
// DOM for in-row moves (`.wx-cell` with `data-row-id` / `data-col-id`) and the
// data order (respecting collapsed summaries) for row moves, since SVAR
// virtualises rows out of the DOM.
import type { TaskId } from '@pyraxi/cpm-engine';

export type GridMove = 'down' | 'up' | 'next' | 'prev';

/** SVAR's DOM id codec (`@svar-ui/lib-dom` setID/id): strings carry a `:` prefix. */
export function decodeSvarId(value: string): TaskId {
  if (value.startsWith(':')) return value.slice(1);
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

export function encodeSvarId(id: TaskId): string {
  return typeof id === 'string' ? `:${id}` : String(id);
}

/**
 * Row ids in the order the grid shows them: depth-first over `rows` (array
 * order within a parent), descending only into open parents. `isOpen` reads
 * the live expand state (the user may have collapsed a summary in the UI).
 * SVAR virtualises rows to the viewport, so the DOM can't answer "next row".
 */
export function visibleRowOrder(
  rows: readonly { id: TaskId; parent?: TaskId | null }[],
  isOpen: (id: TaskId) => boolean,
): TaskId[] {
  const ids = new Set(rows.map((r) => String(r.id)));
  const children = new Map<string, TaskId[]>();
  const roots: TaskId[] = [];
  for (const r of rows) {
    const p = r.parent;
    if (p == null || p === 0 || !ids.has(String(p))) roots.push(r.id);
    else {
      const list = children.get(String(p));
      if (list) list.push(r.id);
      else children.set(String(p), [r.id]);
    }
  }
  const out: TaskId[] = [];
  const walk = (list: TaskId[]) => {
    for (const id of list) {
      out.push(id);
      const kids = children.get(String(id));
      if (kids && isOpen(id)) walk(kids);
    }
  };
  walk(roots);
  return out;
}

/**
 * The next / previous editable cell in `fromCell`'s row (Tab / Shift+Tab), or
 * `null` at the row's end. `canEdit(rowId, colId)` decides which cells qualify;
 * columns are never virtualised away in the grid, so the DOM row is complete.
 */
export function findNextCellInRow(
  fromCell: Element,
  move: 'next' | 'prev',
  canEdit: (rowId: TaskId, colId: string) => boolean,
): { rowId: TaskId; colId: string; cell: HTMLElement } | null {
  const row = fromCell.closest('.wx-row');
  const rowAttr = fromCell.getAttribute('data-row-id');
  if (!row || rowAttr === null) return null;
  const rowId = decodeSvarId(rowAttr);
  const cells = [...row.querySelectorAll<HTMLElement>('.wx-cell[data-col-id]')];
  const step = move === 'next' ? 1 : -1;
  for (
    let i = cells.indexOf(fromCell as HTMLElement) + step;
    i >= 0 && i < cells.length;
    i += step
  ) {
    const target = cells[i];
    const col = target?.getAttribute('data-col-id');
    if (!target || col == null) continue;
    const colId = String(decodeSvarId(col));
    if (canEdit(rowId, colId)) return { rowId, colId, cell: target };
  }
  return null;
}
