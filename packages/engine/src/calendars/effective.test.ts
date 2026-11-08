import { describe, expect, test } from 'vitest';
import type { Calendar, Project, Task, WorkInterval } from '../types';
import { workingMinutesBetween } from '../working-time';
import { getEffectiveCalendar, intersectCalendars, resolveCalendar } from './effective';

const DAY: WorkInterval[] = [{ startMinutes: 480, endMinutes: 1020 }]; // 8-5

const std: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], DAY, DAY, DAY, DAY, DAY, []],
  exceptions: [{ date: new Date(2026, 0, 7), isWorking: false, name: 'Site shutdown' }],
};

function project(calendars: Calendar[], tasks: Task[] = [], extra: Partial<Project> = {}): Project {
  return {
    start: new Date(2026, 0, 5, 8),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars,
    baselines: [],
    assignments: [],
    ...extra,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  const start = new Date(2026, 0, 5, 8);
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start,
    end: start,
    progress: 0,
    ...overrides,
  };
}

describe('resolveCalendar', () => {
  test('a calendar without a base resolves to itself', () => {
    const p = project([std]);
    expect(resolveCalendar(p, 'std')).toEqual(std);
  });

  test('inheritedDays take the base intervals; explicit days stay authoritative', () => {
    // Plasterer: inherits Mon-Thu from Standard, Friday explicitly off.
    const plasterer: Calendar = {
      id: 'plas',
      name: 'Plasterer',
      baseCalendarId: 'std',
      workWeek: [[], [], [], [], [], [], []],
      inheritedDays: [0, 1, 2, 3, 4, 6],
      exceptions: [],
    };
    const r = resolveCalendar(project([std, plasterer]), 'plas');
    expect(r?.workWeek).toEqual([[], DAY, DAY, DAY, DAY, [], []]);
    expect(r?.baseCalendarId).toBeUndefined();
    expect(r?.inheritedDays).toBeUndefined();
  });

  test('base exceptions apply on dates the derived calendar does not override', () => {
    const derived: Calendar = {
      id: 'd',
      name: 'Derived',
      baseCalendarId: 'std',
      workWeek: std.workWeek,
      exceptions: [{ date: new Date(2026, 0, 8), isWorking: false }],
    };
    const r = resolveCalendar(project([std, derived]), 'd');
    const dates = r?.exceptions.map((e) => e.date.getDate()).sort();
    expect(dates).toEqual([7, 8]);
  });

  test('a derived exception overrides the base exception on the same date', () => {
    const derived: Calendar = {
      id: 'd',
      name: 'Derived',
      baseCalendarId: 'std',
      workWeek: std.workWeek,
      exceptions: [{ date: new Date(2026, 0, 7), isWorking: true, intervals: DAY }],
    };
    const r = resolveCalendar(project([std, derived]), 'd');
    expect(r?.exceptions).toHaveLength(1);
    expect(r?.exceptions[0]?.isWorking).toBe(true);
  });

  test('inheritance is recursive and cycle-safe', () => {
    const a: Calendar = {
      ...std,
      id: 'a',
      baseCalendarId: 'b',
      inheritedDays: [1],
      workWeek: [[], [], [], [], [], [], []],
    };
    const b: Calendar = { ...std, id: 'b', baseCalendarId: 'a', inheritedDays: [], exceptions: [] };
    const p = project([std, a, b]);
    expect(() => resolveCalendar(p, 'a')).not.toThrow();
    // b is authoritative for Monday (no inheritedDays), so a gets b's Monday.
    expect(resolveCalendar(p, 'a')?.workWeek[1]).toEqual(DAY);
  });

  test('an unknown id resolves to undefined', () => {
    expect(resolveCalendar(project([std]), 'nope')).toBeUndefined();
  });

  test('a string/number id mismatch from MSPDI still matches (UIDs are strings)', () => {
    const numeric: Calendar = { ...std, id: 3 };
    expect(resolveCalendar(project([numeric]), '3')?.id).toBe(3);
  });
});

