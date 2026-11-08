// CM grid/bar polish batch (to-gantt 2026-07-13 / 07-14 / 07-16):
//  - grid cells ellipsize + carry a hover title when clipped (never hard-clip mid-word)
//  - in-bar pills follow an overflowing label beside the bar (no label/pill collision)
//  - themable pill + checkbox colours
//  - leadInDays timeline padding before the project start
// happy-dom has no layout, so scrollWidth/clientWidth are stubbed where overflow matters.

import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { CellText } from './cell-text.js';
import { DisplayOptionsBar } from './DisplayOptionsBar.js';
import {
  buildCustomEditableCell,
  buildEditableCell,
  ConstructionBar,
  resolveTimelineStart,
} from './Gantt.js';
import { predecessorsColumn } from './predecessors.js';

afterEach(cleanup);

function withMeasuredWidths(scroll: number, client: number, fn: () => void) {
  const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => scroll,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => client,
  });
  try {
    fn();
  } finally {
    // happy-dom defines these above HTMLElement.prototype, so there may be no own
    // descriptor to restore — delete the stub instead of leaking it to later tests.
    if (sw) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', sw);
    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    if (cw) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
}

function expectEllipsis(el: Element) {
  const s = getComputedStyle(el);
  expect(s.overflow).toBe('hidden');
  expect(s.textOverflow).toBe('ellipsis');
  expect(s.whiteSpace).toBe('nowrap');
  expect(s.display).toBe('block');
}

describe('CellText — single-line ellipsis + title only when clipped', () => {
  test('carries the class Gantt.css keys column align on (SVAR aligns via flex, not text-align)', () => {
    const { getByText } = render(<CellText>9</CellText>);
    expect(getByText('9').classList.contains('construction-gantt-cell-text')).toBe(true);
  });

  test('applies block ellipsis styling', () => {
    const { getByText } = render(<CellText>Site Specific Documentation</CellText>);
    expectEllipsis(getByText('Site Specific Documentation'));
  });

  test('clipped content → hover sets title to the full text', () => {
    withMeasuredWidths(300, 100, () => {
      const { getByText } = render(<CellText>Site Specific Documentation</CellText>);
      const el = getByText('Site Specific Documentation');
      fireEvent.mouseEnter(el);
      expect(el.getAttribute('title')).toBe('Site Specific Documentation');
    });
  });

  test('fitting content → no title', () => {
    withMeasuredWidths(100, 100, () => {
      const { getByText } = render(<CellText>Short</CellText>);
      const el = getByText('Short');
      fireEvent.mouseEnter(el);
      expect(el.hasAttribute('title')).toBe(false);
    });
  });

  test('title reflects rendered text of custom content (e.g. a predecessors render)', () => {
    withMeasuredWidths(300, 100, () => {
      const { container } = render(
        <CellText>
          <span>4FS+3 days, 7</span>
        </CellText>,
      );
      const el = container.firstElementChild as HTMLElement;
      fireEvent.mouseEnter(el);
      expect(el.getAttribute('title')).toBe('4FS+3 days, 7');
    });
  });
});

describe('editable cells use CellText for their inactive display (CM editMode clip bug)', () => {
  const editStateRef = { current: { activeCell: undefined } } as never;
  const onTaskEditRef = { current: undefined } as never;
  const row = {
    id: 'x',
    type: 'task',
    text: 'Internal Elevations & Joinery Drawings',
    start: new Date(2026, 0, 5),
    duration: 1,
    progress: 0,
  };

  test('buildEditableCell text field → ellipsized block, not a hard-clipped block', () => {
    const Cell = buildEditableCell('text', editStateRef, onTaskEditRef) as (p: {
      row: unknown;
    }) => ReactNode;
    const { getByText } = render(Cell({ row }) as ReactElement);
    expectEllipsis(getByText(row.text));
  });

  test('buildEditableCell read-only summary cell is ellipsized too', () => {
    const Cell = buildEditableCell('start', editStateRef, onTaskEditRef) as (p: {
      row: unknown;
    }) => ReactNode;
    const { container } = render(Cell({ row: { ...row, type: 'summary' } }) as ReactElement);
    expectEllipsis(container.firstElementChild as Element);
  });

  test('buildCustomEditableCell display is ellipsized', () => {
    const Cell = buildCustomEditableCell(
      { type: 'text', getValue: () => 'A very long custom value' },
      'custom',
      { current: undefined },
    ) as (p: { row: unknown }) => ReactNode;
    const C = Cell as unknown as (p: { row: unknown }) => ReactNode;
    const { getByText } = render(<C row={row} />);
    expectEllipsis(getByText('A very long custom value'));
  });
});

