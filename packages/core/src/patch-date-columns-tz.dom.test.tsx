// Patch 1.7.5: a plain field date column must show the local day: an 08:00 NZ start is the previous day in UTC. Separate
// file: TZ is process-wide (relies on vitest's per-file process isolation).
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

test('a plain { field: "start" } column shows the local date', () => {
  expect(start.toISOString().slice(0, 10)).toBe('2026-01-04'); // the trap
  const { container } = render(
    <Gantt
      project={project}
      columns={[{ id: 'start', field: 'start', header: 'Start' } as GanttColumn]}
    />,
  );
  const cell = container.querySelector('.wx-cell[data-row-id=":a"][data-col-id=":start"]');
  expect(cell?.textContent?.trim()).toBe(formatShortDate(start));
});
