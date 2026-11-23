// A double-click on a task added after mount asks to edit that task, not the
// one that used to sit in its row. A consumer reported its editor opening for
// a different task after it added one and re-rendered (to-gantt 2026-11-05).
// onTaskEditRequest gets the clicked task's own id, as given in Project.tasks.
import type { Project, Task, TaskId } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Gantt } from './Gantt.js';

afterEach(cleanup);

const MON = new Date(2026, 0, 5, 8);
const uuid = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const t = (id: string, text: string): Task => ({
  id,
  text,
  type: 'task',
  scheduleMode: 'auto',
  duration: 480,
  start: MON,
  end: MON,
  progress: 0,
});
const projectOf = (tasks: Task[]): Project => ({
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
});

// happy-dom has no layout, so SVAR draws only the first ~2 rows: the new task
// goes second, where the old second task was.
test.each([
  ['a uuid', uuid(9)],
  ['a numeric-looking string', '12'],
])('a double-click on a task added after mount reports its own id (%s)', (_, newId) => {
  const seen: TaskId[] = [];
  const before = [t(uuid(1), 'Foundations'), t(uuid(2), 'Framing')];
  const after = [before[0], t(newId, 'ZZ tile splashback'), before[1]];
  const view = (tasks: Task[]) => (
    <Gantt project={projectOf(tasks)} editMode onTaskEditRequest={(id) => seen.push(id)} />
  );
  const { container, rerender } = render(view(before));
  rerender(view(after));

  const sel = `[data-id=":${newId}"]`;
  const cell = container.querySelector(`.wx-row${sel} .wx-cell`);
  const bar = container.querySelector(`.wx-bar${sel}`);
  expect(cell).not.toBeNull();
  expect(bar).not.toBeNull();
  cell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  bar?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(seen).toEqual([newId, newId]);
});