describe('consumer render output is never clipped (CM Trade/Sub pills)', () => {
  const editStateRef = { current: { activeCell: undefined } } as never;
  const onTaskEditRef = { current: undefined } as never;
  const row = { id: 'x', type: 'task', text: 'T', start: new Date(2026, 0, 5), duration: 1 };
  const Pill = () => <b data-testid="pill">Plumbing</b>;

  test('editable cell with a displayRender → full-width block, no overflow clip / nowrap', () => {
    const Cell = buildEditableCell('start', editStateRef, onTaskEditRef, Pill as never) as (p: {
      row: unknown;
    }) => ReactNode;
    const { getByTestId } = render(Cell({ row }) as ReactElement);
    const host = getByTestId('pill').parentElement as HTMLElement;
    expect(host.classList.contains('construction-gantt-cell-text')).toBe(true); // align still applies
    expect(getComputedStyle(host).overflow).not.toBe('hidden');
    expect(getComputedStyle(host).whiteSpace).not.toBe('nowrap');
  });

  test('custom editable cell with a displayRender → not clipped', () => {
    const Cell = buildCustomEditableCell(
      { type: 'text', getValue: () => 'Plumbing' },
      'trade',
      { current: undefined },
      Pill as never,
    ) as unknown as (p: { row: unknown }) => ReactNode;
    const C = Cell as unknown as (p: { row: unknown }) => ReactElement;
    const { getByTestId } = render(<C row={row} />);
    expect(getComputedStyle(getByTestId('pill').parentElement as HTMLElement).overflow).not.toBe(
      'hidden',
    );
  });

  test('built-in predecessorsColumn cell is ellipsized (CM: clipped predecessor cells)', () => {
    const col = predecessorsColumn([
      { id: 'l1', source: 'a', target: 'x', type: 'FS', lag: 0 },
    ] as never);
    const Render = col.render as (p: { task: unknown }) => ReactElement;
    const { getByText } = render(<Render task={row} />);
    expectEllipsis(getByText('a'));
  });
});

describe('ConstructionBar — pills follow an overflowing label (float/label collision)', () => {
  const barData = {
    id: 'x',
    text: 'Typology Creation from Template File',
    type: 'task' as const,
    start: new Date(2026, 0, 5),
    end: new Date(2026, 0, 6),
    duration: 1,
    progress: 0,
    total_slack: 4 * 540, // 4d float → float pill shown
  };

  test('overflowing label → visible float pill sits inside the beside-bar label, after the text', () => {
    withMeasuredWidths(500, 100, () => {
      const { container } = render(<ConstructionBar data={barData} />);
      const beside = container.querySelector('.construction-gantt-bar-label-out') as HTMLElement;
      expect(beside).not.toBeNull();
      expect(beside.textContent).toBe(`${barData.text}4d float`);
      // the in-bar pill copy stays laid out (stable measurement) but hidden
      const inBarPills = [...container.querySelectorAll('span')].filter(
        (s) =>
          s.textContent === '4d float' && !s.hasAttribute('data-cg-pills') && !beside.contains(s),
      );
      expect(inBarPills.length).toBe(1);
      const hiddenAncestor = inBarPills[0]?.closest('[data-cg-pills]') as HTMLElement;
      expect(getComputedStyle(hiddenAncestor).visibility).toBe('hidden');
    });
  });

  test('beside-bar pills stay hoverable (their titles explain them) while the label text does not', () => {
    withMeasuredWidths(500, 100, () => {
      const { container } = render(<ConstructionBar data={barData} />);
      const beside = container.querySelector('.construction-gantt-bar-label-out') as HTMLElement;
      expect(getComputedStyle(beside).pointerEvents).toBe('none');
      const pill = beside.querySelector('[title^="Total float"]') as HTMLElement;
      // happy-dom doesn't compute inherited pointer-events; check the pill group's own style.
      expect((pill.parentElement as HTMLElement).style.pointerEvents).toBe('auto');
    });
  });

  test('fitting label → float pill in the bar, visible; no beside label', () => {
    withMeasuredWidths(100, 100, () => {
      const { container } = render(<ConstructionBar data={barData} />);
      expect(container.querySelector('.construction-gantt-bar-label-out')).toBeNull();
      const pills = container.querySelector('[data-cg-pills]') as HTMLElement;
      expect(pills.textContent).toBe('4d float');
      expect(getComputedStyle(pills).visibility).toBe('visible');
    });
  });

  test('no pills → no pill wrapper (label keeps its full width)', () => {
    const { container } = render(<ConstructionBar data={{ ...barData, total_slack: 0 }} />);
    expect(container.querySelector('[data-cg-pills]')).toBeNull();
  });
});

