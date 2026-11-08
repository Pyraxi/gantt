import { describe, expect, test } from 'vitest';
import { serializeMspdi } from './mspdi/serialize';
import type { DroppedField } from './mspdi/types';
import { checkSchedule } from './quality';
import { remainingMinutes, schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// Parity row 2. Spec: docs/superpowers/specs/2026-10-16-secondary-constraint-expected-finish-design.md

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: d(5),
  end: d(5),
  progress: 0,
  ...extra,
});
const project = (tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
  // P6: forecast from the data date (the opt-in).
  rescheduleAfterStatusDate: true,
  ...extra,
});
const c = (p: Project, id: string) => schedule(p).tasks.find((x) => x.id === id)?.computed;

describe('secondary constraint (P6)', () => {
  test('primary SNET + secondary FNLT: the start floor and the finish deadline both apply', () => {
    // 2-day task, SNET Wed 7, FNLT Thu 8 17:00 → on time, 0 float.
    const p = project([
      t('a', 2, {
        constraint: { type: 'SNET', date: d(7) },
        secondaryConstraint: { type: 'FNLT', date: d(8, 17) },
      }),
    ]);
    expect(c(p, 'a')?.earlyStart).toEqual(d(7));
    expect(c(p, 'a')?.lateFinish).toEqual(d(8, 17));
    expect(c(p, 'a')?.totalSlack).toBe(0);
  });

  test('a secondary FNLT a day too early surfaces negative float', () => {
    const p = project([
      t('a', 2, {
        constraint: { type: 'SNET', date: d(7) },
        secondaryConstraint: { type: 'FNLT', date: d(7, 17) },
      }),
    ]);
    expect(c(p, 'a')?.totalSlack).toBe(-DAY);
  });

  test('secondary FNET floors the finish after the primary', () => {
    const p = project([
      t('a', 1, {
        constraint: { type: 'SNET', date: d(5) },
        secondaryConstraint: { type: 'FNET', date: d(9, 17) },
      }),
    ]);
    expect(c(p, 'a')?.earlyFinish).toEqual(d(9, 17));
  });

  test('a mandatory primary (MSO / MFO) wins; the secondary is ignored, as P6 disallows it', () => {
    const p = project([
      t('a', 1, {
        constraint: { type: 'MSO', date: d(6) },
        secondaryConstraint: { type: 'SNET', date: d(9) },
      }),
    ]);
    expect(c(p, 'a')?.earlyStart).toEqual(d(6));
  });

  test('without a secondary constraint, scheduling is unchanged', () => {
    const base = project([t('a', 2, { constraint: { type: 'SNET', date: d(7) } })]);
    expect(schedule(base).tasks[0]?.computed).toEqual(
      schedule({
        ...base,
        tasks: base.tasks.map((x) => ({ ...x, secondaryConstraint: undefined })),
      }).tasks[0]?.computed,
    );
  });
});

describe('expected finish (P6, status-date scheduling)', () => {
  test('an in-progress task’s remaining work runs from the status date to its expected finish', () => {
    // 5 days, 20% done — by % it would need 4 more days; the PM expects it done Thu 8 17:00.
    const p = project(
      [t('a', 5, { progress: 20, actualStart: d(5), expectedFinish: d(8, 17) }), t('b', 1)],
      [{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 0 }],
      { statusDate: d(7) },
    );
    expect(c(p, 'a')?.earlyFinish).toEqual(d(8, 17));
    expect(c(p, 'b')?.earlyStart).toEqual(d(9));
    // Late dates use the same remaining work: on the critical path, 0 float.
    expect(c(p, 'a')?.totalSlack).toBe(0);
  });

  test('expected finish wins over remainingDuration; ignored without a status date', () => {
    const p = project(
      [
        t('a', 5, {
          progress: 20,
          actualStart: d(5),
          remainingDuration: 4 * DAY,
          expectedFinish: d(7, 17),
        }),
      ],
      [],
      {
        statusDate: d(7),
      },
    );
    expect(c(p, 'a')?.earlyFinish).toEqual(d(7, 17));
    const noStatus = project([t('a', 2, { expectedFinish: d(20) })]);
    expect(c(noStatus, 'a')?.earlyFinish).toEqual(d(6, 17));
  });
});

describe('review fixes', () => {
  test('expected finish only re-forecasts in-progress work (checks and progress line agree)', () => {
    expect(
      remainingMinutes(t('a', 5, { expectedFinish: d(8, 17) }), {
        statusDate: d(7),
        calendar: std,
      }),
    ).toBe(5 * DAY);
    expect(
      remainingMinutes(t('a', 5, { progress: 20, actualStart: d(5), expectedFinish: d(8, 17) }), {
        statusDate: d(7),
        calendar: std,
      }),
    ).toBe(2 * DAY);
  });

  test('checkSchedule counts a secondary FNLT as a hard constraint', () => {
    const p = project([
      t('x', 1, {
        constraint: { type: 'SNET', date: d(5) },
        secondaryConstraint: { type: 'FNLT', date: d(9, 17) },
      }),
      t('y', 1, { constraint: { type: 'FNLT', date: d(9, 17) } }),
      t('z', 1),
    ]);
    const hard = checkSchedule(schedule(p)).checks.find((x) => x.id === 'hard-constraints');
    expect(hard?.taskIds).toEqual(['x', 'y']);
  });

  test('a dateless MSO primary does not suppress the secondary', () => {
    const p = project([
      t('a', 1, { constraint: { type: 'MSO' }, secondaryConstraint: { type: 'SNET', date: d(9) } }),
    ]);
    expect(c(p, 'a')?.earlyStart).toEqual(d(9));
  });

  test('MSPDI keeps the expected-finish forecast (RemainingDuration) and reports both P6 fields as lossy', () => {
    const p = project(
      [
        t('a', 5, {
          progress: 20,
          actualStart: d(5),
          remainingDuration: 4 * DAY,
          expectedFinish: d(8, 17),
          secondaryConstraint: { type: 'FNLT', date: d(20) },
        }),
      ],
      [],
      { statusDate: d(7) },
    );
    const dropped: DroppedField[] = [];
    const xml = serializeMspdi(schedule(p), { droppedFields: dropped });
    expect(xml).toContain('<RemainingDuration>PT18H0M0S</RemainingDuration>'); // 2 days, not the stale 4
    const reported = dropped.map((x) => x.path);
    expect(reported.some((x) => x.endsWith('.secondaryConstraint'))).toBe(true);
    expect(reported.some((x) => x.endsWith('.expectedFinish'))).toBe(true);
  });
});
