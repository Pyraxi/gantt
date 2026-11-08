// Parity row 12c: a programme sheet (an Excel / CSV export, or a pasted table)
// → an unscheduled Project. Cells are read with the grid's own parsers (paste
// dates, MS Project durations and predecessor text); anything unreadable is
// skipped and reported, never guessed.
// Spec: docs/superpowers/specs/2026-10-16-excel-import-design.md
import {
  type Calendar,
  type Link,
  type Project,
  type Task,
  type TaskId,
  workingMinutesBetween,
} from '@pyraxi/cpm-engine';
import { type DateOrder, parsePastedValue } from './grid-clipboard.js';
import { parsePredecessors } from './predecessor-input.js';
import { workingMinutesPerDay } from './svar-adapter.js';

/** Sheet columns the import reads. */
export type ImportField =
  | 'id'
  | 'name'
  | 'duration'
  | 'start'
  | 'finish'
  | 'predecessors'
  | 'outline'
  | 'wbs'
  | 'progress';

/** Header aliases, matched case-insensitively (MS Project / P6 export names). */
const ALIASES: Record<ImportField, string[]> = {
  id: ['id', '#', 'task id', 'activity id', 'unique id'], // in priority order
  name: ['name', 'task name', 'activity name', 'description', 'task'],
  duration: ['duration', 'original duration', 'dur'],
  start: ['start', 'start date'],
  finish: ['finish', 'end', 'finish date', 'end date'],
  predecessors: ['predecessors', 'preds'],
  outline: ['outline level', 'level'],
  wbs: ['wbs', 'outline number'],
  progress: ['% complete', 'percent complete', 'progress', '%'],
};

/** A cell that wasn't imported, and why. `row` is the 1-based sheet row. */
export interface SkippedImportCell {
  row: number;
  column: string;
  value: string;
  reason: string;
}

