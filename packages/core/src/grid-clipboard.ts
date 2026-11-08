// Grid clipboard (parity row 16 remainder): paste a block from Excel, copy a
// cell, fill down. Pure planning — the Gantt wires it to clipboard / key
// events and delivers the result through `onTasksEdit` (one batch, one undo).
// Spec: docs/superpowers/specs/2026-10-16-grid-paste-fill-design.md
import type { TaskId } from '@pyraxi/cpm-engine';
import {
  durationUnitsFor,
  type EditableField,
  parseFieldValue,
  type TaskEditPatch,
} from './editing/useEditState.js';

/** One task's merged patch from a paste or fill. */
export interface TaskEdit {
  id: TaskId;
  patch: TaskEditPatch;
}

/** A clipboard cell that wasn't applied, and why. */
export interface SkippedCell {
  /** Undefined when the cell fell past the last row. */
  rowId: TaskId | undefined;
  /** Undefined when the cell fell past the last column. */
  colId: string | undefined;
  value: string;
  reason: 'read-only' | 'empty' | 'invalid' | 'out-of-range';
}

export interface ClipboardPlan {
  edits: TaskEdit[];
  skipped: SkippedCell[];
}

/** How a pasted `d/m/y` date is read. Day-first by default (NZ / AU / UK). */
export type DateOrder = 'dmy' | 'mdy';

/**
 * Excel's clipboard text → rows of cells. Tab-separated (or `delimiter`, e.g.
 * `','` for CSV), newline rows; a cell starting with `"` is quoted (may hold
 * delimiters / newlines, `""` = `"`). A trailing newline (Excel always adds
 * one) is not an extra row.
 */
