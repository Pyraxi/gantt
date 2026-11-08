// Parity row 16: keyboard editing in the grid (Bryntum/Excel-style).
// Enter commits + edits the next row, Tab the next editable column, focus
// returns to the grid instead of <body>, and unparseable input never sends an
// empty patch.
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useEditState } from './editing/useEditState';
import { Gantt, type GanttColumn } from './Gantt';
import { decodeSvarId, encodeSvarId, findNextCellInRow, visibleRowOrder } from './grid-keyboard';

// No vitest globals → Testing Library doesn't auto-unmount; stale Gantts
// would keep their listeners and SVAR focus effects alive across tests.
afterEach(cleanup);

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const t = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  text: `Task ${id}`,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5, 8),
  end: new Date(2026, 0, 5, 17),
  progress: 0,
  ...extra,
});
const project: Project = {
  start: new Date(2026, 0, 5, 8),
  defaultCalendarId: 'std',
  tasks: [t('a'), t('b'), t('c')],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};
const columns: GanttColumn[] = [
  { id: 'text', field: 'text', header: 'Name' },
  { id: 'duration', field: 'duration', header: 'Dur' },
  { id: 'progress', field: 'progress', header: '%' },
] as GanttColumn[];

const cell = (root: HTMLElement, row: string, col: string) =>
  root.querySelector(`.wx-cell[data-row-id=":${row}"][data-col-id=":${col}"]`) as HTMLElement;
const open = (root: HTMLElement, row: string, col: string) => {
  fireEvent.click(cell(root, row, col).querySelector('span') as Element);
  return cell(root, row, col).querySelector('input') as HTMLInputElement;
};
const flush = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

function setup(p: Project = project) {
  const onTaskEdit = vi.fn();
  const r = render(<Gantt project={p} columns={columns} editMode onTaskEdit={onTaskEdit} />);
  return { ...r, onTaskEdit };
}

// happy-dom has no layout, so SVAR virtualises to ~2 rows and the first
// column: the full <Gantt> cases use the `text` column on rows a → b. Row/
// column navigation is covered on a hand-built grid DOM; the whole flow is
// verified in Chromium through the profile harness (&editMode=1).

