import type { Project, Task } from '@pyraxi/cpm-engine';
import * as XLSX from 'xlsx';
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
  const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);

  const arrayBuffer = XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx',
  }) as ArrayBuffer;

  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
