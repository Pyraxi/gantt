import { fireEvent, render } from '@testing-library/react';
import type { FC, ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { GanttColumn, GanttColumnEditor } from './Gantt';
import { buildCustomEditableCell, buildEditableCell, isColumnEditable } from './Gantt';

const col = (o: Partial<GanttColumn>): GanttColumn =>
  ({ id: 'start', header: 'Start', field: 'start', ...o }) as GanttColumn;

describe('isColumnEditable', () => {
  test('field column with no render → editable in editMode (unchanged default)', () => {
    expect(isColumnEditable(col({}), true)).toBe(true);
  });
  test('render-bearing column → NOT editable by default (today behavior)', () => {
    expect(isColumnEditable(col({ render: (() => null) as GanttColumn['render'] }), true)).toBe(
      false,
    );
  });
  test('render-bearing column with editable:true → editable (the new capability)', () => {
    expect(
      isColumnEditable(
        col({ render: (() => null) as GanttColumn['render'], editable: true }),
        true,
      ),
    ).toBe(true);
  });
  test('editable:false forces read-only even without a render', () => {
    expect(isColumnEditable(col({ editable: false }), true)).toBe(false);
  });
  test('non-editable field is never editable', () => {
    expect(
      isColumnEditable(
        col({ id: 'trade', field: 'trade' as GanttColumn['field'], editable: true }),
        true,
      ),
    ).toBe(false);
  });
  test('editMode off → never editable', () => {
    expect(isColumnEditable(col({}), false)).toBe(false);
  });
});

describe('buildEditableCell displayRender', () => {
  test('inactive cell renders displayRender output, not the built-in formatted value', () => {
    // Minimal inactive edit-state: no active cell → cell renders its display form.
    const editStateRef = { current: { activeCell: undefined } } as never;
    const onTaskEditRef = { current: undefined } as never;
    const Custom = ({ task }: { task: { id: unknown } }) => (
      <b data-testid="fmt">FMT-{String(task.id)}</b>
    );
    const Cell = buildEditableCell('start', editStateRef, onTaskEditRef, Custom as never) as (p: {
      row: unknown;
    }) => ReactNode;
    const row = { id: 'x', type: 'task', start: new Date(2026, 0, 5), duration: 480, progress: 0 };
    const { getByTestId } = render(Cell({ row }));
    expect(getByTestId('fmt').textContent).toBe('FMT-x');
  });
});

describe('buildEditableCell duration unit — SVAR grid rows are in working DAYS', () => {
  // The SVAR store row carries `duration` in working days (toSvarTask converts
  // it when a calendar is present). Feeding that straight into the minutes-based
  // formatter made a 3-day task read "3m" and a blur commit `duration: 3` minutes.
  const MPD = 480; // 8h working day

  test('inactive duration cell displays a day-unit row as days, not "3m"', () => {
    const editStateRef = { current: { activeCell: undefined } } as never;
    const onTaskEditRef = { current: undefined } as never;
    const Cell = buildEditableCell('duration', editStateRef, onTaskEditRef, undefined, MPD) as (p: {
      row: unknown;
    }) => ReactNode;
    // 3 = three working DAYS in SVAR's store.
    const row = { id: 'x', type: 'task', duration: 3, progress: 0 };
    const { container } = render(Cell({ row }));
    expect(container.textContent).toBe('3d');
    expect(container.textContent).not.toContain('3m');
  });

  test('activating the cell seeds the input in days (not minutes)', () => {
    const activateCell = vi.fn();
    const editStateRef = { current: { activeCell: undefined, activateCell } } as never;
    const onTaskEditRef = { current: undefined } as never;
    const Cell = buildEditableCell('duration', editStateRef, onTaskEditRef, undefined, MPD) as (p: {
      row: unknown;
    }) => ReactNode;
    const row = { id: 'x', type: 'task', duration: 3, progress: 0 };
    const { container } = render(Cell({ row }));
    fireEvent.click(container.querySelector('span[style]') as Element);
    expect(activateCell).toHaveBeenCalledWith('x', 'duration', '3d');
  });

  test('without a minutesPerDay (no calendar) the value passes through as minutes', () => {
    const editStateRef = { current: { activeCell: undefined } } as never;
    const onTaskEditRef = { current: undefined } as never;
    const Cell = buildEditableCell('duration', editStateRef, onTaskEditRef) as (p: {
      row: unknown;
    }) => ReactNode;
    // 480 raw minutes = one working day when no calendar-based conversion applied.
    const row = { id: 'x', type: 'task', duration: 480, progress: 0 };
    const { container } = render(Cell({ row }));
    expect(container.textContent).toBe('1d');
  });
});

describe('buildCustomEditableCell (custom-column onCellEdit)', () => {
  const tradeCol: GanttColumn = {
    id: 'trade',
    header: 'Trade',
    render: (({ task }: { task: { extra?: Record<string, unknown> } }) => (
      <span>{String(task.extra?.trade ?? '')}</span>
    )) as unknown as GanttColumn['render'],
  };
  const editor: GanttColumnEditor = {
    type: 'text',
    getValue: (t) => String((t as { extra?: Record<string, unknown> }).extra?.trade ?? ''),
  };
  const row = { id: 'x', type: 'task', extra: { trade: 'Builder' } };

  test('inactive cell shows render display; click activates a text input seeded with getValue', () => {
    const onCellEdit = vi.fn();
    const Cell = buildCustomEditableCell(
      editor,
      'trade',
      { current: onCellEdit },
      tradeCol.render,
    ) as FC<{
      row: unknown;
    }>;
    const { container } = render(<Cell row={row} />);
    expect(container.textContent).toContain('Builder');
    fireEvent.click(container.querySelector('span[style]') as Element);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('Builder');
  });

  test('commit on Enter with a changed value fires onCellEdit(id, columnId, value)', () => {
    const onCellEdit = vi.fn();
    const Cell = buildCustomEditableCell(
      editor,
      'trade',
      { current: onCellEdit },
      tradeCol.render,
    ) as FC<{
      row: unknown;
    }>;
    const { container } = render(<Cell row={row} />);
    fireEvent.click(container.querySelector('span[style]') as Element);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Plumber' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCellEdit).toHaveBeenCalledWith('x', 'trade', 'Plumber');
  });

  test('committing an UNCHANGED value does not fire onCellEdit', () => {
    const onCellEdit = vi.fn();
    const Cell = buildCustomEditableCell(
      editor,
      'trade',
      { current: onCellEdit },
      tradeCol.render,
    ) as FC<{
      row: unknown;
    }>;
    const { container } = render(<Cell row={row} />);
    fireEvent.click(container.querySelector('span[style]') as Element);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' }); // value still 'Builder'
    expect(onCellEdit).not.toHaveBeenCalled();
  });

  test('select editor renders options and commits the chosen value on change', () => {
    const onCellEdit = vi.fn();
    const selectEditor: GanttColumnEditor = {
      type: 'select',
      options: [
        { value: 'B', label: 'Builder' },
        { value: 'P', label: 'Plumber' },
      ],
      getValue: () => 'B',
    };
    const Cell = buildCustomEditableCell(
      selectEditor,
      'trade',
      { current: onCellEdit },
      tradeCol.render,
    ) as FC<{
      row: unknown;
    }>;
    const { container } = render(<Cell row={row} />);
    fireEvent.click(container.querySelector('span[style]') as Element);
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.querySelectorAll('option')).toHaveLength(2);
    fireEvent.change(select, { target: { value: 'P' } });
    expect(onCellEdit).toHaveBeenCalledWith('x', 'trade', 'P');
  });

  test('select: blur without an explicit pick does NOT commit (guards current-not-in-options)', () => {
    const onCellEdit = vi.fn();
    // getValue returns a legacy value absent from options → the <select> displays
    // option[0]; a bare blur must not silently overwrite the field with it.
    const selectEditor: GanttColumnEditor = {
      type: 'select',
      options: [
        { value: 'B', label: 'Builder' },
        { value: 'P', label: 'Plumber' },
      ],
      getValue: () => 'LegacyTrade',
    };
    const Cell = buildCustomEditableCell(
      selectEditor,
      'trade',
      { current: onCellEdit },
      tradeCol.render,
    ) as FC<{ row: unknown }>;
    const { container } = render(<Cell row={row} />);
    fireEvent.click(container.querySelector('span[style]') as Element);
    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.blur(select);
    expect(onCellEdit).not.toHaveBeenCalled();
  });

  test('Escape cancels without firing onCellEdit', () => {
    const onCellEdit = vi.fn();
    const Cell = buildCustomEditableCell(
      editor,
      'trade',
      { current: onCellEdit },
      tradeCol.render,
    ) as FC<{
      row: unknown;
    }>;
    const { container } = render(<Cell row={row} />);
    fireEvent.click(container.querySelector('span[style]') as Element);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Plumber' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCellEdit).not.toHaveBeenCalled();
  });
});
