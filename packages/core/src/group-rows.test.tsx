// Parity row 8 (core slice): groupProject's virtual group rows are read-only
// in editMode — their ids don't exist in the consumer's project, so no edit,
// structural or selection callback may fire for them (like phantom rows).
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { groupProject, schedule } from '@pyraxi/cpm-engine';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt, type GanttColumn } from './Gantt.js';

type Api = { exec(action: string, ev: unknown): unknown };
const captured: { api?: Api } = {};
vi.mock('@svar-ui/react-gantt', async (orig) => {
  const mod = (await orig()) as Record<string, unknown> & { Gantt: unknown };
  const Wrapped = (props: { init?: (api: Api) => void }) =>
    createElement(mod.Gantt as never, {
      ...props,
      init: (api: Api) => {
        captured.api = api;
        props.init?.(api);
      },
    });
  return { ...mod, Gantt: Wrapped };
});
afterEach(() => {
  cleanup();
  captured.api = undefined;
});

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const t = (id: string, trade: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5, 8),
  end: new Date(2026, 0, 5, 17),
  progress: 0,
  codes: { trade },
});
const base: Project = {
  start: new Date(2026, 0, 5, 8),
  defaultCalendarId: 'std',
  tasks: [t('a', 'plumb'), t('b', 'frame')],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};
const grouped = groupProject(schedule(base), 'trade');
const columns = [{ id: 'text', field: 'text', header: 'Name' }] as GanttColumn[];
const api = () => {
  if (!captured.api) throw new Error('api not captured');
  return captured.api;
};

describe('group rows are read-only in editMode', () => {
  test('the group row name renders but clicking it opens no editor', () => {
    const { container } = render(
      <Gantt project={grouped} columns={columns} editMode onTaskEdit={vi.fn()} />,
    );
    const cell = container.querySelector(
      '.wx-cell[data-row-id=":group:plumb"][data-col-id=":text"]',
    ) as HTMLElement;
    expect(cell.textContent).toContain('plumb');
    fireEvent.click(cell.querySelector('span') ?? cell);
    expect(cell.querySelector('input')).toBeNull();
  });

  test('SVAR edits and selection on a group row are vetoed / not surfaced', () => {
    const onTaskEdit = vi.fn();
    const onTaskSelect = vi.fn();
    render(
      <Gantt
        project={grouped}
        columns={columns}
        editMode
        onTaskEdit={onTaskEdit}
        onTaskSelect={onTaskSelect}
      />,
    );
    act(() => void api().exec('update-task', { id: 'group:plumb', task: { text: 'x' } }));
    act(() => void api().exec('select-task', { id: 'group:plumb' }));
    expect(onTaskEdit).not.toHaveBeenCalled();
    expect(onTaskSelect).not.toHaveBeenCalled();
  });

  test('structural gestures on a group row are vetoed', () => {
    const onStructuralCommit = vi.fn();
    render(
      <Gantt
        project={grouped}
        columns={columns}
        editMode
        onStructuralCommit={onStructuralCommit}
      />,
    );
    act(() => void api().exec('delete-task', { id: 'group:plumb' }));
    act(() => void api().exec('indent-task', { id: 'group:frame', mode: true }));
    expect(onStructuralCommit).not.toHaveBeenCalled();
  });

  test('real rows under a group stay editable', () => {
    const onTaskEdit = vi.fn();
    render(<Gantt project={grouped} columns={columns} editMode onTaskEdit={onTaskEdit} />);
    act(() => void api().exec('update-task', { id: 'a', task: { text: 'Pipework' } }));
    expect(onTaskEdit).toHaveBeenCalled();
  });
});