describe('themable colours', () => {
  test('float pill colours read --cg-pill-float-* tokens with the old defaults as fallback', () => {
    // Static markup: happy-dom drops var() values from parsed background/color.
    const html = renderToStaticMarkup(
      <ConstructionBar
        data={{
          id: 'x',
          text: 'T',
          type: 'task',
          start: new Date(2026, 0, 5),
          end: new Date(2026, 0, 6),
          duration: 1,
          progress: 0,
          total_slack: 2 * 540,
        }}
      />,
    );
    expect(html).toContain('2d float');
    expect(html).toContain('var(--cg-pill-float-bg, #dbeafe)');
    expect(html).toContain('var(--cg-pill-float-color, #1e3a8a)');
  });

  test('displayOptions checkboxes follow --wx-color-primary', () => {
    const { container } = render(
      <DisplayOptionsBar
        state={{ critical: true, slack: true, deadline: true, hiddenColumns: [] }}
        columnOptions={[{ id: 'start', label: 'Start' }]}
        showColumns
        showSignals
        onToggleColumn={() => {}}
        onToggleSignal={() => {}}
      />,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect((b as HTMLElement).style.accentColor).toContain('--wx-color-primary');
    }
  });
});

describe('resolveTimelineStart — leadInDays padding before the project start', () => {
  const start = new Date(2026, 0, 8, 8, 0);
  test('undefined / 0 → project start unchanged (default behaviour)', () => {
    expect(resolveTimelineStart(start, undefined)).toBe(start);
    expect(resolveTimelineStart(start, 0)).toBe(start);
  });
  test('N days → N calendar days earlier, same time of day', () => {
    expect(resolveTimelineStart(start, 3)).toEqual(new Date(2026, 0, 5, 8, 0));
  });
  test('absurd values are capped (no Invalid Date handed to SVAR)', () => {
    expect(Number.isNaN(resolveTimelineStart(start, 1e9).getTime())).toBe(false);
  });
  test('negative / non-finite → ignored', () => {
    expect(resolveTimelineStart(start, -2)).toBe(start);
    expect(resolveTimelineStart(start, Number.NaN)).toBe(start);
  });
});

