import { describe, expect, test } from 'vitest';
import { progressPoints } from './progress-line';
import type { Calendar, Project, Task } from './types';

// Parity row 6 (core). Spec: docs/superpowers/specs/2026-10-16-progress-line-design.md

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, start: Date, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: days === 0 ? 'milestone' : 'task',
  scheduleMode: 'manual',
  duration: days * DAY,
  start,
  end: start,
  progress: 0,
  ...extra,
});
const project = (tasks: Task[], statusDate?: Date): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links: [],
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
  ...(statusDate ? { statusDate } : {}),
});
const STATUS = d(8); // Thu 8 Jan 08:00

describe('progressPoints', () => {
  test('no status date → no points', () => {
    expect(progressPoints(project([t('a', d(5), 4, { progress: 50 })])).size).toBe(0);
  });

  test('done, or not yet due → on the status line', () => {
    const p = project(
      [
        t('done', d(5), 2, { progress: 100 }),
        t('future', d(12), 2),
        t('dueLater', d(8), 2), // starts exactly at the status date
        t('ms', d(9), 0),
      ],
      STATUS,
    );
    const pts = progressPoints(p);
    for (const id of ['done', 'future', 'dueLater', 'ms']) expect(pts.get(id)).toEqual(STATUS);
  });

  test('behind: 0% but due → its start (left of the line); 25% of 4 days → start + 1 day', () => {
    const p = project(
      [t('late', d(5), 4), t('slow', d(5), 4, { progress: 25 }), t('msDue', d(6), 0)],
      STATUS,
    );
    const pts = progressPoints(p);
    expect(pts.get('late')).toEqual(d(5));
    expect(pts.get('slow')).toEqual(d(5, 17)); // 1 working day from Mon 08:00 → Mon 17:00
    expect(pts.get('msDue')).toEqual(d(6)); // a due milestone not done is behind
  });

  test('ahead: 75% of a 4-day task started Tue → right of the line', () => {
    const pts = progressPoints(project([t('fast', d(6), 4, { progress: 75 })], STATUS));
    expect(pts.get('fast')).toEqual(d(8, 17)); // 3 working days from Tue 08:00 → Thu 17:00
  });

  test('started early (start after the status date, some work done) → right of the line', () => {
    const pts = progressPoints(project([t('early', d(12), 4, { progress: 50 })], STATUS));
    expect(pts.get('early')).toEqual(d(13, 17)); // 2 working days from Mon 12 → Tue 13 17:00
  });

  test('null actualFinish (JSON data) is not "complete"', () => {
    const pts = progressPoints(
      project(
        [t('a', d(5), 4, { progress: 25, actualFinish: null as unknown as undefined })],
        STATUS,
      ),
    );
    expect(pts.get('a')).toEqual(d(5, 17));
  });

  test('an explicit remainingDuration agrees with the engine forecast', () => {
    // 4 days, 25% by progress, but only 1 day remains → 3 days done → Wed 17:00.
    const pts = progressPoints(
      project([t('a', d(5), 4, { progress: 25, remainingDuration: DAY })], STATUS),
    );
    expect(pts.get('a')).toEqual(d(7, 17));
  });

  test('summaries and unscheduled tasks are left out; explicit status date wins', () => {
    const p = project(
      [
        t('s', d(5), 4, { type: 'summary' }),
        t('a', d(5), 4, { parent: 's', progress: 50 }),
        t('u', d(5), 2, { unscheduled: true }),
      ],
      STATUS,
    );
    const pts = progressPoints(p);
    expect([...pts.keys()]).toEqual(['a']);
    // Explicit status Mon 08:00: 50% is already done → ahead, right of the line.
    expect(progressPoints(p, d(5)).get('a')).toEqual(d(6, 17));
    expect(progressPoints({ ...p, statusDate: undefined }, d(12)).get('a')).toEqual(d(6, 17));
  });

  test("basis 'physical': the point is physical % of the duration from the start (P6)", () => {
    // Mon 5 Jan start, 5 days, 40% by duration but only 20% physically in place.
    const task = t('a', d(5), 5, { progress: 40, physicalProgress: 20, actualStart: d(5) });
    const p = project([task], STATUS);
    expect(progressPoints(p, undefined, { basis: 'physical' }).get('a')).toEqual(d(5, 17));
    // Duration basis (the default) is unchanged: 40% → 2 days in.
    expect(progressPoints(p).get('a')).toEqual(d(6, 17));
    // No physical % on a task → it falls back to its duration basis.
    const plain = project([t('b', d(5), 5, { progress: 40, actualStart: d(5) })], STATUS);
    expect(progressPoints(plain, undefined, { basis: 'physical' }).get('b')).toEqual(d(6, 17));
  });
});
