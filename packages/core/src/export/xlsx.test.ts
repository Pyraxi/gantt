import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { buildSheetRows, DEFAULT_XLSX_COLUMNS, exportXLSX } from './xlsx.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, duration: number, parent?: string): Task {
  return {
    id,
    text: `Task ${id}`,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
    parent,
  };
}

function project(tasks: Task[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('buildSheetRows — defaults', () => {
  test('emits header row + one row per task with default columns', () => {
    const p = schedule(project([task('a', 540), task('b', 1080)]));

    const rows = buildSheetRows(p, DEFAULT_XLSX_COLUMNS);

    expect(rows[0]).toEqual([
      'ID',
      'Name',
      'Start',
      'End',
      'Duration (working minutes)',
      'Critical',
      'Total slack (working minutes)',
      'Progress (%)',
      'Parent',
    ]);

    expect(rows).toHaveLength(3);

    const rowA = rows[1];
    expect(rowA[0]).toBe('a');
    expect(rowA[1]).toBe('Task a');
    expect(rowA[2]).toBeInstanceOf(Date);
    expect(rowA[3]).toBeInstanceOf(Date);
    expect(rowA[4]).toBe(540);
    expect(['Y', 'N']).toContain(rowA[5]);
    expect(typeof rowA[6]).toBe('number');
    expect(rowA[7]).toBe(0);
    expect(rowA[8]).toBe('');
  });
});

describe('buildSheetRows — custom columns', () => {
  test('respects a function-valued column with non-Task return', () => {
    const p = schedule(project([task('a', 540), task('b', 1080)]));

    const rows = buildSheetRows(p, [
      { header: 'ID', value: 'id' },
      { header: 'Hours', value: (t) => Math.round(t.duration / 60) },
    ]);

    expect(rows).toEqual([
      ['ID', 'Hours'],
      ['a', 9],
      ['b', 18],
    ]);
  });

  test('respects a key-valued column that resolves to a parent string', () => {
    const p = schedule(project([task('a', 540, 'parent-x')]));

    const rows = buildSheetRows(p, [
      { header: 'ID', value: 'id' },
      { header: 'Parent', value: 'parent' },
    ]);

    expect(rows[1]).toEqual(['a', 'parent-x']);
  });
});

describe('exportXLSX — Blob roundtrip', () => {
  test('returns a Blob that xlsx can read back with the right shape', async () => {
    const p = schedule(project([task('a', 540), task('b', 1080)]));

    const blob = await exportXLSX({ scheduled: p, options: {} });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const buffer = await blob.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Programme']);

    const sheet = wb.Sheets.Programme;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

    expect(aoa).toHaveLength(3);
    expect(aoa[0][0]).toBe('ID');
    expect(aoa[1][0]).toBe('a');
    expect(aoa[2][0]).toBe('b');
  });

  test('respects a custom sheetName', async () => {
    const p = schedule(project([task('a', 540)]));

    const blob = await exportXLSX({ scheduled: p, options: { sheetName: 'Programme v2' } });

    const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Programme v2']);
  });
});