describe('inline editors keep focus inside SVAR grid cells (pre-existing focus-steal)', () => {
  // SVAR's grid cell has a React onFocus that re-execs `focus-cell`, whose effect
  // calls cell.focus() — stealing focus from our just-mounted input, whose blur
  // then commits + closes it. The editor's focus must not bubble to the cell.
  test('buildEditableCell active input does not propagate focus to its cell', () => {
    const editStateRef = {
      current: {
        activeCell: { taskId: 'x', field: 'text' },
        dirtyValue: 'T',
        setValue() {},
        commitCell() {},
        cancelCell() {},
      },
    } as never;
    const Cell = buildEditableCell('text', editStateRef, { current: undefined } as never) as (p: {
      row: unknown;
    }) => ReactNode;
    let cellFocused = 0;
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for SVAR's focusable grid cell
      <div onFocus={() => cellFocused++}>
        {Cell({ row: { id: 'x', type: 'task', text: 'T', duration: 1 } })}
      </div>,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.focus(input);
    expect(cellFocused).toBe(0);
  });

  test('buildCustomEditableCell open editor does not propagate focus to its cell', () => {
    const Cell = buildCustomEditableCell({ type: 'text', getValue: () => 'v' }, 'custom', {
      current: undefined,
    }) as unknown as (p: { row: unknown }) => ReactElement;
    let cellFocused = 0;
    const { container, getByText } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for SVAR's focusable grid cell
      <div onFocus={() => cellFocused++}>
        <Cell row={{ id: 'x', type: 'task', text: 'T', duration: 1 }} />
      </div>,
    );
    fireEvent.click(getByText('v'));
    cellFocused = 0; // autoFocus on mount may already have fired; measure an explicit focus
    fireEvent.focus(container.querySelector('input') as HTMLInputElement);
    expect(cellFocused).toBe(0);
  });
});

describe('inline editors survive SVAR re-focusing their own cell', () => {
  // SVAR remounts the cell when columns rebuild on activation; its mount effect
  // calls cell.focus(), blurring our input. A blur whose relatedTarget is the
  // editor's own .wx-cell is that programmatic steal — not the user leaving —
  // so it must not commit/close the editor.
  function setup(commitCell: () => void) {
    const editStateRef = {
      current: {
        activeCell: { taskId: 'x', field: 'text' },
        dirtyValue: 'T',
        setValue() {},
        commitCell,
        cancelCell() {},
      },
    } as never;
    const Cell = buildEditableCell('text', editStateRef, { current: undefined } as never) as (p: {
      row: unknown;
    }) => ReactNode;
    const { container } = render(
      // Stands in for SVAR's focusable grid cell (tabIndex makes it a valid relatedTarget).
      <div className="wx-cell" tabIndex={-1}>
        {Cell({ row: { id: 'x', type: 'task', text: 'T', duration: 1 } })}
      </div>,
    );
    return {
      input: container.querySelector('input') as HTMLInputElement,
      cell: container.querySelector('.wx-cell') as HTMLElement,
    };
  }

  test('blur to its own cell → no commit', () => {
    let commits = 0;
    const { input, cell } = setup(() => commits++);
    fireEvent.blur(input, { relatedTarget: cell });
    expect(commits).toBe(0);
  });

  test('blur elsewhere → commits as before', () => {
    let commits = 0;
    const { input } = setup(() => commits++);
    fireEvent.blur(input, { relatedTarget: null });
    expect(commits).toBe(1);
  });
});