export interface ProgrammeImportOptions {
  /** Header text per field, overriding the aliases. */
  columns?: Partial<Record<ImportField, string>>;
  /** Default: Mon–Fri 08:00–17:00 (id `standard`). */
  calendar?: Calendar;
  /** Default: the earliest Start in the sheet, else today at 08:00. */
  start?: Date;
  /** How `d/m/y` dates read. Default day-first (NZ / AU / UK). */
  dateOrder?: DateOrder;
}

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const STANDARD_CALENDAR: Calendar = {
  id: 'standard',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

/**
 * A programme table → `{ project, skipped }`. The first non-empty row is the
 * header. Hierarchy from Outline Level, else WBS; ids from the ID column when
 * unique, else row numbers; predecessors in MS Project text referencing those
 * ids. A leaf with a Start and no predecessors gets SNET at that start. The
 * project is unscheduled: pass it to `<Gantt>` or `schedule()`.
 */
export function importProgrammeTable(
  table: readonly (readonly string[])[],
  options: ProgrammeImportOptions = {},
): { project: Project; skipped: SkippedImportCell[] } {
  const calendar = options.calendar ?? STANDARD_CALENDAR;
  const minutesPerDay = workingMinutesPerDay(calendar);
  const headerIndex = table.findIndex((r) => r.some((c) => c.trim() !== ''));
  const header = (table[headerIndex] ?? []).map((h) => h.trim());
  const col: Partial<Record<ImportField, number>> = {};
  const lower = header.map((h) => h.toLowerCase());
  for (const field of Object.keys(ALIASES) as ImportField[]) {
    const wanted = options.columns?.[field];
    if (wanted !== undefined) {
      const i = lower.indexOf(wanted.toLowerCase());
      if (i < 0) throw new Error(`importProgrammeTable: no column "${wanted}" for ${field}`);
      col[field] = i;
      continue;
    }
    // Alias order wins over sheet order: "ID" before "Unique ID".
    for (const alias of ALIASES[field]) {
      const i = lower.indexOf(alias);
      if (i >= 0) {
        col[field] = i;
        break;
      }
    }
  }
  if (col.name === undefined) {
    throw new Error('importProgrammeTable: no Name column (map one with options.columns.name)');
  }

  const skipped: SkippedImportCell[] = [];
  const rows = table
    .map((cells, i) => ({ cells, sheetRow: i + 1 }))
    .slice(headerIndex + 1)
    .filter(({ cells }) => cells.some((c) => c.trim() !== ''));
  const cell = (cells: readonly string[], field: ImportField) =>
    col[field] === undefined ? '' : (cells[col[field] as number] ?? '').trim();
  const report = (sheetRow: number, field: ImportField, value: string, reason: string) =>
    skipped.push({ row: sheetRow, column: header[col[field] as number] ?? field, value, reason });

  // Ids: the ID column when every value is present and unique, else row numbers.
  const sheetIds = rows.map(({ cells }) => cell(cells, 'id'));
  const useIdColumn =
    col.id !== undefined &&
    sheetIds.every((v) => v !== '') &&
    new Set(sheetIds).size === sheetIds.length;
  const ids = rows.map((_, i) => (useIdColumn ? (sheetIds[i] as string) : String(i + 1)));
  if (col.id !== undefined && !useIdColumn) {
    // Say so: the sheet's predecessor text means ids, and now reads as rows.
    const seenIds = new Set<string>();
    rows.forEach(({ sheetRow }, i) => {
      const v = sheetIds[i] as string;
      if (v === '' || seenIds.has(v)) {
        report(
          sheetRow,
          'id',
          v,
          `${v === '' ? 'missing' : 'duplicate'} id: predecessors are read as row numbers`,
        );
      }
      seenIds.add(v);
    });
  }

  // Hierarchy: Outline Level (a stack), else WBS (parent = path minus last segment).
  const parents: (TaskId | undefined)[] = [];
  if (col.outline !== undefined) {
    const stack: TaskId[] = [];
    rows.forEach(({ cells }, i) => {
      const raw = cell(cells, 'outline');
      if (raw !== '' && !Number.isFinite(Number(raw))) {
        report(rows[i]?.sheetRow ?? 0, 'outline', raw, 'invalid');
      }
      const level = Math.max(1, Math.trunc(Number(raw) || 1));
      stack.length = Math.min(stack.length, level - 1);
      parents.push(stack[stack.length - 1]);
      stack.push(ids[i] as TaskId);
    });
  } else if (col.wbs !== undefined) {
    const byWbs = new Map(rows.map(({ cells }, i) => [cell(cells, 'wbs'), ids[i] as TaskId]));
    rows.forEach(({ cells }) => {
      const wbs = cell(cells, 'wbs');
      parents.push(wbs.includes('.') ? byWbs.get(wbs.slice(0, wbs.lastIndexOf('.'))) : undefined);
    });
  }
  const hasChildren = new Set(parents.filter((p) => p !== undefined).map(String));

  const parse = (
    sheetRow: number,
    field: 'start' | 'finish' | 'duration' | 'progress',
    raw: string,
  ) => {
    if (raw === '') return undefined;
    // MS Project marks an estimate with "?" ("3 days?"); "2 edays" is elapsed.
    const text = field === 'duration' ? raw.replace(/\?$/, '').trim() : raw;
    const patch = parsePastedValue(field === 'finish' ? 'end' : field, text, {
      minutesPerDay,
      dateOrder: options.dateOrder,
      elapsed: field === 'duration' && isElapsedText(text),
    });
    if (!patch) report(sheetRow, field, raw, 'invalid');
    return patch ?? undefined;
  };

  const starts: (Date | undefined)[] = [];
  const tasks: Task[] = rows.map(({ cells, sheetRow }, i) => {
    const id = ids[i] as TaskId;
    const summary = hasChildren.has(String(id));
    const start = parse(sheetRow, 'start', cell(cells, 'start'))?.start;
    const finish = parse(sheetRow, 'finish', cell(cells, 'finish'))?.end;
    const durationText = cell(cells, 'duration');
    let duration = parse(sheetRow, 'duration', durationText)?.duration;
    const elapsed = duration !== undefined && isElapsedText(durationText.replace(/\?$/, ''));
    if (duration === undefined && start && finish && !summary) {
      // A Finish date is the end of that working day (MS Project's convention).
      const endOfDay = new Date(finish.getFullYear(), finish.getMonth(), finish.getDate(), 23, 59);
      const span = workingMinutesBetween(start, endOfDay, calendar);
      if (span < 0) report(sheetRow, 'finish', cell(cells, 'finish'), 'finish before start');
      else duration = span;
    }
    const progress = parse(sheetRow, 'progress', cell(cells, 'progress'))?.progress;
    starts.push(summary ? undefined : start);
    const task: Task = {
      id,
      text: cell(cells, 'name'),
      // A milestone only when the sheet says 0: an empty or unreadable
      // duration is a task, never a guessed diamond.
      type: summary ? 'summary' : duration === 0 ? 'milestone' : 'task',
      scheduleMode: 'auto',
      duration: summary ? 0 : (duration ?? 0),
      start: start ?? new Date(0),
      end: start ?? new Date(0),
      progress: progress ?? 0,
    };
    const parent = parents[i];
    if (parent !== undefined) task.parent = parent;
    if (elapsed && !summary) task.durationElapsed = true;
    return task;
  });

  // Predecessors reference the sheet's ids as text (P6 "A1000" too), or row
  // numbers when there's no usable ID column.
  const byRef = new Map(tasks.map((t, i) => [useIdColumn ? String(t.id) : String(i + 1), t.id]));
  const resolve = (ref: string) => byRef.get(ref);
  const summaryIds = new Set(tasks.filter((t) => t.type === 'summary').map((t) => String(t.id)));
  const links: Link[] = [];
  const hasLogic = new Set<string>();
  rows.forEach(({ cells, sheetRow }, i) => {
    const text = cell(cells, 'predecessors');
    if (text === '') return;
    const target = tasks[i] as Task;
    const parsed = parsePredecessors(text, { resolve, minutesPerDay, targetId: target.id });
    if (!parsed.ok) {
      report(sheetRow, 'predecessors', text, parsed.error);
      return;
    }
    // The engine schedules neither side of a summary link (MS Project does).
    if (
      summaryIds.has(String(target.id)) ||
      parsed.preds.some((p) => summaryIds.has(String(p.source)))
    ) {
      report(sheetRow, 'predecessors', text, 'links to summary tasks are not scheduled');
    }
    for (const p of parsed.preds) {
      hasLogic.add(String(target.id));
      links.push({
        id: `${String(p.source)}->${String(target.id)}`,
        source: p.source,
        target: target.id,
        type: p.type,
        lag: p.lag,
        ...(p.lagPercent !== undefined ? { lagPercent: p.lagPercent } : {}),
        ...(p.lagElapsed ? { lagElapsed: true } : {}),
      });
    }
  });

  const datedStarts = starts.filter((d): d is Date => d !== undefined);
  const projectStart =
    options.start ??
    (datedStarts.length > 0
      ? new Date(
          datedStarts.reduce((min, d) => Math.min(min, d.getTime()), Number.POSITIVE_INFINITY),
        )
      : (() => {
          const d = new Date();
          return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8);
        })());
  for (const [i, t] of tasks.entries()) {
    const start = starts[i];
    // A dated leaf with no logic sits where the sheet says.
    if (start && !hasLogic.has(String(t.id))) t.constraint = { type: 'SNET', date: start };
    if (t.start.getTime() === 0) {
      t.start = projectStart;
      t.end = projectStart;
    }
  }

  // Sheet order: row, then column.
  skipped.sort((a, b) => a.row - b.row || header.indexOf(a.column) - header.indexOf(b.column));
  return {
    project: {
      start: projectStart,
      defaultCalendarId: calendar.id,
      tasks,
      links,
      resources: [],
      calendars: [calendar],
      baselines: [],
      assignments: [],
    },
    skipped,
  };
}

