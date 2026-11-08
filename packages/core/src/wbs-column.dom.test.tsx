// wbsColumn through a real <Gantt>: render columns receive SVAR rows, not the
// Task, so what `code()` can read is what the adapter carries (parity row 8).
import type { Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Gantt } from './Gantt.js';
import { wbsColumn } from './predecessors.js';

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
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [t('a', { codes: { wbs: 'E-01' } }), t('b', { extra: { wbsCode: 'X-02' } })],
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

test('code() sees the task’s codes and extra in a real render', () => {
  const col = wbsColumn(project.tasks, {
    code: (task) => task.codes?.wbs ?? (task.extra?.wbsCode as string | undefined),
  });
  const { container } = render(<Gantt project={project} columns={[col]} />);
  const shown = (id: string) =>
    container
      .querySelector(`.wx-cell[data-row-id=":${id}"][data-col-id=":_wbs"]`)
      ?.textContent?.trim();
  expect([shown('a'), shown('b')]).toEqual(['E-01', 'X-02']);
});
