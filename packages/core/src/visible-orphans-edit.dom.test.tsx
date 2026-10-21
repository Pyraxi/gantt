// Re-rooted rows (visibleTaskIds, parent filtered out) must not let a gesture
// file a task under a summary the user can't see (e.g. a host's trade filters
// that leave summaries out). Separate file: vi.mock is hoisted per file.
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';
import { placesUnderHidden } from './visible-tree.js';

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
const api = () => captured.api as Api;

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const t = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
// S > (G > c), P > (x); the trade filter shows c and x only.
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [
    t('S', { type: 'summary' }),
    t('G', { type: 'summary', parent: 'S' }),
    t('c', { parent: 'G' }),
    t('P', { type: 'summary' }),
    t('x', { parent: 'P' }),
  ],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};
const filter = new Set(['c', 'x']);

test('placesUnderHidden: only a newly hidden parent counts', () => {
  expect(placesUnderHidden([{ id: 'x', parent: 'G' }], project.tasks, filter)).toBe(true);
  // Unchanged parents (e.g. a hidden summary demoted as a side effect) pass.
  expect(placesUnderHidden([{ id: 'P', parent: null }], project.tasks, filter)).toBe(false);
  expect(placesUnderHidden([{ id: 'c', parent: 'G' }], project.tasks, filter)).toBe(false);
  // Top level, or under a visible task, is fine; no filter, no veto.
  expect(placesUnderHidden([{ id: 'x', parent: null }], project.tasks, filter)).toBe(false);
  expect(placesUnderHidden([{ id: 'x', parent: 'G' }], project.tasks, undefined)).toBe(false);
  // A new task (not in the project) under a hidden parent.
  expect(placesUnderHidden([{ parent: 'G' }], project.tasks, filter)).toBe(true);
});

test('bolt-in: dragging x after c (parent G, hidden) is vetoed', () => {
  const onStructuralCommit = vi.fn();
  render(
    <Gantt
      project={project}
      editMode
      visibleTaskIds={filter}
      onStructuralCommit={onStructuralCommit}
    />,
  );
  act(
    () => void api().exec('move-task', { id: 'x', target: 'c', mode: 'after', inProgress: false }),
  );
  expect(onStructuralCommit).not.toHaveBeenCalled();
});

test('thin path: add after c (would land under hidden G) is vetoed', () => {
  const onTaskAdd = vi.fn();
  render(<Gantt project={project} editMode visibleTaskIds={filter} onTaskAdd={onTaskAdd} />);
  act(() => void api().exec('add-task', { task: { text: 'New' }, target: 'c', mode: 'after' }));
  expect(onTaskAdd).not.toHaveBeenCalled();
});

test('without a filter the same drag commits (no change on main behaviour)', () => {
  const onStructuralCommit = vi.fn();
  render(<Gantt project={project} editMode onStructuralCommit={onStructuralCommit} />);
  act(
    () => void api().exec('move-task', { id: 'x', target: 'c', mode: 'after', inProgress: false }),
  );
  expect(onStructuralCommit).toHaveBeenCalledTimes(1);
});
