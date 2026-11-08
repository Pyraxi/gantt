import { describe, expect, test } from 'vitest';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// Parity row 6. Spec: docs/superpowers/specs/2026-10-16-status-date-progress-design.md

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const fs = (s: string, x: string, type: Link['type'] = 'FS'): Link => ({
  id: `${s}-${x}`,
  source: s,
  target: x,
  type,
  lag: 0,
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
  // These pin P6's data-date forecast, the opt-in (MS Project's default: schedule-status-msproject.test.ts).
  rescheduleAfterStatusDate: true,
  ...extra,
});
const c = (p: Project, id: string) => {
  const x = schedule(p).tasks.find((q) => q.id === id)?.computed;
  if (!x) throw new Error(`no computed for ${id}`);
  return x;
};

describe('schedule() with a status date', () => {
  test('without statusDate, progress stays cosmetic and no status fields appear', () => {
    const r = c(project([t('a', 5, { progress: 40 })], []), 'a');
    expect(r.earlyFinish).toEqual(d(9, 17));
    expect('status' in r).toBe(false);
  });

  test('a late in-progress task re-forecasts its remaining work from the status date', () => {
    // 5 days from Mon 5, 40% done, status Wed 14 (2 working days after its planned
    // finish on Fri 9). Remaining 3 days from Wed 14 8:00 → Fri 16 17:00.
    const p = project([t('a', 5, { progress: 40, actualStart: d(5) }), t('b', 1)], [fs('a', 'b')], {
      statusDate: d(14),
    });
    const a = c(p, 'a');
    expect(a.status).toBe('in-progress');
    expect(a.earlyStart).toEqual(d(5));
    expect(a.remainingStart).toEqual(d(14));
    expect(a.earlyFinish).toEqual(d(16, 17));
    expect(c(p, 'b').earlyStart).toEqual(d(19));
  });

  test('remainingDuration overrides the progress-derived remaining work', () => {
    const p = project(
      [t('a', 5, { progress: 40, actualStart: d(5), remainingDuration: DAY })],
      [],
      {
        statusDate: d(14),
      },
    );
    expect(c(p, 'a').earlyFinish).toEqual(d(14, 17));
  });

  test('complete tasks are fixed at their actuals, carry no float, are not critical, and drive successors', () => {
    const p = project(
      [t('a', 5, { progress: 100, actualStart: d(5), actualFinish: d(6, 17) }), t('b', 2)],
      [fs('a', 'b')],
      { statusDate: d(14) },
    );
    const a = c(p, 'a');
    expect(a).toMatchObject({
      status: 'complete',
      earlyStart: d(5),
      earlyFinish: d(6, 17),
      totalSlack: 0,
      isCritical: false,
    });
    // b could start Wed 7 after a's actual finish, but not before the status date.
    expect(c(p, 'b').earlyStart).toEqual(d(14));
  });

  test('an unstarted task whose predecessor finished early starts no earlier than the status date', () => {
    const p = project(
      [t('a', 1, { progress: 100, actualFinish: d(5, 17) }), t('b', 1)],
      [fs('a', 'b')],
      {
        statusDate: d(8),
      },
    );
    expect(c(p, 'b')).toMatchObject({ status: 'not-started', earlyStart: d(8) });
  });

  test('out of sequence: retained logic waits for the predecessor; progress override does not', () => {
    // b started Tue 6 although its FS predecessor a (10 days, not started) hasn't finished.
    const tasks = [t('a', 10), t('b', 4, { progress: 50, actualStart: d(6) })];
    const retained = project(tasks, [fs('a', 'b')], { statusDate: d(7) });
    const rb = c(retained, 'b');
    expect(rb.outOfSequence).toBe(true);
    // a: not started → from status Wed 7, 10 days → Tue 20 17:00; b's remaining 2 days → Wed 21, Thu 22.
    expect(rb.remainingStart).toEqual(d(21));
    expect(rb.earlyFinish).toEqual(d(22, 17));
    const override = { ...retained, progressMode: 'progress-override' as const };
    const ob = c(override, 'b');
    expect(ob.outOfSequence).toBe(true);
    expect(ob.remainingStart).toEqual(d(7));
    expect(ob.earlyFinish).toEqual(d(8, 17));
  });

  test('in-progress float is finish float (late finish − early finish)', () => {
    // a in progress (2 days left from status), b 6 days unrelated drives the finish.
    const p = project([t('a', 4, { progress: 50, actualStart: d(5) }), t('b', 6)], [], {
      statusDate: d(5),
    });
    // b: Mon 5 → Mon 12 17:00. a remaining 2 days Mon 5 → Tue 6 17:00 → 4 days finish float.
    expect(c(p, 'a').totalSlack).toBe(4 * DAY);
  });

  test('progress without actualStart counts as started at the task start', () => {
    const p = project([t('a', 2, { progress: 50, start: d(5), end: d(6, 17) })], [], {
      statusDate: d(12),
    });
    expect(c(p, 'a')).toMatchObject({
      status: 'in-progress',
      earlyStart: d(5),
      earlyFinish: d(12, 17),
    });
  });

  test('a summary rolls up actual and forecast dates', () => {
    const p = project(
      [
        t('s', 0, { type: 'summary' }),
        t('a', 2, { parent: 's', progress: 100, actualStart: d(5), actualFinish: d(6, 17) }),
        t('b', 2, { parent: 's' }),
      ],
      [fs('a', 'b')],
      { statusDate: d(12) },
    );
    expect(c(p, 's')).toMatchObject({ earlyStart: d(5), earlyFinish: d(13, 17) });
  });
});

