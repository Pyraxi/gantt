import type { Project, Task } from '@pyraxi/cpm-engine';
import ExcelJS from 'exceljs';
import type { XlsxColumn, XlsxExportOptions } from './types.js';

export type SheetCell = string | number | Date;
export type SheetRow = SheetCell[];

export const DEFAULT_XLSX_COLUMNS: XlsxColumn[] = [
  { header: 'ID', value: 'id' },
  { header: 'Name', value: 'text' },
  { header: 'Start', value: 'start' },
  { header: 'End', value: 'end' },
  { header: 'Duration (working minutes)', value: 'duration' },
  {
    header: 'Critical',
    value: (t: Task) => (t.computed?.isCritical ? 'Y' : 'N'),
  },
  {
    header: 'Total slack (working minutes)',
    value: (t: Task) => t.computed?.totalSlack ?? 0,
  },
  { header: 'Progress (%)', value: 'progress' },
  {
    header: 'Parent',
    value: (t: Task) => t.parent ?? '',
  },
];

export function buildSheetRows(project: Project, columns: XlsxColumn[]): SheetRow[] {
  const header: SheetRow = columns.map((c) => c.header);
  const dataRows: SheetRow[] = project.tasks.map((task) => columns.map((c) => readCell(task, c)));
  return [header, ...dataRows];
}

function readCell(task: Task, column: XlsxColumn): SheetCell {
  if (typeof column.value === 'function') {
    const raw = column.value(task);
    return raw ?? '';
  }
  const raw = task[column.value];
  if (raw === undefined || raw === null) return '';
  if (raw instanceof Date) return raw;
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  return String(raw);
}

export async function exportXLSX({
  scheduled,
  options,
}: {
  scheduled: Project;
  options: XlsxExportOptions;
}): Promise<Blob> {
  const columns = options.columns ?? DEFAULT_XLSX_COLUMNS;
  const sheetName = options.sheetName ?? 'Programme';

  const rows = buildSheetRows(scheduled, columns);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  // rows[0] is the header; each subsequent row is a task. `addRows` accepts an
  // array-of-arrays and stamps Date cells as native date cells (matching the
  // old `cellDates: true`).
  sheet.addRows(rows);

  const buffer = await workbook.xlsx.writeBuffer();

  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
