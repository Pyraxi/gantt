import { describe, expect, test } from 'vitest';
import { checkSchedule } from './quality';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// Parity row 11. Spec: docs/superpowers/specs/2026-10-16-schedule-quality-checks-design.md

const DAY = 540; // 8-5
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: days === 0 ? 'milestone' : 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const link = (s: string, d: string, type: Link['type'] = 'FS', lagDays = 0): Link => ({
  id: `${s}-${d}`,
  source: s,
  target: d,
  type,
  lag: lagDays * DAY,
});
const project = (tasks: Task[], links: Link[], extra: Partial<Project> = {}): Project => ({
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
  ...extra,
});
const check = (p: Project, id: string, opts?: Parameters<typeof checkSchedule>[1]) => {
  const c = checkSchedule(p, opts).checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};

// A clean chain: start(ms) → a → b → finish(ms).
const clean = () =>
  project(
    [t('start', 0), t('a', 3), t('b', 2), t('finish', 0)],
    [link('start', 'a'), link('a', 'b'), link('b', 'finish')],
  );

describe('checkSchedule', () => {
  test('returns the checks in a fixed order and passes a clean chain', () => {
    const r = checkSchedule(clean());
    expect(r.checks.map((c) => c.id)).toEqual([
      'missing-logic',
      'leads',
      'lags',
      'relationship-types',
      'start-to-finish',
      'hard-constraints',
      'high-float',
      'negative-float',
      'high-duration',
      'invalid-dates',
      'critical-path',
    ]);
    // The open ends of a chain (start has no predecessor, finish no successor)
    // are 2 of 4 tasks — over the 5% default.
    expect(r.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['missing-logic']);
    expect(check(clean(), 'missing-logic').taskIds).toEqual(['start', 'finish']);
  });

  test('thresholds are overridable and the overall pass follows them', () => {
    const r = checkSchedule(clean(), { thresholds: { 'missing-logic': 0.5 } });
    expect(r.pass).toBe(true);
  });

  test('missing logic, ratio and population', () => {
    const p = project(
      [t('a', 1), t('b', 1), t('c', 1), t('lonely', 1)],
      [link('a', 'b'), link('b', 'c')],
    );
    const c = check(p, 'missing-logic');
    expect(c.taskIds).toEqual(['a', 'c', 'lonely']);
    expect(c.total).toBe(4);
    expect(c.ratio).toBeCloseTo(0.75);
  });

  test('complete tasks, summaries and unscheduled tasks are not in the population', () => {
    const p = project(
      [
        t('s', 0, { type: 'summary' }),
        t('a', 1, { parent: 's' }),
        t('done', 1, { progress: 100 }),
        t('later', 1, { unscheduled: true }),
      ],
      [],
    );
    const c = check(p, 'missing-logic');
    expect(c.total).toBe(1);
    expect(c.taskIds).toEqual(['a']);
  });

  test('leads, lags, relationship types and SF links count links', () => {
    const p = project(
      [t('a', 2), t('b', 2), t('c', 2), t('d', 2), t('e', 2)],
      [
        link('a', 'b', 'FS', -1),
        link('b', 'c', 'FS', 2),
        link('c', 'd', 'SS'),
        link('d', 'e', 'SF'),
      ],
    );
    expect(check(p, 'leads')).toMatchObject({ count: 1, total: 4, pass: false, linkIds: ['a-b'] });
    expect(check(p, 'lags')).toMatchObject({ count: 1, linkIds: ['b-c'], pass: false });
    expect(check(p, 'relationship-types')).toMatchObject({
      count: 2,
      linkIds: ['c-d', 'd-e'],
      pass: false,
    });
    expect(check(p, 'start-to-finish')).toMatchObject({ count: 1, linkIds: ['d-e'], pass: false });
  });

  test('no links → link checks pass with ratio 0', () => {
    const c = check(project([t('a', 1)], []), 'leads');
    expect(c).toMatchObject({ count: 0, total: 0, ratio: 0, pass: true });
  });

  test('hard constraints: MSO / MFO / SNLT / FNLT count; SNET / FNET / ASAP do not', () => {
    const d = new Date(2026, 0, 12, 8);
    const p = project(
      [
        t('mso', 1, { constraint: { type: 'MSO', date: d } }),
        t('fnlt', 1, { constraint: { type: 'FNLT', date: d } }),
        t('snet', 1, { constraint: { type: 'SNET', date: d } }),
        t('plain', 1),
      ],
      [],
    );
    expect(check(p, 'hard-constraints').taskIds).toEqual(['mso', 'fnlt']);
  });

  test('high float and high duration use working days of the default calendar', () => {
    // driver: 60 days; idle: 1 day with no logic → ~59 days of float.
    const p = project([t('driver', 60), t('idle', 1)], []);
    expect(check(p, 'high-float').taskIds).toEqual(['idle']);
    expect(check(p, 'high-duration').taskIds).toEqual(['driver']);
    expect(check(p, 'high-float', { highFloatDays: 100 }).taskIds).toEqual([]);
  });

  test('negative float from a hard deadline constraint', () => {
    const p = project(
      [t('a', 5), t('b', 5, { constraint: { type: 'FNLT', date: new Date(2026, 0, 9, 17) } })],
      [link('a', 'b')],
    );
    const c = check(p, 'negative-float');
    expect(c.taskIds).toEqual(['a', 'b']);
    expect(c.pass).toBe(false);
  });

  test('invalid dates: past-due unfinished work and progress on future work, given a status date', () => {
    const p = schedule(
      project(
        [
          t('overdue', 1, { progress: 50 }), // finishes Mon 5 Jan, status Wed 7 Jan
          t('early', 1, {
            progress: 20,
            constraint: { type: 'SNET', date: new Date(2026, 0, 19, 8) },
          }),
          t('fine', 1, { constraint: { type: 'SNET', date: new Date(2026, 0, 19, 8) } }),
        ],
        [],
      ),
    );
    const c = check(p, 'invalid-dates', { statusDate: new Date(2026, 0, 7, 8) });
    expect(c.taskIds).toEqual(['overdue', 'early']);
    expect(check(p, 'invalid-dates').taskIds).toEqual([]); // no status date → only finish-before-start
  });

  test('a manual task finishing before it starts is an invalid date', () => {
    const p = project(
      [
        t('bad', 1, {
          scheduleMode: 'manual',
          start: new Date(2026, 0, 9, 8),
          end: new Date(2026, 0, 5, 8),
        }),
      ],
      [],
    );
    expect(check(p, 'invalid-dates').taskIds).toEqual(['bad']);
  });

  test('critical path: passes when one exists', () => {
    expect(check(clean(), 'critical-path').pass).toBe(true);
    expect(check(project([], []), 'critical-path').pass).toBe(true); // nothing to schedule
  });

  test('critical path: fails as a project-level finding when nothing is critical', () => {
    // A far-out project end gives every task float.
    const p = { ...clean(), end: new Date(2027, 0, 4, 17) };
    expect(check(p, 'critical-path')).toMatchObject({
      pass: false,
      count: 1,
      total: 1,
      taskIds: [],
    });
  });

  test('schedules an unscheduled project itself and does not mutate the input', () => {
    const p = clean();
    const before = JSON.stringify(p);
    checkSchedule(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(p.tasks[0]?.computed).toBeUndefined();
  });
});

describe('checkSchedule — review fixes (DCMA fidelity)', () => {
  test('float / duration limits use each task’s own calendar day', () => {
    const half: Calendar = {
      id: 'half',
      name: '4h',
      workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 720 }]), []],
      exceptions: [],
    };
    // 60 working days on a 4 h calendar = 14,400 min: long in its own days
    // (60 > 44) even though 14,400 < 44 × 540.
    const p = project(
      [t('short', 1), t('slow', 0, { type: 'task', duration: 60 * 240, calendarId: 'half' })],
      [],
      {
        calendars: [std, half],
      },
    );
    expect(check(p, 'high-duration').taskIds).toEqual(['slow']);
  });

  test('a derived default calendar is flattened before reading its day length', () => {
    const derived: Calendar = {
      id: 'd',
      name: 'Derived',
      baseCalendarId: 'std',
      inheritedDays: [0, 1, 2, 3, 4, 5, 6],
      workWeek: [[], [], [], [], [], [], []],
      exceptions: [],
    };
    // 42 days × 540 min is under 44 days in the (inherited) 9 h day.
    const p = project([t('a', 42)], [], { calendars: [std, derived], defaultCalendarId: 'd' });
    expect(check(p, 'high-duration').taskIds).toEqual([]);
  });

  test('invalid dates: not started but forecast to start before the status date; complete but finishing after it', () => {
    const p = schedule(
      project(
        [
          t('notStarted', 5), // starts Mon 5 Jan, status Wed 7 Jan, progress 0
          t('doneLater', 1, {
            progress: 100,
            constraint: { type: 'SNET', date: new Date(2026, 0, 19, 8) },
          }),
        ],
        [],
      ),
    );
    expect(check(p, 'invalid-dates', { statusDate: new Date(2026, 0, 7, 8) }).taskIds).toEqual([
      'notStarted',
      'doneLater',
    ]);
  });

  test('links to or from a summary do not count as logic and are not in link populations', () => {
    const p = project(
      [t('s', 0, { type: 'summary' }), t('a', 2, { parent: 's' }), t('b', 2), t('c', 2)],
      [link('s', 'b', 'SS', 1), link('b', 'c')],
    );
    expect(check(p, 'missing-logic').taskIds).toEqual(['a', 'b', 'c']);
    expect(check(p, 'lags')).toMatchObject({ total: 1, count: 0 });
  });

  test('link checks only count links whose successor is incomplete', () => {
    const p = project(
      [t('a', 2, { progress: 100 }), t('b', 2, { progress: 100 }), t('c', 2), t('d', 2)],
      [link('a', 'b', 'SS', 3), link('c', 'd')],
    );
    expect(check(p, 'lags')).toMatchObject({ total: 1, count: 0, pass: true });
    expect(check(p, 'relationship-types').pass).toBe(true);
  });

  test('high duration: remaining duration, over all incomplete tasks', () => {
    const p = project([t('long', 60, { progress: 90 }), t('ms', 0), t('a', 1)], []);
    const c = check(p, 'high-duration');
    expect(c.taskIds).toEqual([]); // 6 days remaining
    expect(c.total).toBe(3);
  });

  test('an explicit undefined threshold falls back to the default', () => {
    const c = check(clean(), 'leads', { thresholds: { leads: undefined } });
    expect(c).toMatchObject({ threshold: 0, pass: true });
  });

  test('a task without progress counts as not started', () => {
    const p = project([{ ...t('a', 1), progress: undefined as unknown as number }], []);
    expect(check(p, 'missing-logic').taskIds).toEqual(['a']);
  });

  test('reschedule: true ignores stale computed values', () => {
    const p = schedule(clean());
    const stale = { ...p, end: new Date(2027, 0, 4, 17) }; // computed still says critical
    expect(check(stale, 'critical-path').pass).toBe(true);
    expect(check(stale, 'critical-path', { reschedule: true }).pass).toBe(false);
  });

  test('each check says what it counts and cites its DCMA number', () => {
    const r = checkSchedule(clean());
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by['missing-logic']).toMatchObject({ unit: 'tasks', dcma: 1 });
    expect(by.leads).toMatchObject({ unit: 'links', dcma: 2 });
    expect(by['critical-path']).toMatchObject({ unit: 'project', dcma: 12 });
  });
});

describe('checkSchedule — project status date', () => {
  test('invalid-dates uses project.statusDate when no option is given', () => {
    const p = { ...project([t('late', 1)], []), statusDate: new Date(2026, 0, 12, 8) };
    // With the status date set, the not-started task is forecast from it — so
    // reschedule-free: build computed without the status date to get a past start.
    const scheduled = { ...schedule(project([t('late', 1)], [])), statusDate: p.statusDate };
    expect(check(scheduled, 'invalid-dates').taskIds).toEqual(['late']);
  });
});

describe('checkSchedule — engine progress state', () => {
  test('actualFinish with progress 0 counts as complete; actualStart with progress 0 as in progress', () => {
    const status = new Date(2026, 0, 14, 8);
    const p = schedule({
      ...project(
        [
          t('done', 1, {
            actualStart: new Date(2026, 0, 5, 8),
            actualFinish: new Date(2026, 0, 5, 17),
          }),
          t('going', 5, { actualStart: new Date(2026, 0, 12, 8) }),
        ],
        [],
      ),
      statusDate: status,
    });
    expect(check(p, 'invalid-dates').taskIds).toEqual([]);
    expect(check(p, 'missing-logic').total).toBe(1); // only 'going' is incomplete
  });
});
