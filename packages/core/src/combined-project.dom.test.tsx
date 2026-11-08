// Parity row 24: a combined programme renders in one <Gantt> with nothing new
// in core. Each job is a summary row over its namespaced tasks.
import { combineProjects, type Project, type Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Gantt } from './Gantt.js';

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
const job = (ids: string[]): Project => ({
  start: MON,
  defaultCalendarId: 'std',
  tasks: ids.map(t),
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
});

// happy-dom has no layout, so SVAR draws only the first ~2 rows.
test('a job renders as a summary row over its own namespaced tasks', () => {
  const { project } = combineProjects([
    { key: 'j1', name: 'Smith St', project: job(['a']) },
    { key: 'j2', name: 'Jones Rd', project: job(['a']) },
  ]);
  const { container } = render(<Gantt project={project} />);
  const rows = [...container.querySelectorAll('.wx-row[data-id]')].map((r) =>
    r.getAttribute('data-id'),
  );
  expect(rows.slice(0, 2)).toEqual([':j1', ':j1/a']);
  expect(container.textContent).toContain('Smith St');
});