/**
 * An `.xlsx` sheet (the first, or `sheet` by name) as text rows for
 * {@link importProgrammeTable}. Rows keep their sheet numbering (empty rows
 * stay as empty arrays). Date cells read as `yyyy-mm-dd` (Excel dates carry no
 * time zone; exceljs gives them as UTC), formulas as their result, rich text
 * as its text. `exceljs` loads on demand, as for export.
 */
export async function readSpreadsheet(
  file: Blob | ArrayBuffer,
  options: { sheet?: string } = {},
): Promise<string[][]> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file instanceof Blob ? await file.arrayBuffer() : file);
  const ws = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0];
  if (!ws) throw new Error(`readSpreadsheet: no sheet ${options.sheet ?? '(empty workbook)'}`);
  const rows: string[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) {
      const cell = row.getCell(c) as {
        value: unknown;
        numFmt?: string;
        isMerged?: boolean;
        master?: unknown;
      };
      // A merged range's other cells repeat the master's value: read it once.
      if (cell.isMerged && cell.master !== cell) cells.push('');
      // A percent-formatted 0.5 is "50%" on screen; read it as the user sees it.
      else if (typeof cell.value === 'number' && /%/.test(cell.numFmt ?? '')) {
        cells.push(`${Math.round(cell.value * 10000) / 100}%`);
      } else cells.push(cellText(cell.value));
    }
    rows.push(cells);
  }
  return rows;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`;
  }
  if (typeof value === 'object') {
    const v = value as { result?: unknown; richText?: { text: string }[]; text?: unknown };
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    return '';
  }
  return String(value);
}

/** "2 edays", "3ed", "1.5 ew": MS Project's elapsed duration text. */
function isElapsedText(text: string): boolean {
  return /^\d+(\.\d+)?\s*e[a-z]*$/i.test(text.trim());
}