describe('inline editors keep their own mouse + keyboard (SVAR grid handlers must not see them)', () => {
  // SVAR's .wx-body onMouseDown focuses .wx-table-box on every mousedown (a click
  // inside the editor closed it), and grid-store's document hotkeys move focus on
  // arrows (ArrowDown on a select jumped rows; date-segment arrows were eaten).
  function engineInput() {
    const editStateRef = {
      current: {
        activeCell: { taskId: 'x', field: 'start' },
        dirtyValue: '2026-01-05',
        setValue() {},
        commitCell() {},
        cancelCell() {},
      },
    } as never;
    return buildEditableCell('start', editStateRef, { current: undefined } as never) as (p: {
      row: unknown;
    }) => ReactNode;
  }
  const row = { id: 'x', type: 'task', text: 'T', start: new Date(2026, 0, 5), duration: 1 };

  test('engine input: mousedown + arrow keydown do not bubble', () => {
    const Cell = engineInput();
    const seen: string[] = [];
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for SVAR's grid body
      <div onMouseDown={() => seen.push('mousedown')} onKeyDown={() => seen.push('keydown')}>
        {Cell({ row })}
      </div>,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.mouseDown(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(seen).toEqual([]);
  });

  test('custom select + text editors: mousedown + arrow keydown do not bubble', () => {
    for (const type of ['select', 'text'] as const) {
      const Cell = buildCustomEditableCell(
        { type, getValue: () => 'a', options: [{ value: 'a' }, { value: 'b' }] },
        'trade',
        { current: undefined },
      ) as unknown as (p: { row: unknown }) => ReactElement;
      const seen: string[] = [];
      const { container, getByText, unmount } = render(
        // biome-ignore lint/a11y/noStaticElementInteractions: stands in for SVAR's grid body
        <div onMouseDown={() => seen.push('mousedown')} onKeyDown={() => seen.push('keydown')}>
          <Cell row={row} />
        </div>,
      );
      fireEvent.click(getByText('a'));
      const editor = container.querySelector(type === 'select' ? 'select' : 'input') as HTMLElement;
      fireEvent.mouseDown(editor);
      fireEvent.keyDown(editor, { key: 'ArrowDown' });
      expect(seen, type).toEqual([]);
      unmount();
    }
  });
});

describe('focus that lands on the editor’s own cell bounces straight back (no keystroke gap)', () => {
  test('cell.focus() while editing → editor refocused synchronously; cell onFocus never fires', () => {
    const editStateRef = {
      current: {
        activeCell: { taskId: 'x', field: 'text' },
        dirtyValue: 'T',
        setValue() {},
        commitCell() {},
        cancelCell() {},
      },
    } as never;
    const Cell = buildEditableCell('text', editStateRef, { current: undefined } as never) as (p: {
      row: unknown;
    }) => ReactNode;
    let cellOnFocus = 0;
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for SVAR's focusable grid cell (its React onFocus re-execs focus-cell)
      <div className="wx-cell" tabIndex={-1} onFocus={() => cellOnFocus++}>
        {Cell({ row: { id: 'x', type: 'task', text: 'T', duration: 1 } })}
      </div>,
    );
    const cell = container.querySelector('.wx-cell') as HTMLElement;
    const input = container.querySelector('input') as HTMLInputElement;
    input.focus();
    cellOnFocus = 0;
    cell.focus(); // SVAR's effect steal
    expect(document.activeElement).toBe(input);
    expect(cellOnFocus).toBe(0);
  });
});

describe('editor pointer events never reach SVAR’s NATIVE grid listeners', () => {
  // SVAR's row-reorder drag and its delegated grid click are native listeners
  // below React's root, so a React-level stopPropagation can't stop them: a
  // text-select drag inside an editor started a row reorder (CM: a persisted
  // onStructuralCommit), and in-editor clicks triggered a focus steal.
  test('mousedown / touchstart / click on an open editor do not bubble natively', () => {
    const editStateRef = {
      current: {
        activeCell: { taskId: 'x', field: 'text' },
        dirtyValue: 'T',
        setValue() {},
        commitCell() {},
        cancelCell() {},
      },
    } as never;
    const Cell = buildEditableCell('text', editStateRef, { current: undefined } as never) as (p: {
      row: unknown;
    }) => ReactNode;
    const { container } = render(
      <div className="wx-cell" tabIndex={-1}>
        {Cell({ row: { id: 'x', type: 'task', text: 'T', duration: 1 } })}
      </div>,
    );
    const seen: string[] = [];
    const host = container.querySelector('.wx-cell') as HTMLElement;
    for (const t of ['mousedown', 'touchstart', 'click', 'dblclick', 'contextmenu'])
      host.addEventListener(t, () => seen.push(t));
    const input = container.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.dispatchEvent(new Event('touchstart', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // dblclick → SVAR show-editor / onTaskEditRequest; contextmenu → the task
    // structural menu (Delete/Indent/Move) instead of the native paste menu.
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(seen).toEqual([]);
  });
});

test('custom select editor: Escape closes it without committing', () => {
  let commits = 0;
  const Cell = buildCustomEditableCell(
    { type: 'select', getValue: () => 'a', options: [{ value: 'a' }, { value: 'b' }] },
    'trade',
    { current: () => commits++ },
  ) as unknown as (p: { row: unknown }) => ReactElement;
  const { container, getByText } = render(
    <Cell row={{ id: 'x', type: 'task', text: 'T', duration: 1 }} />,
  );
  fireEvent.click(getByText('a'));
  fireEvent.keyDown(container.querySelector('select') as HTMLSelectElement, { key: 'Escape' });
  expect(container.querySelector('select')).toBeNull();
  expect(commits).toBe(0);
});
