// Date cells round-trip in a non-UTC zone: exceljs stores a Date by its UTC
// epoch, so a local 08:00 NZ start used to land in Excel (and come back) as
// the previous day. Separate file: TZ is process-wide; relies on vitest's
// per-file process isolation.
process.env.TZ = 'Pacific/Auckland';

import { schedule } from '@pyraxi/cpm-engine';
import { expect, test } from 'vitest';
import { exportXLSX } from './export/xlsx.js';
import { importProgrammeTable, readSpreadsheet } from './programme-import.js';

test('NZ: our XLSX export (default Date columns) reads back on the same day', async () => {
  const { project } = importProgrammeTable([
    ['Name', 'Duration', 'Start'],
    ['Set out', '1d', '05/01/2026'],
  ]);
  const blob = await exportXLSX({ scheduled: schedule(project), options: {} });
  const table = await readSpreadsheet(blob);
  const startCol = (table[0] ?? []).indexOf('Start');
  expect(table[1]?.[startCol]).toBe('2026-01-05');
});