describe('intersectCalendars', () => {
  test('weekly intervals intersect per day, including split shifts', () => {
    const early: Calendar = {
      id: 'e',
      name: 'Early',
      workWeek: [[], [{ startMinutes: 360, endMinutes: 840 }], [], [], [], [], []],
      exceptions: [],
    };
    const split: Calendar = {
      id: 's',
      name: 'Split',
      workWeek: [
        [],
        [
          { startMinutes: 420, endMinutes: 720 },
          { startMinutes: 780, endMinutes: 960 },
        ],
        [],
        [],
        [],
        [],
        [],
      ],
      exceptions: [],
    };
    const r = intersectCalendars(early, split);
    expect(r.workWeek[1]).toEqual([
      { startMinutes: 420, endMinutes: 720 },
      { startMinutes: 780, endMinutes: 840 },
    ]);
  });

  test('exception dates from either side are materialised as the intersection for that date', () => {
    const sixDay: Calendar = {
      id: '6d',
      name: 'Six day',
      workWeek: [[], DAY, DAY, DAY, DAY, DAY, DAY],
      exceptions: [{ date: new Date(2026, 0, 9), isWorking: false }], // Fri off
    };
    const r = intersectCalendars(std, sixDay);
    const byDate = new Map(r.exceptions.map((e) => [e.date.getDate(), e]));
    expect(byDate.get(7)?.isWorking).toBe(false); // std shutdown
    expect(byDate.get(9)?.isWorking).toBe(false); // 6d Friday off
    expect(r.workWeek[6]).toEqual([]); // Saturday: std doesn't work
  });
});

describe('getEffectiveCalendar', () => {
  const sixDay: Calendar = {
    id: '6d',
    name: 'Six day',
    workWeek: [[], DAY, DAY, DAY, DAY, DAY, DAY],
    exceptions: [],
  };
  const fourDay: Calendar = {
    id: '4d',
    name: 'Four day',
    workWeek: [[], DAY, DAY, DAY, DAY, [], []],
    exceptions: [],
  };

  test('no task or resource calendar → the default calendar', () => {
    const p = project([std], [task('a')]);
    expect(getEffectiveCalendar(p, 'a').calendar.id).toBe('std');
  });

  test('a task calendar is used', () => {
    const p = project([std, sixDay], [task('a', { calendarId: '6d' })]);
    expect(getEffectiveCalendar(p, 'a').calendar.workWeek[6]).toEqual(DAY);
  });

  test('task ∩ resource calendars for assigned resources with explicit calendars', () => {
    const p = project([std, sixDay, fourDay], [task('a', { calendarId: '6d' })], {
      resources: [
        { id: 'r1', name: 'Plasterer', calendarId: '4d' },
        { id: 'r2', name: 'Labourer' }, // no calendar → contributes nothing
      ],
      assignments: [
        { id: 'x1', taskId: 'a', resourceId: 'r1', units: 1 },
        { id: 'x2', taskId: 'a', resourceId: 'r2', units: 1 },
      ],
    });
    const { calendar, fallback } = getEffectiveCalendar(p, 'a');
    expect(fallback).toBeUndefined();
    expect(calendar.workWeek[5]).toEqual([]); // Fri: 4d off
    expect(calendar.workWeek[6]).toEqual([]); // Sat: 4d off
    expect(calendar.workWeek[1]).toEqual(DAY);
  });

  test('Task.resourceIds also count as assignments', () => {
    const p = project([std, fourDay], [task('a', { resourceIds: ['r1'] })], {
      resources: [{ id: 'r1', name: 'Plasterer', calendarId: '4d' }],
    });
    expect(getEffectiveCalendar(p, 'a').calendar.workWeek[5]).toEqual([]);
  });

  test('ignoreResourceCalendar opts out of the intersection', () => {
    const p = project(
      [std, fourDay],
      [task('a', { resourceIds: ['r1'], ignoreResourceCalendar: true })],
      {
        resources: [{ id: 'r1', name: 'Plasterer', calendarId: '4d' }],
      },
    );
    expect(getEffectiveCalendar(p, 'a').calendar.workWeek[5]).toEqual(DAY);
  });

  test('an unknown task calendar falls back to the default and says so', () => {
    const p = project([std], [task('a', { calendarId: 'gone' })]);
    const r = getEffectiveCalendar(p, 'a');
    expect(r.calendar.id).toBe('std');
    expect(r.fallback).toBe('unknown-calendar');
  });

  test('an empty intersection falls back to the task calendar and says so', () => {
    const weekendOnly: Calendar = {
      id: 'we',
      name: 'Weekend',
      workWeek: [DAY, [], [], [], [], [], DAY],
      exceptions: [],
    };
    const p = project([std, weekendOnly], [task('a', { resourceIds: ['r1'] })], {
      resources: [{ id: 'r1', name: 'Weekender', calendarId: 'we' }],
    });
    const r = getEffectiveCalendar(p, 'a');
    expect(r.fallback).toBe('empty-intersection');
    expect(r.calendar.workWeek[1]).toEqual(DAY);
  });

  test('the resolved calendar is usable by working-time maths', () => {
    const p = project([std, sixDay], [task('a', { calendarId: '6d' })]);
    const cal = getEffectiveCalendar(p, 'a').calendar;
    // Fri 8am → Mon 8am spans Fri + Sat in a six-day calendar.
    expect(workingMinutesBetween(new Date(2026, 0, 9, 8), new Date(2026, 0, 12, 8), cal)).toBe(
      1080,
    );
  });
});
