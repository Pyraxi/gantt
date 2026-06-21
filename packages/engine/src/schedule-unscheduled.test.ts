import { describe, expect, test } from 'vitest';
import { schedule } from './schedule';
import type { Calendar, Project, Task } from './types';

const cal: Calendar = {
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
const START = new Date(2026, 0, 5, 8, 0);
const t = (id: string, o: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: START,
  end: START,
  progress: 0,
  ...o,
});

describe('schedule() — unscheduled tasks', () => {
  test('unscheduled task gets no computed and does not break the pass', () => {
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [t('a'), t('u', { unscheduled: true }), t('b')],
      links: [{ id: 'l1', source: 'a', target: 'b', type: 'FS', lag: 0 }],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    expect(out.tasks.find((x) => x.id === 'u')?.computed).toBeUndefined();
    expect(out.tasks.find((x) => x.id === 'b')?.computed).toBeDefined();
  });

  test('a link to an unscheduled task is inert (no cascade)', () => {
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [t('a'), t('u', { unscheduled: true })],
      links: [{ id: 'l1', source: 'a', target: 'u', type: 'FS', lag: 0 }],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    expect(out.tasks.find((x) => x.id === 'u')?.computed).toBeUndefined();
  });

  test('link FROM an unscheduled task is inert — successor uses project floor (I-2)', () => {
    // u (unscheduled) → b (auto, FS). u contributes nothing to forward pass;
    // b should be scheduled from the project floor, not pushed by u.
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [t('a'), t('u', { unscheduled: true }), t('b')],
      links: [{ id: 'l2', source: 'u', target: 'b', type: 'FS', lag: 0 }],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    const u = out.tasks.find((x) => x.id === 'u');
    const b = out.tasks.find((x) => x.id === 'b');
    expect(u?.computed).toBeUndefined();
    expect(b?.computed).toBeDefined();
    // B was not pushed by u; earlyStart should equal the project floor (START)
    expect(b?.computed?.earlyStart).toEqual(START);
  });

  test('summary whose only child is unscheduled — pass does not throw and summary computed is undefined (I-3)', () => {
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [
        t('p', { type: 'summary', scheduleMode: 'auto', open: true }),
        t('c', { parent: 'p', unscheduled: true }),
      ],
      links: [],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    // Must not throw
    const out = schedule(project);
    const p = out.tasks.find((x) => x.id === 'p');
    // No scheduled children → summary has no computable bounds
    expect(p?.computed).toBeUndefined();
  });

  test('F5 — unscheduled SUMMARY with a scheduled child: summary gets no computed and is not critical (F5)', () => {
    // p is a summary with unscheduled:true; child c is a scheduled auto task.
    // The summary loops must guard unscheduled summaries; p should not aggregate
    // child dates and must not appear on the critical path.
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [
        t('p', { type: 'summary', scheduleMode: 'auto', open: true, unscheduled: true }),
        t('c', { parent: 'p' }),
      ],
      links: [],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    const p = out.tasks.find((x) => x.id === 'p');
    // Unscheduled summary must have no computed dates.
    expect(p?.computed).toBeUndefined();
    // And must not be on the critical path.
    expect(p?.computed?.isCritical).toBeUndefined();
  });
});
