// Parity row 12c: a programme sheet (Excel / CSV / pasted) → Project.
// Spec: docs/superpowers/specs/2026-10-16-excel-import-design.md
import { schedule } from '@pyraxi/cpm-engine';
import ExcelJS from 'exceljs';
import { describe, expect, test } from 'vitest';
import { exportXLSX } from './export/xlsx.js';
import { parseClipboardTable } from './grid-clipboard.js';
import { formatPredecessors } from './predecessors.js';
import { importProgrammeTable, readSpreadsheet } from './programme-import.js';
import { formatShortDate } from './svar-adapter.js';

const at = (m: number, d: number, h = 8) => new Date(2026, m, d, h);

describe('importProgrammeTable', () => {
  // An MS Project-style sheet: ID, outline levels, MSP predecessor text.
  const msp = [
    ['ID', 'Task Name', 'Duration', 'Start', 'Finish', 'Predecessors', 'Outline Level'],
    ['1', 'Site works', '', '', '', '', '1'],
    ['2', 'Set out', '1d', '05/01/2026', '', '', '2'],
    ['3', 'Excavate', '3 days', '', '', '2', '2'],
    ['4', 'Pour', '2d', '', '', '3FS+1d', '2'],
    ['', '', '', '', '', '', ''],
    ['5', 'Handover', '0d', '', '', '4', '1'],
  ];

  test('tasks, hierarchy, durations, links and a start floor from the sheet', () => {
    const { project: p, skipped } = importProgrammeTable(msp);
    expect(skipped).toEqual([]);
    expect(p.tasks.map((t) => [t.id, t.text, t.type, t.parent, t.duration])).toEqual([
      ['1', 'Site works', 'summary', undefined, 0],
      ['2', 'Set out', 'task', '1', 540],
      ['3', 'Excavate', 'task', '1', 1620],
      ['4', 'Pour', 'task', '1', 1080],
      ['5', 'Handover', 'milestone', undefined, 0],
    ]);
    expect(p.links.map((l) => [l.source, l.target, l.type, l.lag])).toEqual([
      ['2', '3', 'FS', 0],
      ['3', '4', 'FS', 540],
      ['4', '5', 'FS', 0],
    ]);
    // A leaf with a Start and no logic sits where the sheet says (SNET).
    expect(p.tasks[1]?.constraint).toEqual({ type: 'SNET', date: at(0, 5) });
    expect(p.start).toEqual(at(0, 5));
    // It schedules.
    const s = schedule(p);
    // A milestone sits at its predecessor's finish (MS Project).
    expect(s.tasks.find((t) => t.id === '5')?.start).toEqual(at(0, 13, 17));
  });

  test('WBS hierarchy and row-number ids when there is no ID column', () => {
    const { project: p } = importProgrammeTable([
      ['WBS', 'Name', 'Duration', 'Predecessors'],
      ['1', 'Frame', '', ''],
      ['1.1', 'Walls', '2d', ''],
      ['1.2', 'Roof', '3d', '2'],
    ]);
    expect(p.tasks.map((t) => [t.id, t.parent, t.type])).toEqual([
      ['1', undefined, 'summary'],
      ['2', '1', 'task'],
      ['3', '1', 'task'],
    ]);
    expect(p.links.map((l) => [l.source, l.target])).toEqual([['2', '3']]);
  });

  test('a duration from Start and Finish (finish = end of that working day)', () => {
    const { project: p } = importProgrammeTable([
      ['Name', 'Start', 'Finish'],
      ['Scaffold', '2026-01-05', '2026-01-07'],
    ]);
    expect(p.tasks[0]?.duration).toBe(3 * 540);
  });

  test('bad cells are skipped and reported, never guessed; the rest imports', () => {
    const { project: p, skipped } = importProgrammeTable([
      ['ID', 'Name', 'Duration', 'Start', 'Predecessors'],
      ['1', 'A', 'soon', '31/02/2026', ''],
      ['2', 'B', '1d', '', '9, 1'],
    ]);
    expect(p.tasks.map((t) => t.id)).toEqual(['1', '2']);
    expect(skipped).toEqual([
      { row: 2, column: 'Duration', value: 'soon', reason: 'invalid' },
      { row: 2, column: 'Start', value: '31/02/2026', reason: 'invalid' },
      { row: 3, column: 'Predecessors', value: '9, 1', reason: 'no task 9' },
    ]);
    // The unreadable predecessor cell is skipped whole (no partial guess).
    expect(p.links).toEqual([]);
  });

  test('custom column mapping, and no Name column is an error', () => {
    const { project: p } = importProgrammeTable(
      [
        ['Activity', 'Dur (d)'],
        ['Pour slab', '2'],
      ],
      { columns: { name: 'Activity', duration: 'Dur (d)' } },
    );
    expect(p.tasks[0]).toMatchObject({ text: 'Pour slab', duration: 1080 });
    expect(() => importProgrammeTable([['Foo'], ['bar']])).toThrow(/Name/);
  });

  test('round-trip: our own XLSX export (with predecessors) imports back', async () => {
    const { project: p } = importProgrammeTable(msp);
    const s = schedule(p);
    const blob = await exportXLSX({
      scheduled: s,
      options: {
        columns: [
          { header: 'ID', value: 'id' },
          { header: 'Name', value: 'text' },
          {
            header: 'Duration',
            value: (t) => (t.type === 'summary' ? '' : `${t.duration / 540}d`),
          },
          { header: 'Start', value: (t) => formatShortDate(t.start) },
          {
            header: 'Predecessors',
            value: (t) => formatPredecessors(t.id, s.links, { minutesPerDay: 540 }),
          },
          { header: 'Outline Level', value: (t) => (t.parent === undefined ? 1 : 2) },
        ],
      },
    });
    const table = await readSpreadsheet(blob);
    expect(table[0]).toEqual(['ID', 'Name', 'Duration', 'Start', 'Predecessors', 'Outline Level']);
    const back = importProgrammeTable(table);
    expect(back.skipped).toEqual([]);
    expect(back.project.tasks.map((t) => [t.id, t.text, t.type, t.parent, t.duration])).toEqual(
      p.tasks.map((t) => [t.id, t.text, t.type, t.parent, t.duration]),
    );
    expect(back.project.links.map((l) => [l.source, l.target, l.lag])).toEqual(
      p.links.map((l) => [l.source, l.target, l.lag]),
    );
  });

  test('a missing or unreadable duration is a task, not a milestone; MSP ? and edays read', () => {
    const { project: p, skipped } = importProgrammeTable([
      ['Name', 'Duration'],
      ['Estimated', '3 days?'],
      ['Cure', '2 edays'],
      ['Unknown', ''],
      ['Garbled', 'soon'],
      ['Gate', '0d'],
    ]);
    expect(p.tasks.map((t) => [t.text, t.type, t.duration, t.durationElapsed])).toEqual([
      ['Estimated', 'task', 1620, undefined],
      ['Cure', 'task', 2880, true],
      ['Unknown', 'task', 0, undefined],
      ['Garbled', 'task', 0, undefined],
      ['Gate', 'milestone', 0, undefined],
    ]);
    expect(skipped.map((x) => x.value)).toEqual(['soon']);
  });

  test('Finish before Start is reported, not a negative duration', () => {
    const { project: p, skipped } = importProgrammeTable([
      ['Name', 'Start', 'Finish'],
      ['Backwards', '07/01/2026', '05/01/2026'],
    ]);
    expect(p.tasks[0]?.duration).toBe(0);
    expect(skipped).toEqual([
      { row: 2, column: 'Finish', value: '05/01/2026', reason: 'finish before start' },
    ]);
  });

  test('duplicate IDs fall back to row numbers, and say so', () => {
    const { skipped } = importProgrammeTable([
      ['ID', 'Name'],
      ['2', 'Alpha'],
      ['3', 'Beta'],
      ['3', 'Gamma'],
    ]);
    expect(skipped).toEqual([
      {
        row: 4,
        column: 'ID',
        value: '3',
        reason: 'duplicate id: predecessors are read as row numbers',
      },
    ]);
  });

  test('P6 Activity IDs: predecessors reference the ID text', () => {
    const { project: p, skipped } = importProgrammeTable([
      ['Activity ID', 'Activity Name', 'Original Duration', 'Predecessors'],
      ['A1000', 'Mobilise', '5d', ''],
      ['A1010', 'Excavate', '3d', 'A1000FS+2d'],
      ['A1020', 'Pour', '2d', 'A1010, A1000SS'],
    ]);
    expect(skipped).toEqual([]);
    expect(p.links.map((l) => [l.source, l.target, l.type, l.lag])).toEqual([
      ['A1000', 'A1010', 'FS', 1080],
      ['A1010', 'A1020', 'FS', 0],
      ['A1000', 'A1020', 'SS', 0],
    ]);
  });

  test('links to or from a summary are imported but reported (the engine does not schedule them)', () => {
    const { project: p, skipped } = importProgrammeTable([
      ['ID', 'Name', 'Duration', 'Predecessors', 'Outline Level'],
      ['1', 'Phase', '', '', '1'],
      ['2', 'Kid', '1d', '', '2'],
      ['3', 'Tail', '1d', '1', '1'],
    ]);
    expect(p.links).toHaveLength(1);
    expect(skipped).toEqual([
      {
        row: 4,
        column: 'Predecessors',
        value: '1',
        reason: 'links to summary tasks are not scheduled',
      },
    ]);
  });

  test('header matching prefers the closest alias (ID over Unique ID); a mapped column must exist', () => {
    const { project: p } = importProgrammeTable([
      ['Unique ID', 'ID', 'Name', 'Predecessors'],
      ['17', '1', 'A', ''],
      ['42', '2', 'B', '1'],
    ]);
    expect(p.tasks.map((t) => t.id)).toEqual(['1', '2']);
    expect(p.links.map((l) => [l.source, l.target])).toEqual([['1', '2']]);
    expect(() => importProgrammeTable([['Name'], ['A']], { columns: { duration: 'Dur' } })).toThrow(
      /Dur/,
    );
  });

  test('MS Project short dates with a weekday and a 2-digit year (Mon 5/01/26)', () => {
    const { project: p, skipped } = importProgrammeTable([
      ['Name', 'Start'],
      ['A', 'Mon 5/01/26'],
    ]);
    expect(skipped).toEqual([]);
    expect(p.tasks[0]?.constraint?.date).toEqual(at(0, 5)); // Only weekday names are stripped: "Due 5/01/26" is not a date.
    expect(
      importProgrammeTable([
        ['Name', 'Start'],
        ['A', 'Due 5/01/26'],
      ]).skipped,
    ).toHaveLength(1);
  });

  test('CSV through parseClipboardTable with a comma delimiter', () => {
    expect(parseClipboardTable('Name,Duration\n"Set out, north",1d\n', ',')).toEqual([
      ['Name', 'Duration'],
      ['Set out, north', '1d'],
    ]);
    expect(() => parseClipboardTable('a||b', '||')).toThrow(/one character/);
  });

  test('readSpreadsheet: percent-formatted cells read as percent; merged cells read once', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('P');
    ws.addRow(['Name', '% Complete', 'Notes', 'More']);
    ws.addRow(['A', 0.5, 'merged', '']);
    ws.getCell('B2').numFmt = '0%';
    ws.mergeCells('C2:D2');
    const table = await readSpreadsheet(await wb.xlsx.writeBuffer());
    expect(table[1]).toEqual(['A', '50%', 'merged', '']);
    expect(importProgrammeTable(table).project.tasks[0]?.progress).toBe(50);
  });
});
