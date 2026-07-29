// Contract test for the visibleTaskIds prop on <Gantt>.
//
// The domain rule: hiding a task from the rendered Gantt must NOT affect
// CPM. CPM always runs on the full task set. The visibility filter is a
// render-only concern.
//
// This test asserts the contract by running schedule() on the full
// project, then applying the visibility filter, and confirming the
// computed fields on the visible tasks still reflect the full schedule.

import { describe, expect, test } from 'vitest';
import { schedule } from './schedule.js';
import type { Calendar, Link, Project, Task } from './types.js';
import { filterTasksByVisibility } from './visibility.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const DAY = 540;

function task(id: string, duration: number, parent?: string): Task {
  return {
    id,
    text: `Task ${id}`,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
    parent,
  };
}

function link(id: string, source: string, target: string): Link {
  return { id, source, target, type: 'FS', lag: 0 };
}

function project(tasks: Task[], links: Link[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('filterTasksByVisibility — CPM stays correct when predecessors are hidden', () => {
  test('hidden predecessor still drives visible successor early-start', () => {
    // A (5 working days) → B (3 working days, FS). A starts at project start;
    // B's earlyStart depends on A's earlyFinish (the contract under test).
    const scheduled = schedule(
      project([task('A', 5 * DAY), task('B', 3 * DAY)], [link('l1', 'A', 'B')]),
    );

    const taskA = scheduled.tasks.find((t) => t.id === 'A');
    const taskB = scheduled.tasks.find((t) => t.id === 'B');
    if (!taskA || !taskB) throw new Error('seed: A and B both expected');
    if (!taskA.computed || !taskB.computed)
      throw new Error('seed: schedule() should populate computed');

    // Baseline truth — B follows A. B's earlyStart is strictly after A's earlyStart
    // (the exact arithmetic of FS + working-time calendar is covered in schedule.test.ts).
    const bEarlyStartBefore = taskB.computed.earlyStart;
    expect(bEarlyStartBefore.getTime()).toBeGreaterThan(taskA.computed.earlyStart.getTime());

    // Hide A. Filtering happens AFTER schedule() has run, so B's computed is unchanged.
    const visible = filterTasksByVisibility(scheduled.tasks, new Set(['B']));

    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('B');

    const bComputed = visible[0].computed;
    if (!bComputed) throw new Error('B.computed should be preserved by the visibility filter');
    expect(bComputed.earlyStart.getTime()).toBe(bEarlyStartBefore.getTime());
  });

  test('undefined visibility set returns all tasks unchanged (no filter applied)', () => {
    const scheduled = schedule(project([task('A', DAY), task('B', DAY)], []));

    const result = filterTasksByVisibility(scheduled.tasks, undefined);

    expect(result).toBe(scheduled.tasks); // same reference — no copy on the noop path
  });

  test('empty visibility set returns no tasks (hides everything)', () => {
    const scheduled = schedule(project([task('A', DAY), task('B', DAY)], []));

    const result = filterTasksByVisibility(scheduled.tasks, new Set());

    expect(result).toHaveLength(0);
  });

  test('visibility set with unknown ids returns the matching subset (unknown ignored)', () => {
    const scheduled = schedule(project([task('A', DAY), task('B', DAY)], []));

    const result = filterTasksByVisibility(scheduled.tasks, new Set(['B', 'nonexistent']));

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('B');
  });
});
