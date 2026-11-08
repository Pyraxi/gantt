// Parity row 16 remainder: the grid clipboard wired into <Gantt editMode>.
// happy-dom has no layout, so SVAR renders ~2 rows and only the first
// column — these cases use the `text` column; multi-column paste is covered
// by grid-clipboard.test.ts and checked in Chromium (profile harness).
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { captureBaseline } from '@pyraxi/cpm-engine';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt, type GanttColumn } from './Gantt';

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
] as GanttColumn[];

const cell = (root: HTMLElement, row: string, col: string) =>
  root.querySelector(`.wx-cell[data-row-id=":${row}"][data-col-id=":${col}"]`) as HTMLElement;

/** A clipboard event carrying `text` (happy-dom has no DataTransfer on it). */
function clipboardEvent(type: 'paste' | 'copy', text = '') {
  const store = new Map<string, string>([['text/plain', text]]);
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: {
      getData: (k: string) => store.get(k) ?? '',
      setData: (k: string, v: string) => store.set(k, v),
    },
  });
  return { e, store };
}

function setup(props: Partial<Parameters<typeof Gantt>[0]> = {}) {
  const onTaskEdit = vi.fn();
  const r = render(
    <Gantt project={project} columns={columns} editMode onTaskEdit={onTaskEdit} {...props} />,
  );
  return { ...r, onTaskEdit };
}

