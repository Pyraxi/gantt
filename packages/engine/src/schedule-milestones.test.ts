import { describe, expect, test } from 'vitest';
import { combineProjects } from './combine';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// Where MS Project puts a milestone, as MS Project desktop computed it: run 7
// (docs/release/desktop-check/variants-run7) and run 9 (variants-run9,
// results-run9/result.tsv). Spec:
// docs/superpowers/specs/2026-11-02-milestone-at-predecessor-finish-design.md

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const h24: Calendar = {
  id: 'h24',
  name: '24 Hours',
  workWeek: Array(7).fill([{ startMinutes: 0, endMinutes: 1440 }]),
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: days === 0 ? 'milestone' : 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: d(5),
  end: d(5),
  progress: 0,
  ...extra,
});
const l = (
  source: string,
  target: string,
  type: Link['type'],
  extra: Partial<Link> = {},
): Link => ({
  id: `${source}-${target}`,
  source,
  target,
  type,
  lag: 0,
  ...extra,
});
const run = (tasks: Task[], links: Link[], start = d(5), extra: Partial<Project> = {}) => {
  const s = schedule({
    ...extra,
    start,
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [std, h24],
    baselines: [],
    assignments: [],
  } satisfies Project);
  return (id: string) => s.tasks.find((x) => x.id === id)?.computed;
};

describe('milestones sit where MS Project puts them', () => {
  test('FS: at the predecessor finish, Mon 17:00; its successor starts Tue 08:00 (run 7 a)', () => {
    const c = run([t('a1', 1), t('a2', 0), t('a3', 1)], [l('a1', 'a2', 'FS'), l('a2', 'a3', 'FS')]);
    expect(c('a2')?.earlyStart).toEqual(d(5, 17));
    expect(c('a3')?.earlyStart).toEqual(d(6));
  });

  test('FF lead landing on a morning: the previous evening (run 7 b, run 9 f)', () => {
    // b1 Mon–Tue; FF −1d → Tue 08:00 ≡ Mon 17:00: MS Project shows Mon 17:00.
    const c = run(
      [t('b1', 2), t('b2', 0), t('b3', 1)],
      [l('b1', 'b2', 'FF', { lag: -DAY }), l('b2', 'b3', 'FS')],
    );
    expect(c('b2')?.earlyStart).toEqual(d(5, 17));
    expect(c('b3')?.earlyStart).toEqual(d(6));
    // b3 ends Tue 17:00 with b1: all three critical, with no float lost or invented.
    for (const id of ['b1', 'b2', 'b3']) {
      expect(c(id)?.totalSlack).toBe(0);
      expect(c(id)?.freeSlack).toBe(0);
    }
  });

  test('SS and SF, no lag: at the predecessor start, Tue 08:00 (run 7 c, run 9 a)', () => {
    const snet = { constraint: { type: 'SNET' as const, date: d(6) } };
    const c = run(
      [t('c1', 1, snet), t('c2', 0), t('s1', 1, snet), t('s2', 0)],
      [l('c1', 'c2', 'SS'), l('s1', 's2', 'SF')],
    );
    expect(c('c2')?.earlyStart).toEqual(d(6));
    expect(c('s2')?.earlyStart).toEqual(d(6));
  });

  test('FS lead landing on an evening: the next morning (run 9 e)', () => {
    const c = run(
      [t('e1', 3), t('e2', 0), t('e3', 1)],
      [l('e1', 'e2', 'FS', { lag: -DAY }), l('e2', 'e3', 'FS')],
    );
    expect(c('e2')?.earlyStart).toEqual(d(7));
    // e3 Wed 7, ending with e1: all critical.
    for (const id of ['e1', 'e2', 'e3']) expect(c(id)?.totalSlack).toBe(0);
  });

  test('FS +1d: the end of the next day, Tue 17:00 (run 9 b)', () => {
    const c = run([t('b1', 1), t('b2', 0)], [l('b1', 'b2', 'FS', { lag: DAY })]);
    expect(c('b2')?.earlyStart).toEqual(d(6, 17));
  });

  test('in non-working time it stays there: Sat 08:00, Sat 03:00 (run 7 d/e, run 9 c/d)', () => {
    const c = run(
      [
        t('d1', 0, { constraint: { type: 'SNET', date: d(10) } }),
        t('d2', 0),
        t('e1', 1, { constraint: { type: 'SNET', date: d(9) } }),
        t('e2', 0),
        t('f1', 0, {
          type: 'task',
          duration: 19 * 60,
          calendarId: 'h24',
          constraint: { type: 'SNET', date: d(9) },
        }),
        t('f2', 0),
        t('g1', 1, { constraint: { type: 'SNET', date: d(9) } }),
        t('g2', 0),
        t('g3', 1),
      ],
      [
        l('d1', 'd2', 'FS'),
        l('e1', 'e2', 'FS', { lag: 600, lagElapsed: true }),
        l('f1', 'f2', 'FS'),
        l('g1', 'g2', 'FF', { lag: 600, lagElapsed: true }),
        l('g2', 'g3', 'FS'),
      ],
    );
    expect(c('d1')?.earlyStart).toEqual(d(10));
    expect(c('d2')?.earlyStart).toEqual(d(10));
    expect(c('e2')?.earlyStart).toEqual(d(10, 3));
    expect(c('f2')?.earlyStart).toEqual(d(10, 3));
    expect(c('g2')?.earlyStart).toEqual(d(10, 3));
    // A task after it snaps as usual, and nothing gains float from the weekend.
    expect(c('g3')?.earlyStart).toEqual(d(12));
    expect(c('g2')?.totalSlack).toBe(0);
  });

  test('no link, project starting Sat 3: the milestone stays on Sat, a task moves to Mon (run 9 m02)', () => {
    const c = run([t('m', 0), t('w', 1)], [], d(3));
    expect(c('m')?.earlyStart).toEqual(d(3));
    expect(c('w')?.earlyStart).toEqual(d(5));
  });
});