describe('status date — review fixes', () => {
  test('a finish constraint on a late in-progress task shows negative float', () => {
    const p = project(
      [
        t('a', 5, {
          progress: 40,
          actualStart: d(5),
          constraint: { type: 'FNLT', date: d(14, 17) },
        }),
      ],
      [],
      { statusDate: d(14) },
    );
    // Remaining 3 days from Wed 14 → Fri 16; FNLT Wed 14 → 2 days late.
    expect(c(p, 'a').totalSlack).toBe(-2 * DAY);
  });

  test('MFO pins an in-progress finish; start constraints are ignored once started', () => {
    const p = project(
      [
        t('mfo', 5, {
          progress: 40,
          actualStart: d(5),
          constraint: { type: 'MFO', date: d(20, 17) },
        }),
        t('snet', 5, {
          progress: 40,
          actualStart: d(5),
          constraint: { type: 'SNET', date: d(26) },
        }),
      ],
      [],
      { statusDate: d(14) },
    );
    expect(c(p, 'mfo').earlyFinish).toEqual(d(20, 17));
    expect(c(p, 'snet').earlyFinish).toEqual(d(16, 17));
  });

  test('free slack of an in-progress source uses its remaining work', () => {
    // a 10 days, 80% done → 2 days left from Wed 14 → Thu 15; SS to b (5 days).
    const p = project(
      [t('a', 10, { progress: 80, actualStart: d(5) }), t('b', 5)],
      [fs('a', 'b', 'SS')],
      {
        statusDate: d(14),
      },
    );
    const a = c(p, 'a');
    expect(a.freeSlack).toBeLessThanOrEqual(a.totalSlack);
  });

  test('free slack into an in-progress successor is measured to its remaining start', () => {
    const p = project(
      [t('a', 1), t('cc', 10), t('b', 4, { progress: 50, actualStart: d(6) })],
      [fs('a', 'b'), fs('cc', 'b')],
      { statusDate: d(7) },
    );
    expect(c(p, 'cc').freeSlack).toBe(0);
    expect(c(p, 'a').freeSlack).toBeGreaterThanOrEqual(0);
  });

  test('FF and SF links do not make a started successor out of sequence', () => {
    const tasks = [
      t('a', 10),
      t('b', 4, { progress: 50, actualStart: d(6) }),
      t('c', 4, { progress: 50, actualStart: d(6) }),
    ];
    const p = project(tasks, [fs('a', 'b', 'FF'), fs('a', 'c', 'SF')], { statusDate: d(7) });
    expect(c(p, 'b').outOfSequence).toBeUndefined();
    expect(c(p, 'c').outOfSequence).toBeUndefined();
  });

  test('manual-mode tasks keep their user dates in status mode (MS Project semantics)', () => {
    const p = project(
      [
        t('m', 5, { scheduleMode: 'manual', start: d(5), end: d(9, 17), progress: 40 }),
        t('after', 1),
      ],
      [fs('m', 'after')],
      { statusDate: d(14) },
    );
    const m = c(p, 'm');
    expect(m.earlyFinish).toEqual(d(9, 17));
    expect(m.status).toBe('in-progress');
    expect(c(p, 'after').earlyStart).toEqual(d(14)); // status-date floor still applies to auto successors
  });

  test('a complete task does not alias its early / late Date objects', () => {
    const a = c(project([t('a', 1, { progress: 100 })], [], { statusDate: d(14) }), 'a');
    expect(a.lateStart).not.toBe(a.earlyStart);
  });
});