describe('<Gantt editMode> grid clipboard', () => {
  test('paste from Excel fills down the column as one batch', () => {
    const onTasksEdit = vi.fn();
    const { container, onTaskEdit } = setup({ onTasksEdit });
    const target = cell(container, 'a', 'text');
    target.focus();
    const { e } = clipboardEvent('paste', 'Set out\nExcavate\nPour\nExtra\n');
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onTasksEdit).toHaveBeenCalledTimes(1);
    const [edits, info] = onTasksEdit.mock.calls[0] as [
      unknown,
      { source: string; skipped: unknown[] },
    ];
    expect(edits).toEqual([
      { id: 'a', patch: { text: 'Set out' } },
      { id: 'b', patch: { text: 'Excavate' } },
      { id: 'c', patch: { text: 'Pour' } },
    ]);
    expect(info.source).toBe('paste');
    expect(info.skipped).toEqual([
      { rowId: undefined, colId: 'text', value: 'Extra', reason: 'out-of-range' },
    ]);
    expect(onTaskEdit).not.toHaveBeenCalled();
  });

  test('a clipboard event aimed at <body> (Chromium) still finds the focused cell', () => {
    const onTasksEdit = vi.fn();
    const { container } = setup({ onTasksEdit });
    cell(container, 'b', 'text').focus();
    const { e } = clipboardEvent('paste', 'From body');
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onTasksEdit.mock.calls[0]?.[0]).toEqual([{ id: 'b', patch: { text: 'From body' } }]);
  });

  test("SVAR's own Ctrl+C / V / X / D task hotkeys never see a grid-clipboard key", () => {
    // SVAR binds ctrl+c/v/x/d to copy/paste/cut/delete-task on a document
    // keydown listener: a copy then paste would insert a ghost task.
    const { container } = setup({ onTasksEdit: vi.fn() });
    const target = cell(container, 'a', 'text');
    target.focus();
    const seen: string[] = [];
    const svarLike = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener('keydown', svarLike);
    try {
      for (const key of ['c', 'v', 'x']) {
        // Default untouched: the browser still fires the native copy / paste.
        expect(fireEvent.keyDown(target, { key, ctrlKey: true })).toBe(true);
      }
      fireEvent.keyDown(target, { key: 'd', metaKey: true });
      // Cyrillic layout: key 'с', code KeyC — still the grid's.
      fireEvent.keyDown(target, { key: 'с', code: 'KeyC', ctrlKey: true });
      fireEvent.keyDown(target, { key: 'c' }); // plain typing is not ours
    } finally {
      document.removeEventListener('keydown', svarLike);
    }
    expect(seen).toEqual(['c']);
  });

  test('phantom baseline rows are not sheet rows: a column pastes onto consecutive tasks', () => {
    const onTasksEdit = vi.fn();
    const p = captureBaseline(project, 0);
    const { container } = setup({ project: p, baselineIndices: [0], onTasksEdit });
    const target = cell(container, 'a', 'text');
    target.focus();
    target.dispatchEvent(clipboardEvent('paste', 'One\nTwo').e);
    expect(onTasksEdit.mock.calls[0]?.[0]).toEqual([
      { id: 'a', patch: { text: 'One' } },
      { id: 'b', patch: { text: 'Two' } },
    ]);
  });

  test('copy with a text selection elsewhere is the browser’s own copy', () => {
    const { container } = setup();
    cell(container, 'a', 'text').focus();
    const outside = document.createElement('p');
    outside.textContent = 'some notes';
    document.body.appendChild(outside);
    try {
      const range = document.createRange();
      range.selectNodeContents(outside);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const { e } = clipboardEvent('copy');
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    } finally {
      window.getSelection()?.removeAllRanges();
      outside.remove();
    }
  });

  test('without onTasksEdit, each task falls back to onTaskEdit', () => {
    const { container, onTaskEdit } = setup();
    const target = cell(container, 'b', 'text');
    target.focus();
    target.dispatchEvent(clipboardEvent('paste', 'One\nTwo').e);
    expect(onTaskEdit.mock.calls).toEqual([
      ['b', { text: 'One' }],
      ['c', { text: 'Two' }],
    ]);
  });

  test('copy writes the cell editor value; paste of it round-trips', () => {
    const { container } = setup();
    const target = cell(container, 'a', 'text');
    target.focus();
    const { e, store } = clipboardEvent('copy');
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(store.get('text/plain')).toBe('Task a');
  });

  test('Ctrl+D fills from the row above', () => {
    const onTasksEdit = vi.fn();
    const { container } = setup({ onTasksEdit });
    const target = cell(container, 'b', 'text');
    target.focus();
    const handled = !fireEvent.keyDown(target, { key: 'd', ctrlKey: true });
    expect(handled).toBe(true); // default (bookmark) prevented
    expect(onTasksEdit).toHaveBeenCalledWith([{ id: 'b', patch: { text: 'Task a' } }], {
      source: 'fill',
      skipped: [],
    });
  });

  test('inside an open editor, paste is the browser’s own (not a grid paste)', () => {
    const onTasksEdit = vi.fn();
    const { container } = setup({ onTasksEdit });
    fireEvent.click(cell(container, 'a', 'text').querySelector('span') as Element);
    const input = cell(container, 'a', 'text').querySelector('input') as HTMLInputElement;
    const { e } = clipboardEvent('paste', 'x\ny');
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(onTasksEdit).not.toHaveBeenCalled();
  });

  // A host's read-only columns (`editable: false`, or a `render` without
  // `editable: true`) take no paste or fill: the same rule as the inline editor.
  test.each([
    ['editable: false', { editable: false }],
    ['a render without editable', { render: (task: Task) => <b>{task.text}</b> }],
  ])('a read-only column (%s) takes no paste or fill', (_label, extra) => {
    const onTasksEdit = vi.fn();
    const readOnly = [{ ...columns[0], ...extra }, columns[1]] as GanttColumn[];
    const { container, onTaskEdit } = setup({ onTasksEdit, columns: readOnly });
    const target = cell(container, 'b', 'text');
    target.focus();
    target.dispatchEvent(clipboardEvent('paste', 'x\ny').e);
    fireEvent.keyDown(target, { key: 'd', ctrlKey: true });
    const delivered = onTasksEdit.mock.calls.flatMap(([edits]) => edits as unknown[]);
    expect(delivered).toEqual([]);
    expect(onTaskEdit).not.toHaveBeenCalled();
  });

  test('gridClipboard={false} and editMode off leave the clipboard alone', () => {
    const onTasksEdit = vi.fn();
    const off = setup({ onTasksEdit, gridClipboard: false });
    const c1 = cell(off.container, 'a', 'text');
    const p1 = clipboardEvent('paste', 'x').e;
    c1.dispatchEvent(p1);
    expect(p1.defaultPrevented).toBe(false);
    off.unmount();
    const view = render(<Gantt project={project} columns={columns} onTasksEdit={onTasksEdit} />);
    const c2 = view.container.querySelector('.wx-cell') as HTMLElement;
    const p2 = clipboardEvent('paste', 'x').e;
    c2.dispatchEvent(p2);
    expect(p2.defaultPrevented).toBe(false);
    expect(onTasksEdit).not.toHaveBeenCalled();
  });
});
