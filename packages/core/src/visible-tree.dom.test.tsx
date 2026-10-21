// visibleTaskIds contract (ADR-005): every matching task renders. A task whose
// parent is filtered out used to vanish — SVAR attached it to no node.
import type { Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Gantt } from './Gantt.js';
import { reRootOrphans } from './visible-tree.js';

afterEach(cleanup);

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
// S > (G > c), x
const tasks = [
  t('S', { type: 'summary' }),
  t('G', { type: 'summary', parent: 'S' }),
  t('c', { parent: 'G' }),
  t('x'),
];
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links: [],
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

describe('reRootOrphans', () => {
  test('a visible self-parented task re-roots to the top level', () => {
    const selfish = [t('A', { parent: 'A' }), t('z')];
    expect(reRootOrphans(selfish, selfish).map((x) => [x.id, x.parent])).toEqual([
      ['A', undefined],
      ['z', undefined],
    ]);
  });
  test('a parent cycle re-roots to the top level, not to itself', () => {
    const cyc = [t('A', { parent: 'B' }), t('B', { parent: 'A' }), t('z')];
    expect(
      reRootOrphans([cyc[0] as Task, cyc[2] as Task], cyc).map((x) => [x.id, x.parent]),
    ).toEqual([
      ['A', undefined],
      ['z', undefined],
    ]);
  });
  test('a hidden parent → the nearest visible ancestor, else top level', () => {
    const visible = (ids: string[]) => tasks.filter((x) => ids.includes(String(x.id)));
    expect(reRootOrphans(visible(['S', 'c']), tasks).map((x) => [x.id, x.parent])).toEqual([
      ['S', undefined],
      ['c', 'S'],
    ]);
    expect(reRootOrphans(visible(['c', 'x']), tasks).map((x) => [x.id, x.parent])).toEqual([
      ['c', undefined],
      ['x', undefined],
    ]);
  });
  test('untouched tasks keep their identity (memo-friendly)', () => {
    const v = tasks.filter((x) => x.id !== 'G');
    const out = reRootOrphans(v, tasks);
    expect(out[0]).toBe(tasks[0]);
    expect(out[2]).toBe(tasks[3]);
    expect(out[1]).not.toBe(tasks[2]);
    // No orphan → the same array.
    expect(reRootOrphans(tasks, tasks)).toBe(tasks);
  });
});

test('<Gantt visibleTaskIds>: a leaf whose summary is filtered out still renders', () => {
  const { container } = render(<Gantt project={project} visibleTaskIds={new Set(['c', 'x'])} />);
  const rows = [...container.querySelectorAll('.wx-row[data-id]')].map((r) =>
    r.getAttribute('data-id'),
  );
  expect(rows).toEqual([':c', ':x']);
});