describe('<Gantt editMode> keyboard', () => {
  test('Enter commits and opens the same column on the next row', () => {
    const { container, onTaskEdit } = setup();
    const input = open(container, 'a', 'text');
    fireEvent.change(input, { target: { value: 'Set out' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onTaskEdit).toHaveBeenCalledWith('a', { text: 'Set out' });
    const next = cell(container, 'b', 'text').querySelector('input');
    expect(next?.value).toBe('Task b');
  });

  test('Escape cancels and returns focus to the grid cell, not <body>', async () => {
    const { container, onTaskEdit } = setup();
    const input = open(container, 'a', 'text');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await flush();
    expect(onTaskEdit).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(cell(container, 'a', 'text'));
  });

  test('Enter with no row below commits and returns focus to the grid cell', async () => {
    const { container } = setup({ ...project, tasks: [t('a')] });
    const input = open(container, 'a', 'text');
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(container.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(cell(container, 'a', 'text'));
  });
});

describe('<Gantt editMode> Enter / F2 on a focused cell', () => {
  test('opens the editor (and is not passed on to SVAR, which would toggle a summary)', () => {
    const { container } = setup();
    const c = cell(container, 'b', 'text');
    c.focus();
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(cell(container, 'b', 'text').querySelector('input')?.value).toBe('Task b');
  });

  test('F2 does the same', () => {
    const { container } = setup();
    const c = cell(container, 'a', 'text');
    c.focus();
    fireEvent.keyDown(c, { key: 'F2' });
    expect(cell(container, 'a', 'text').querySelector('input')).toBeTruthy();
  });
});

describe('useEditState — unparseable input', () => {
  test('commit with an unparseable value sends no patch and reports invalid', () => {
    const onTaskEdit = vi.fn();
    const { result } = renderHook(() => useEditState());
    act(() => result.current.activateCell('a', 'duration', '1d'));
    act(() => result.current.setValue('soon'));
    let status = '';
    act(() => {
      status = result.current.commitCell(onTaskEdit, { keepOpenIfInvalid: true });
    });
    expect(status).toBe('invalid');
    expect(onTaskEdit).not.toHaveBeenCalled();
    expect(result.current.activeCell).toEqual({ taskId: 'a', field: 'duration' });
    expect(result.current.invalid).toBe(true);
  });

  test('without keepOpenIfInvalid (blur) the edit reverts', () => {
    const onTaskEdit = vi.fn();
    const { result } = renderHook(() => useEditState());
    act(() => result.current.activateCell('a', 'progress', '0'));
    act(() => result.current.setValue('lots'));
    act(() => void result.current.commitCell(onTaskEdit));
    expect(onTaskEdit).not.toHaveBeenCalled();
    expect(result.current.activeCell).toBeNull();
  });

  test('a parseable value commits and reports committed; unchanged reports unchanged', () => {
    const onTaskEdit = vi.fn();
    const { result } = renderHook(() => useEditState());
    act(() => result.current.activateCell('a', 'progress', '0'));
    let status = '';
    act(() => {
      status = result.current.commitCell(onTaskEdit);
    });
    expect(status).toBe('unchanged');
    act(() => result.current.activateCell('a', 'progress', '0'));
    act(() => result.current.setValue('40'));
    act(() => {
      status = result.current.commitCell(onTaskEdit);
    });
    expect(status).toBe('committed');
    expect(onTaskEdit).toHaveBeenCalledWith('a', { progress: 40 });
  });
});

describe('grid-keyboard helpers', () => {
  // Rows a, s (summary), b, c × columns text, start, duration; `first` is the
  // absolute aria-rowindex of the first rendered row (SVAR virtualises).
  function grid(first = 0) {
    const body = document.createElement('div');
    ['a', 's', 'b', 'c'].forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'wx-row';
      row.setAttribute('aria-rowindex', String(first + i));
      for (const c of ['text', 'start', 'duration']) {
        const cellEl = document.createElement('div');
        cellEl.className = 'wx-cell';
        cellEl.setAttribute('data-row-id', encodeSvarId(r));
        cellEl.setAttribute('data-col-id', encodeSvarId(c));
        row.appendChild(cellEl);
      }
      body.appendChild(row);
    });
    return body;
  }
  const at = (g: HTMLElement, r: string, c: string) =>
    g.querySelector(`[data-row-id=":${r}"][data-col-id=":${c}"]`) as HTMLElement;

  test('visibleRowOrder: depth-first, skipping children of collapsed parents', () => {
    const rows = [
      { id: 'p1' },
      { id: 'a', parent: 'p1' },
      { id: 'p2', parent: 'p1' },
      { id: 'b', parent: 'p2' },
      { id: 'c' },
      { id: 'd', parent: 0 },
    ];
    expect(visibleRowOrder(rows, () => true)).toEqual(['p1', 'a', 'p2', 'b', 'c', 'd']);
    expect(visibleRowOrder(rows, (id) => id !== 'p2')).toEqual(['p1', 'a', 'p2', 'c', 'd']);
    expect(visibleRowOrder(rows, (id) => id !== 'p1')).toEqual(['p1', 'c', 'd']);
  });

  test('next / prev stay in the row and skip non-editable columns', () => {
    const g = grid();
    const onlyTextAndDuration = (_r: unknown, c: string) => c !== 'start';
    expect(findNextCellInRow(at(g, 'a', 'text'), 'next', onlyTextAndDuration)).toMatchObject({
      rowId: 'a',
      colId: 'duration',
    });
    expect(findNextCellInRow(at(g, 'a', 'duration'), 'prev', onlyTextAndDuration)).toMatchObject({
      colId: 'text',
    });
    expect(findNextCellInRow(at(g, 'a', 'duration'), 'next', () => true)).toBeNull();
  });

  test('SVAR id codec: strings carry ":", numbers are bare', () => {
    expect(decodeSvarId(':L0')).toBe('L0');
    expect(decodeSvarId('42')).toBe(42);
    expect(encodeSvarId(42)).toBe('42');
    expect(decodeSvarId(encodeSvarId('7'))).toBe('7');
  });
});
