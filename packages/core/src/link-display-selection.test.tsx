// linkDisplay="selected" × SVAR's real store (review of 39a9295). The SVAR api
// is captured by wrapping @svar-ui/react-gantt's Gantt `init`, as in
// view-state-zoom.test.tsx; vi.mock is hoisted per file.
import type { Calendar, Link, Project, Task } from '@pyraxi/cpm-engine';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';

type Api = { exec(action: string, ev: unknown): unknown; getState(): { selected?: unknown[] } };
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
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const t = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5, 8),
  end: new Date(2026, 0, 5, 17),
  progress: 0,
});
const fs = (s: string, d: string): Link => ({
  id: `${s}-${d}`,
  source: s,
  target: d,
  type: 'FS',
  lag: 0,
});
const project: Project = {
  start: new Date(2026, 0, 5, 8),
  defaultCalendarId: 'std',
  tasks: [t('a'), t('b'), t('c')],
  links: [fs('a', 'b'), fs('b', 'c')],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};

const api = () => {
  if (!captured.api) throw new Error('SVAR api not captured');
  return captured.api;
};
/** Drive SVAR's select-task inside act() so the Gantt's state update flushes. */
const select = (ev: { id: string; toggle?: boolean }) =>
  act(() => void api().exec('select-task', ev));
const lines = (el: HTMLElement) => el.querySelectorAll('.wx-line').length;
const selectedIds = () => (api().getState().selected ?? []).map(String);

describe('linkDisplay="selected" keeps SVAR selection intact', () => {
  test('selecting a task draws its links AND keeps it selected in SVAR', () => {
    const { container } = render(<Gantt project={project} linkDisplay="selected" />);
    expect(lines(container)).toBe(0);
    select({ id: 'b' });
    expect(lines(container)).toBe(2);
    expect(selectedIds()).toEqual(['b']);
    select({ id: 'a' });
    expect(lines(container)).toBe(1);
    expect(selectedIds()).toEqual(['a']);
  });

  test('a toggle that deselects the task hides its links', () => {
    const { container } = render(<Gantt project={project} linkDisplay="selected" />);
    select({ id: 'b' });
    select({ id: 'b', toggle: true });
    expect(selectedIds()).toEqual([]);
    expect(lines(container)).toBe(0);
  });

  test('multi-select draws the links of every selected task', () => {
    const { container } = render(<Gantt project={project} linkDisplay="selected" />);
    select({ id: 'a' });
    select({ id: 'c', toggle: true });
    expect(selectedIds().sort()).toEqual(['a', 'c']);
    expect(lines(container)).toBe(2);
  });

  test('switching into "selected" uses the selection made while in another mode', () => {
    const { container, rerender } = render(<Gantt project={project} linkDisplay="all" />);
    select({ id: 'a' });
    rerender(<Gantt project={project} linkDisplay="selected" />);
    expect(lines(container)).toBe(1);
  });

  test('a host re-render with a new project object keeps SVAR selection', () => {
    const { rerender } = render(<Gantt project={project} />);
    select({ id: 'b' });
    rerender(<Gantt project={{ ...project }} />);
    expect(selectedIds()).toEqual(['b']);
  });

  test('deleting the selected task does not crash and drops its links', () => {
    const { container, rerender } = render(<Gantt project={project} linkDisplay="selected" />);
    select({ id: 'b' });
    const without = {
      ...project,
      tasks: project.tasks.filter((x) => x.id !== 'b'),
      links: [],
    };
    expect(() => rerender(<Gantt project={without} linkDisplay="selected" />)).not.toThrow();
    expect(lines(container)).toBe(0);
  });
});
