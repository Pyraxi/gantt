import type { Link, Project, Task } from '@pyraxi/cpm-engine';
import { deleteTask, schedule } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { classifyStructuralEvent } from './svar-adapter.js';

function task(id: string, dur = 540): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: dur,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
  };
}
function fs(s: string, t: string): Link {
  return { id: `${s}-${t}`, source: s, target: t, type: 'FS', lag: 0 };
}
const cal = {
  id: 'std',
  name: 'std',
  workWeek: [
    [],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [],
  ],
  exceptions: [],
};
function project(tasks: Task[], links: Link[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [cal],
    baselines: [],
    assignments: [],
  };
}

describe('structural bridge → engine cascade', () => {
  test('a delete-task event maps to deleteTask and drops the successor link', () => {
    const p = project([task('a'), task('b')], [fs('a', 'b')]);
    const edit = classifyStructuralEvent('delete-task', { id: 'a' });
    expect(edit).toEqual({ kind: 'delete', id: 'a' });
    // The bridge would call onTaskDelete('a') → consumer enqueues deleteTask('a').
    const after = schedule(deleteTask('a').apply(p));
    expect(after.tasks.map((t) => t.id)).toEqual(['b']);
    expect(after.links).toHaveLength(0); // incident link removed by deleteTask
  });
});