export function parseClipboardTable(text: string, delimiter = '\t'): string[][] {
  if (delimiter.length !== 1) {
    throw new Error(`parseClipboardTable: delimiter must be one character, got "${delimiter}"`);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let cellStart = true;
  while (i < text.length) {
    const ch = text[i] as string;
    if (cellStart && ch === '"') {
      // Quoted cell: read to the closing quote.
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cell += text[i];
        i++;
      }
      cellStart = false;
      continue;
    }
    cellStart = false;
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      cellStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStart = true;
    } else {
      cell += ch;
    }
    i++;
  }
  if (!cellStart || cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Rows of cells → Excel clipboard text (quoting cells that need it). */
export function formatClipboardTable(rows: string[][]): string {
  const quote = (c: string) => (/[\t\n\r"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return `${rows.map((r) => r.map(quote).join('\t')).join('\n')}\n`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A pasted date → `yyyy-mm-dd`, or null. Never guesses an ambiguous value. */
function normaliseDate(raw: string, order: DateOrder): string | null {
  // A time after the date (an Excel datetime cell, MS Project's start text) is
  // dropped: the editor sets dates only, at the start of the working day.
  // MS Project's short dates carry a weekday ("Mon 5/01/26"): drop it.
  const s = raw
    .trim()
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?$/i, '')
    .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(?=\d)/i, '');
  let y: number;
  let m: number;
  let d: number;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  // A 2-digit year is 20yy (programmes are this century).
  const numeric = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/);
  const named = s.match(/^(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{4})$/i);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    [d, m] = order === 'dmy' ? [a, b] : [b, a];
    y = Number(numeric[3]) + ((numeric[3] as string).length === 2 ? 2000 : 0);
  } else if (named) {
    d = Number(named[1]);
    m = MONTHS.indexOf((named[2] as string).toLowerCase()) + 1;
    y = Number(named[3]);
  } else {
    return null;
  }
  // Reject rollovers (31/02 → 3 March).
  const probe = new Date(y, m - 1, d);
  if (m < 1 || probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse one pasted cell for `field` — the inline editor's own parsing, widened
 * for what Excel puts on the clipboard. Null = invalid (the cell is skipped).
 */
export function parsePastedValue(
  field: EditableField,
  raw: string,
  opts: { minutesPerDay?: number; dateOrder?: DateOrder; elapsed?: boolean } = {},
): TaskEditPatch | null {
  let value = raw.trim();
  if (value === '') return null;
  switch (field) {
    case 'start':
    case 'end': {
      const iso = normaliseDate(value, opts.dateOrder ?? 'dmy');
      if (!iso) return null;
      value = iso;
      break;
    }
    case 'progress':
      value = value.replace(/%$/, '').trim();
      if (value === '') return null;
      break;
    case 'scheduleMode':
      value = value.toLowerCase();
      break;
  }
  const patch = parseFieldValue(field, value, durationUnitsFor(opts.minutesPerDay), opts.elapsed);
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Field of an editable cell, or undefined (read-only / not a task cell). */
export type FieldFor = (rowId: TaskId, colId: string) => EditableField | undefined;

function collect(): {
  add(id: TaskId, patch: TaskEditPatch): void;
  edits: TaskEdit[];
} {
  const byId = new Map<string, TaskEdit>();
  const edits: TaskEdit[] = [];
  return {
    edits,
    add(id, patch) {
      const existing = byId.get(String(id));
      if (existing) Object.assign(existing.patch, patch);
      else {
        const e = { id, patch: { ...patch } };
        byId.set(String(id), e);
        edits.push(e);
      }
    },
  };
}

/**
 * Plan a paste: clipboard row i → visible row anchor + i, cell j → visible
 * column anchor + j (positional, as in Excel). Cells on read-only or missing
 * targets, or that don't parse, are skipped and reported.
 */
export function planPaste(args: {
  table: string[][];
  anchor: { rowId: TaskId; colId: string };
  /** Row ids in the order the grid shows them. */
  rowOrder: readonly TaskId[];
  /** Column ids in display order. */
  columns: readonly string[];
  fieldFor: FieldFor;
  minutesPerDay?: number;
  dateOrder?: DateOrder;
  /** Rows whose duration is elapsed: their pasted days are 24 h. */
  isElapsed?: (rowId: TaskId) => boolean;
}): ClipboardPlan {
  const { table, anchor, rowOrder, columns, fieldFor } = args;
  const r0 = rowOrder.findIndex((id) => String(id) === String(anchor.rowId));
  const c0 = columns.indexOf(anchor.colId);
  if (r0 < 0 || c0 < 0) return { edits: [], skipped: [] };
  const out = collect();
  const skipped: SkippedCell[] = [];
  table.forEach((cells, i) => {
    const rowId = rowOrder[r0 + i];
    cells.forEach((value, j) => {
      const colId = columns[c0 + j];
      if (rowId === undefined || colId === undefined) {
        skipped.push({ rowId, colId, value, reason: 'out-of-range' });
        return;
      }
      const field = fieldFor(rowId, colId);
      if (!field) {
        skipped.push({ rowId, colId, value, reason: 'read-only' });
        return;
      }
      if (value.trim() === '') {
        skipped.push({ rowId, colId, value, reason: 'empty' });
        return;
      }
      const patch = parsePastedValue(field, value, { ...args, elapsed: args.isElapsed?.(rowId) });
      if (!patch) {
        skipped.push({ rowId, colId, value, reason: 'invalid' });
        return;
      }
      out.add(rowId, patch);
    });
  });
  return { edits: out.edits, skipped };
}

/**
 * Plan a fill-down (Ctrl+D): the first row's value in `colId` goes to every
 * other row. The caller passes either the selected rows (in visible order) or
 * [row above, focused row].
 */
export function planFillDown(args: {
  rows: readonly TaskId[];
  colId: string;
  fieldFor: FieldFor;
  /** The cell's editor value (as the inline editor would open with). */
  cellValue: (rowId: TaskId) => string | undefined;
  minutesPerDay?: number;
  isElapsed?: (rowId: TaskId) => boolean;
}): ClipboardPlan {
  const [source, ...targets] = args.rows;
  if (source === undefined) return { edits: [], skipped: [] };
  const sourceField = args.fieldFor(source, args.colId);
  const value = sourceField ? args.cellValue(source) : undefined;
  if (value === undefined) return { edits: [], skipped: [] };
  const out = collect();
  const skipped: SkippedCell[] = [];
  for (const rowId of targets) {
    const field = args.fieldFor(rowId, args.colId);
    if (!field) {
      skipped.push({ rowId, colId: args.colId, value, reason: 'read-only' });
      continue;
    }
    const patch = parsePastedValue(field, value, {
      minutesPerDay: args.minutesPerDay,
      elapsed: args.isElapsed?.(rowId),
    });
    if (!patch) {
      skipped.push({ rowId, colId: args.colId, value, reason: 'invalid' });
      continue;
    }
    out.add(rowId, patch);
  }
  return { edits: out.edits, skipped };
}
