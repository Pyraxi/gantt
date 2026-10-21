// Patch 1.7.5: an XLSX date cell must carry the local wall clock: an 08:00 NZ start is the previous day in UTC. Separate
// file: TZ is process-wide (relies on vitest's per-file process isolation).
process.env.TZ = 'Pacific/Auckland';

import type { Project, Task } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import ExcelJS from 'exceljs';
import { expect, test } from 'vitest';
import { exportXLSX } from './export/xlsx.js';

const start = new Date(2026, 0, 5, 8);
const t: Task = {
  id: 'a',
  text: 'A',
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start,
  end: new Date(2026, 0, 5, 17),
  progress: 0,
};
const project: Project = {
  start,
  defaultCalendarId: 'std',
  tasks: [t],
  links: [],
  resources: [],
  calendars: [
    {
      id: 'std',
      name: 'Std',
      workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
      exceptions: [],
    },
  ],
  baselines: [],
  assignments: [],
};

test('exportXLSX date cells carry the local wall clock (Excel shows 5/01/2026 8:00)', async () => {
  const blob = await exportXLSX({ scheduled: schedule(project), options: {} });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  const ws = wb.worksheets[0];
  const header = (ws?.getRow(1).values as unknown[]).slice(1);
  const col = header.indexOf('Start') + 1;
  const v = ws?.getRow(2).getCell(col).value as Date;
  expect([v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate(), v.getUTCHours()]).toEqual([
    2026, 0, 5, 8,
  ]);
});
