// Editable predecessors column (parity row 1 gap, step 2): MS Project-style text
// in the grid → onCellEdit → parsePredecessors + setPredecessors.
import { type Link, type Project, setPredecessors, type Task } from '@pyraxi/cpm-engine';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt';
import { parsePredecessors } from './predecessor-input';
import { predecessorsColumn } from './predecessors';

afterEach(cleanup);

const MON = new Date(2026, 0, 5, 8);
const t = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: MON,
  end: MON,
  progress: 0,
});
const tasks = [t('a'), t('b'), t('c')];
const links: Link[] = [{ id: 'a->b', source: 'a', target: 'b', type: 'FS', lag: 0 }];
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links,
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
const opts = { tasks, minutesPerDay: 540 };
const cell = (root: HTMLElement, row: string) =>
  root.querySelector(`.wx-cell[data-row-id=":${row}"][data-col-id=":predecessors"]`) as HTMLElement;

function setup() {
  const onCellEdit = vi.fn();
  const r = render(
    <Gantt
      project={project}
      editMode
      columns={[predecessorsColumn(links, { ...opts, editable: true })]}
      onCellEdit={onCellEdit}
    />,
  );
  const open = (row: string) => {
    fireEvent.click(
      cell(r.container, row).querySelector('.construction-gantt-cell-text') as Element,
    );
    return cell(r.container, row).querySelector('input') as HTMLInputElement;
  };
  return { ...r, onCellEdit, open };
}

describe('editable predecessors column', () => {
  test('opens with the formatted value; a valid edit commits through onCellEdit', () => {
    const { open, onCellEdit } = setup();
    const input = open('b');
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: '1SS+1d' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCellEdit).toHaveBeenCalledWith('b', 'predecessors', '1SS+1d');
  });

  test('unreadable text or a loop stays open, marked invalid with the reason', () => {
    const { open, onCellEdit, container } = setup();
    const input = open('a');
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.title).toContain('no row 9');
    fireEvent.change(input, { target: { value: '1' } });
    // Typing clears the mark until the next Enter.
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.title).toBe('');
    fireEvent.change(input, { target: { value: '2' } }); // b already follows a → loop
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.title).toContain('loop');
    expect(onCellEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cell(container, 'a').querySelector('input')).toBeNull();
  });

  test('host wiring: parse + setPredecessors applies it as one command', () => {
    const parsed = parsePredecessors('1SS+1d', { ...opts, targetId: 'b' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = setPredecessors('b', parsed.preds).apply(project);
    expect(next.links).toEqual([{ id: 'a->b', source: 'a', target: 'b', type: 'SS', lag: 540 }]);
  });
});
