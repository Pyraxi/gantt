// A plain `{ field: 'start' }` column (and the default edit columns an export
// renders read-only) must show the local date: an 08:00 NZ start is the
// previous day in UTC. Separate file: TZ is process-wide, and this relies on
// vitest's per-file process isolation (forks + isolate); threads would leak it.
process.env.TZ = 'Pacific/Auckland';

import type { Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Gantt, type GanttColumn } from './Gantt.js';
import { formatShortDate } from './svar-adapter.js';

afterEach(cleanup);

const start = new Date(2026, 0, 5, 8);
const t: Task = {
  id: 'a',
  text: 'A',
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start,
  end: new Date(2026, 0, 5, 17),
  progress: 0,
};
const project: Project = {
  start,
  defaultCalendarId: 'std',
  tasks: [t],
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
const cellText = (root: HTMLElement, col: string) =>
  root.querySelector(`.wx-cell[data-row-id=":a"][data-col-id=":${col}"]`)?.textContent?.trim();

test('field columns show local dates and durations with units', () => {
  expect(start.toISOString().slice(0, 10)).toBe('2026-01-04'); // the trap
  for (const [col, expected] of [
    ['start', formatShortDate(start)],
    ['duration', '1d'],
  ] as const) {
    const { container } = render(
      <Gantt project={project} columns={[{ id: col, field: col, header: col } as GanttColumn]} />,
    );
    expect(cellText(container, col)).toBe(expected);
    cleanup();
  }
});
