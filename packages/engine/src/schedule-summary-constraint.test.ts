import { describe, expect, test } from 'vitest';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// MS Project applies a Start No Earlier Than on a summary to every task under
// it (found in a real programme: everything else sat at the project start).

const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: d(5),
  end: d(5),
  progress: 0,
  ...extra,
});
const project = (tasks: Task[], links: Link[] = []): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
});
const at = (p: Project, id: string) => schedule(p).tasks.find((x) => x.id === id)?.computed;

describe('a summary SNET floors the tasks under it', () => {
  const snet = { type: 'SNET' as const, date: d(14) };

  test('children, grandchildren and their successors start no earlier than the summary SNET', () => {
    const p = project(
      [
        t('job', { type: 'summary', constraint: snet }),
        t('a', { parent: 'job' }),
        t('stage', { type: 'summary', parent: 'job' }),
        t('b', { parent: 'stage' }),
        t('c', { parent: 'stage' }),
        t('outside'),
      ],
      [{ id: 'l', source: 'b', target: 'c', type: 'FS', lag: 0 }],
    );
    expect(at(p, 'a')?.earlyStart).toEqual(d(14));
    expect(at(p, 'b')?.earlyStart).toEqual(d(14));
    expect(at(p, 'c')?.earlyStart).toEqual(d(15));
    expect(at(p, 'job')?.earlyStart).toEqual(d(14));
    expect(at(p, 'job')?.earlyFinish).toEqual(d(15, 17));
    expect(at(p, 'outside')?.earlyStart).toEqual(d(5));
  });

  test('a manual or unscheduled summary does not push its children (MS Project)', () => {
    for (const extra of [{ scheduleMode: 'manual' as const }, { unscheduled: true }]) {
      const p = project([
        t('job', { type: 'summary', constraint: snet, ...extra }),
        t('a', { parent: 'job' }),
      ]);
      expect(at(p, 'a')?.earlyStart).toEqual(d(5));
    }
  });

  test('a later predecessor or own constraint still wins', () => {
    const p = project(
      [
        t('pre', { duration: 540 * 10 }),
        t('job', { type: 'summary', constraint: snet }),
        t('a', { parent: 'job' }),
        t('b', { parent: 'job', constraint: { type: 'SNET', date: d(20) } }),
      ],
      [{ id: 'l', source: 'pre', target: 'a', type: 'FS', lag: 0 }],
    );
    expect(at(p, 'a')?.earlyStart).toEqual(d(19));
    expect(at(p, 'b')?.earlyStart).toEqual(d(20));
  });
});
