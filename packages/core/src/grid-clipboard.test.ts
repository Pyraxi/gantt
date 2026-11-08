import { describe, expect, test } from 'vitest';
import type { EditableField } from './editing/useEditState.js';
import {
  formatClipboardTable,
  parseClipboardTable,
  parsePastedValue,
  planFillDown,
  planPaste,
} from './grid-clipboard.js';

// Parity row 16 remainder. Spec: docs/superpowers/specs/2026-10-16-grid-paste-fill-design.md

describe('parseClipboardTable (Excel TSV)', () => {
  test('rows on newlines, cells on tabs, trailing newline ignored, CRLF', () => {
    expect(parseClipboardTable('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseClipboardTable('single')).toEqual([['single']]);
    expect(parseClipboardTable('')).toEqual([]);
  });

  test("Excel's quoted cells: embedded tab, newline and doubled quotes", () => {
    expect(parseClipboardTable('"a\tb"\t"line1\nline2"\n"say ""hi"""\tx\n')).toEqual([
      ['a\tb', 'line1\nline2'],
      ['say "hi"', 'x'],
    ]);
  });

  test('a quote inside an unquoted cell is literal', () => {
    expect(parseClipboardTable('6" pipe\t2')).toEqual([['6" pipe', '2']]);
  });

  test('round-trips with formatClipboardTable', () => {
    const rows = [
      ['a\tb', 'plain'],
      ['x"y', 'multi\nline'],
    ];
    expect(parseClipboardTable(formatClipboardTable(rows))).toEqual(rows);
  });
});

describe('parsePastedValue (widened for Excel)', () => {
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 8);
  test('dates: ISO, day-first d/m/yyyy and d-m-yyyy, month names', () => {
    expect(parsePastedValue('start', '2026-10-16')).toEqual({ start: day(2026, 10, 16) });
    expect(parsePastedValue('start', '16/10/2026')).toEqual({ start: day(2026, 10, 16) });
    expect(parsePastedValue('end', '5-1-2026')).toEqual({ end: day(2026, 1, 5) });
    expect(parsePastedValue('end', '16 Oct 2026')).toEqual({ end: day(2026, 10, 16) });
    expect(parsePastedValue('start', '10/16/2026', { dateOrder: 'mdy' })).toEqual({
      start: day(2026, 10, 16),
    });
  });

  test('a time after the date (Excel datetime, MS Project start text) is tolerated', () => {
    expect(parsePastedValue('start', '19/10/2026 8:00')).toEqual({ start: day(2026, 10, 19) });
    expect(parsePastedValue('start', '2026-10-19 17:00:00')).toEqual({
      start: day(2026, 10, 19),
    });
    expect(parsePastedValue('end', '19 Oct 2026 5:00 PM')).toEqual({ end: day(2026, 10, 19) });
  });

  test('dates that are ambiguous or invalid are rejected, not guessed', () => {
    expect(parsePastedValue('start', '46311')).toBeNull(); // Excel serial
    expect(parsePastedValue('start', '31/02/2026')).toBeNull();
    expect(parsePastedValue('start', '10/16/2026')).toBeNull(); // month 16, day-first
    expect(parsePastedValue('start', '')).toBeNull();
  });

  test('durations use the calendar units; progress accepts %; mode is case-insensitive', () => {
    expect(parsePastedValue('duration', '5d', { minutesPerDay: 540 })).toEqual({
      duration: 2700,
    });
    expect(parsePastedValue('duration', '2 days')).toEqual({ duration: 960 });
    expect(parsePastedValue('duration', 'soon')).toBeNull();
    expect(parsePastedValue('progress', '50%')).toEqual({ progress: 50 });
    expect(parsePastedValue('progress', 'half')).toBeNull();
    expect(parsePastedValue('scheduleMode', 'Manual')).toEqual({ scheduleMode: 'manual' });
    expect(parsePastedValue('text', '  Pour slab ')).toEqual({ text: 'Pour slab' });
    expect(parsePastedValue('text', '')).toBeNull();
  });
});

describe('planPaste', () => {
  // Grid: rows r1..r4 (r2 a summary), columns name | wbs (read-only) | start | duration.
  const rowOrder = ['r1', 'r2', 'r3', 'r4'];
  const columns = ['name', 'wbs', 'start', 'duration'];
  const fields: Record<string, EditableField> = {
    name: 'text',
    start: 'start',
    duration: 'duration',
  };
  const fieldFor = (rowId: string | number, colId: string): EditableField | undefined => {
    const f = fields[colId];
    if (rowId === 'r2' && (f === 'start' || f === 'duration')) return undefined;
    return f;
  };
  const plan = (text: string, anchorRow: string, anchorCol: string) =>
    planPaste({
      table: parseClipboardTable(text),
      anchor: { rowId: anchorRow, colId: anchorCol },
      rowOrder,
      columns,
      fieldFor,
    });

  test('a block lands positionally from the anchor; patches merge per task', () => {
    const { edits, skipped } = plan(
      'Dig\t1.1\t2026-10-19\t3d\nFrame\t1.2\t2026-10-22\t5d',
      'r3',
      'name',
    );
    expect(edits).toEqual([
      { id: 'r3', patch: { text: 'Dig', start: new Date(2026, 9, 19, 8), duration: 1440 } },
      { id: 'r4', patch: { text: 'Frame', start: new Date(2026, 9, 22, 8), duration: 2400 } },
    ]);
    // The read-only wbs column took its cell and skipped it — alignment kept.
    expect(skipped.map((s) => [s.rowId, s.colId, s.reason])).toEqual([
      ['r3', 'wbs', 'read-only'],
      ['r4', 'wbs', 'read-only'],
    ]);
  });

  test('summary dates, unparseable values and overflow are skipped and reported', () => {
    const { edits, skipped } = plan('3d\n4d\nnope\n6d\n7d', 'r1', 'duration');
    expect(edits).toEqual([
      { id: 'r1', patch: { duration: 1440 } },
      { id: 'r4', patch: { duration: 2880 } },
    ]);
    expect(skipped.map((s) => [s.rowId ?? null, s.value, s.reason])).toEqual([
      ['r2', '4d', 'read-only'],
      ['r3', 'nope', 'invalid'],
      [null, '7d', 'out-of-range'],
    ]);
  });

  test('a blank Excel cell is reported as empty, not invalid', () => {
    const { edits, skipped } = plan('\t\t\t3d', 'r1', 'name');
    expect(edits).toEqual([{ id: 'r1', patch: { duration: 1440 } }]);
    expect(skipped.map((x) => [x.colId, x.reason])).toEqual([
      ['name', 'empty'],
      ['wbs', 'read-only'],
      ['start', 'empty'],
    ]);
  });

  test('columns past the last one overflow', () => {
    const { edits, skipped } = plan('3d\textra', 'r4', 'duration');
    expect(edits).toEqual([{ id: 'r4', patch: { duration: 1440 } }]);
    expect(skipped).toEqual([
      { rowId: 'r4', colId: undefined, value: 'extra', reason: 'out-of-range' },
    ]);
  });

  test('an anchor not in the grid plans nothing', () => {
    expect(plan('x', 'nope', 'name')).toEqual({ edits: [], skipped: [] });
  });
});

describe('planFillDown', () => {
  const cellValue = (id: string | number) =>
    ({ r1: '3d', r2: '4d', r3: '5d', r4: '6d' })[id as 'r1'];
  const fieldFor = (_r: string | number, _c: string): EditableField | undefined => 'duration';

  test('several rows: the top row value goes to the rest', () => {
    const { edits } = planFillDown({
      rows: ['r2', 'r3', 'r4'],
      colId: 'duration',
      fieldFor,
      cellValue,
    });
    expect(edits).toEqual([
      { id: 'r3', patch: { duration: 1920 } },
      { id: 'r4', patch: { duration: 1920 } },
    ]);
  });

  test('a read-only target is skipped; a read-only source fills nothing', () => {
    const ro = (r: string | number) => (r === 'r3' ? undefined : ('duration' as const));
    const out = planFillDown({
      rows: ['r2', 'r3', 'r4'],
      colId: 'duration',
      fieldFor: ro,
      cellValue,
    });
    expect(out.edits).toEqual([{ id: 'r4', patch: { duration: 1920 } }]);
    expect(out.skipped.map((s) => [s.rowId, s.reason])).toEqual([['r3', 'read-only']]);
    const none = planFillDown({
      rows: ['r3', 'r4'],
      colId: 'duration',
      fieldFor: ro,
      cellValue,
    });
    expect(none.edits).toEqual([]);
  });
});

describe('elapsed-duration rows', () => {
  test('a pasted duration on an elapsed row is 24 h days', () => {
    const { edits } = planPaste({
      table: parseClipboardTable('3\n3'),
      anchor: { rowId: 'cure', colId: 'duration' },
      rowOrder: ['cure', 'pour'],
      columns: ['duration'],
      fieldFor: () => 'duration',
      minutesPerDay: 540,
      isElapsed: (id) => id === 'cure',
    });
    expect(edits).toEqual([
      { id: 'cure', patch: { duration: 4320 } },
      { id: 'pour', patch: { duration: 1620 } },
    ]);
  });
});