describe('milestone float, review cases (2026-11-04)', () => {
  test('an FF lead into a milestone, then an elapsed lag out: nobody is late', () => {
    // a Mon–Tue FF −1d → m Mon 17:00; +15 ehrs → Tue 08:00 → c, critical.
    const c = run(
      [t('a', 2), t('m', 0), t('c', 1)],
      [l('a', 'm', 'FF', { lag: -DAY }), l('m', 'c', 'FS', { lag: 900, lagElapsed: true })],
    );
    expect(c('m')?.earlyStart).toEqual(d(5, 17));
    expect(c('c')?.earlyStart).toEqual(d(6));
    for (const id of ['a', 'm', 'c']) expect(c(id)?.totalSlack).toBe(0);
  });

  test.each([
    'MFO',
    'FNLT',
    'SNLT',
  ] as const)('an FF lead into a milestone %s at its own date: no negative float', (type) => {
    const c = run(
      [t('a', 2), t('m', 0, { constraint: { type, date: d(5, 17) } })],
      [l('a', 'm', 'FF', { lag: -DAY })],
    );
    expect(c('m')?.totalSlack).toBe(0);
    expect(c('a')?.totalSlack).toBe(0);
  });

  test('an FS lead into a milestone with an FNLT the same evening: both on time', () => {
    // a Mon–Wed FS −1d → m Wed 08:00 ≡ Tue 17:00, its FNLT.
    const c = run(
      [t('a', 3), t('m', 0, { constraint: { type: 'FNLT', date: d(6, 17) } })],
      [l('a', 'm', 'FS', { lag: -DAY })],
    );
    expect(c('m')?.totalSlack).toBe(0);
    expect(c('a')?.totalSlack).toBe(0);
  });

  test('a P6 status-date floor puts an unstarted milestone at a working moment, not its raw instant', () => {
    // The P6 opt-in: by default (MS Project) the status date floors nothing.
    const c = run([t('m', 0)], [], d(5), {
      statusDate: new Date(2026, 0, 10),
      rescheduleAfterStatusDate: true,
    });
    expect(c('m')?.earlyStart).toEqual(d(12));
  });

  test('combineProjects keeps a milestone on its part’s Saturday start, as schedule() does', () => {
    const part = (start: Date, tasks: Task[]): Project => ({
      start,
      defaultCalendarId: 'std',
      tasks,
      links: [],
      resources: [],
      calendars: [std],
      baselines: [],
      assignments: [],
    });
    const { project, idOf } = combineProjects([
      { key: 'a', project: part(d(1), [t('x', 1)]) },
      {
        key: 'b',
        project: part(d(3), [
          t('m', 0),
          t('ms', 0, { constraint: { type: 'SNET', date: d(3) } }),
          t('w', 1),
        ]),
      },
    ]);
    const s = schedule(project);
    const at = (id: string) => s.tasks.find((x) => x.id === idOf('b', id))?.computed?.earlyStart;
    expect(at('m')).toEqual(d(3));
    expect(at('ms')).toEqual(d(3));
    expect(at('w')).toEqual(d(5));
  });
});
