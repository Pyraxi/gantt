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

describe('schedule() — split tasks', () => {
  test('segments are authoritative over task.start/end when mismatched', () => {
    // task.start/end are stale; segments carry the real bounds
    const split: Task = {
      id: 's',
      text: 's',
      type: 'task',
      scheduleMode: 'manual',
      duration: 1080,
      // Deliberately wrong outer dates — segments should override
      start: new Date(2026, 0, 1, 8, 0),
      end: new Date(2026, 0, 1, 17, 0),
      progress: 0,
      segments: [
        { start: new Date(2026, 0, 5, 8, 0), end: new Date(2026, 0, 5, 17, 0) },
        { start: new Date(2026, 0, 8, 8, 0), end: new Date(2026, 0, 8, 17, 0) },
      ],
    };
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [split],
      links: [],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    const c = out.tasks[0].computed;
    // Must come from segments, not task.start/end
    expect(c?.earlyStart).toEqual(new Date(2026, 0, 5, 8, 0));
    expect(c?.earlyFinish).toEqual(new Date(2026, 0, 8, 17, 0));
  });

  test('a split task spans from first segment start to last segment end', () => {
    const split: Task = {
      id: 's',
      text: 's',
      type: 'task',
      scheduleMode: 'manual',
      duration: 1080,
      start: new Date(2026, 0, 5, 8, 0),
      end: new Date(2026, 0, 8, 17, 0),
      progress: 0,
      segments: [
        { start: new Date(2026, 0, 5, 8, 0), end: new Date(2026, 0, 5, 17, 0) },
        { start: new Date(2026, 0, 8, 8, 0), end: new Date(2026, 0, 8, 17, 0) },
      ],
    };
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [split],
      links: [],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    const c = out.tasks[0].computed;
    expect(c?.earlyStart).toEqual(new Date(2026, 0, 5, 8, 0));
    expect(c?.earlyFinish).toEqual(new Date(2026, 0, 8, 17, 0));
  });

  test('manual task with empty segments[] falls back to task.start/end without crashing (M-3)', () => {
    const task: Task = {
      id: 'm',
      text: 'm',
      type: 'task',
      scheduleMode: 'manual',
      duration: 540,
      start: new Date(2026, 0, 5, 8, 0),
      end: new Date(2026, 0, 5, 17, 0),
      progress: 0,
      segments: [],
    };
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [task],
      links: [],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    const c = out.tasks[0].computed;
    expect(c?.earlyStart).toEqual(new Date(2026, 0, 5, 8, 0));
    expect(c?.earlyFinish).toEqual(new Date(2026, 0, 5, 17, 0));
  });

  test('a summary over a split child aggregates to the split outer bounds', () => {
    const child: Task = {
      id: 'c',
      text: 'c',
      parent: 'p',
      type: 'task',
      scheduleMode: 'manual',
      duration: 1080,
      start: new Date(2026, 0, 5, 8, 0),
      end: new Date(2026, 0, 8, 17, 0),
      progress: 0,
      segments: [
        { start: new Date(2026, 0, 5, 8, 0), end: new Date(2026, 0, 5, 17, 0) },
        { start: new Date(2026, 0, 8, 8, 0), end: new Date(2026, 0, 8, 17, 0) },
      ],
    };
    const summary: Task = {
      id: 'p',
      text: 'p',
      type: 'summary',
      scheduleMode: 'auto',
      duration: 0,
      start: START,
      end: START,
      progress: 0,
      open: true,
    };
    const project: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [summary, child],
      links: [],
      resources: [],
      calendars: [cal],
      baselines: [],
      assignments: [],
    };
    const out = schedule(project);
    const p = out.tasks.find((x) => x.id === 'p')?.computed;
    expect(p?.earlyFinish).toEqual(new Date(2026, 0, 8, 17, 0));
  });
});
