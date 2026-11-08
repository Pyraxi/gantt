import { describe, expect, test } from 'vitest';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task, WorkInterval } from './types';

// Parity row 4 — per-task / per-resource calendars in schedule().
// Spec: docs/superpowers/specs/2026-10-16-effective-calendars-design.md

const DAY: WorkInterval[] = [{ startMinutes: 480, endMinutes: 1020 }]; // 8-5, 540 min
const D = 540;

const std: Calendar = {
  id: 'std',
  name: 'Standard M-F',
  workWeek: [[], DAY, DAY, DAY, DAY, DAY, []],
  exceptions: [],
};
const sixDay: Calendar = {
  id: '6d',
  name: 'Six day',
  workWeek: [[], DAY, DAY, DAY, DAY, DAY, DAY],
  exceptions: [],
};
const fourDay: Calendar = {
  id: '4d',
  name: 'Plasterer (Fri off)',
  baseCalendarId: 'std',
  workWeek: [[], [], [], [], [], [], []],
  inheritedDays: [0, 1, 2, 3, 4, 6],
  exceptions: [],
};

const MON = new Date(2026, 0, 5, 8); // Mon 5 Jan 2026, 8am

function task(id: string, days: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: days * D,
    start: MON,
    end: MON,
    progress: 0,
    ...overrides,
  };
}

function link(source: string, target: string, type: Link['type'] = 'FS', lagDays = 0): Link {
  return { id: `${source}-${target}`, source, target, type, lag: lagDays * D };
}

function project(tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}): Project {
  return {
    start: MON,
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [std, sixDay, fourDay],
    baselines: [],
    assignments: [],
    ...extra,
  };
}

const at = (out: Project, id: string) => {
  const t = out.tasks.find((x) => x.id === id);
  if (!t?.computed) throw new Error(`no computed for ${id}`);
  return t.computed;
};

describe('schedule() — task calendars', () => {
  test('a six-day task finishes a day earlier across a Saturday than the default calendar', () => {
    const out = schedule(project([task('std', 6), task('six', 6, { calendarId: '6d' })]));
    // Default: Mon-Fri + Mon → finishes Mon 12 Jan 5pm.
    expect(at(out, 'std').earlyFinish).toEqual(new Date(2026, 0, 12, 17));
    // Six-day: Mon-Sat → finishes Sat 10 Jan 5pm.
    expect(at(out, 'six').earlyFinish).toEqual(new Date(2026, 0, 10, 17));
  });

  test('lag is measured in the successor calendar', () => {
    // A (std) finishes Fri 9 Jan 5pm. 1-day lag into a six-day successor
    // consumes Saturday, so B starts Mon 12 Jan 8am (not Tue).
    const out = schedule(
      project([task('a', 5), task('b', 1, { calendarId: '6d' })], [link('a', 'b', 'FS', 1)]),
    );
    expect(at(out, 'b').earlyStart).toEqual(new Date(2026, 0, 12, 8));
  });

  test('total slack is measured in the task own calendar', () => {
    // Driver: 6 std days → finishes Mon 12 Jan 5pm (project finish).
    // Six-day task of 1 day can start as late as Mon 12 Jan 8am: its slack in
    // its own calendar counts Mon 5 → Mon 12 as 6 days (Mon-Sat); in the
    // default calendar it would be 5.
    const out = schedule(project([task('driver', 6), task('six', 1, { calendarId: '6d' })]));
    expect(at(out, 'six').totalSlack).toBe(6 * D);
    expect(at(out, 'driver').totalSlack).toBe(0);
  });

  test('a predecessor working Saturdays feeds a std successor that waits until Monday', () => {
    // A six-day 6-day task finishes Sat 10 Jan 5pm; std successor B starts Mon 12 Jan 8am.
    const out = schedule(
      project([task('a', 6, { calendarId: '6d' }), task('b', 1)], [link('a', 'b')]),
    );
    expect(at(out, 'b').earlyStart).toEqual(new Date(2026, 0, 12, 8));
    // Backward: B's late start Mon 8am → A's late finish snaps back to Sat 5pm in A's calendar.
    expect(at(out, 'a').lateFinish).toEqual(new Date(2026, 0, 10, 17));
    expect(at(out, 'a').totalSlack).toBe(0);
  });
});

describe('schedule() — resource calendars', () => {
  test('a task assigned to a Fridays-off resource skips Friday', () => {
    const out = schedule(
      project([task('a', 5, { resourceIds: ['plas'] })], [], {
        resources: [{ id: 'plas', name: 'Plasterer', calendarId: '4d' }],
      }),
    );
    // Mon-Thu + (skip Fri) Mon → finishes Mon 12 Jan 5pm.
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 12, 17));
  });

  test('ignoreResourceCalendar keeps the task on its own calendar', () => {
    const out = schedule(
      project([task('a', 5, { resourceIds: ['plas'], ignoreResourceCalendar: true })], [], {
        resources: [{ id: 'plas', name: 'Plasterer', calendarId: '4d' }],
      }),
    );
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 9, 17));
  });

  test('assignments (not only resourceIds) bring in resource calendars', () => {
    const out = schedule(
      project([task('a', 5)], [], {
        resources: [{ id: 'plas', name: 'Plasterer', calendarId: '4d' }],
        assignments: [{ id: 'x', taskId: 'a', resourceId: 'plas', units: 1 }],
      }),
    );
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 12, 17));
  });
});

describe('schedule() — never throws on calendar data a project can contain', () => {
  test('an unknown task calendar falls back to the default and is flagged', () => {
    const out = schedule(project([task('a', 1, { calendarId: 'gone' })]));
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 5, 17));
    expect(at(out, 'a').calendarFallback).toBe('unknown-calendar');
  });

  test('an MSPDI-style derived resource calendar with no weekdays inherits the base', () => {
    const derived: Calendar = {
      id: '9',
      name: 'Joe Bloggs',
      baseCalendarId: 'std',
      workWeek: [[], [], [], [], [], [], []],
      inheritedDays: [0, 1, 2, 3, 4, 5, 6],
      exceptions: [],
    };
    const p = project([task('a', 5, { resourceIds: ['joe'] })], [], {
      resources: [{ id: 'joe', name: 'Joe', calendarId: '9' }],
      calendars: [std, derived],
    });
    const out = schedule(p);
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 9, 17));
    expect(at(out, 'a').calendarFallback).toBeUndefined();
  });

  test('task and resource calendars with no common working time fall back and are flagged', () => {
    const weekend: Calendar = {
      id: 'we',
      name: 'Weekend',
      workWeek: [DAY, [], [], [], [], [], DAY],
      exceptions: [],
    };
    const out = schedule(
      project([task('a', 1, { resourceIds: ['r'] })], [], {
        resources: [{ id: 'r', name: 'R', calendarId: 'we' }],
        calendars: [std, weekend],
      }),
    );
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 5, 17));
    expect(at(out, 'a').calendarFallback).toBe('empty-intersection');
  });
});

describe('schedule() — default-calendar projects are unchanged', () => {
  test('no calendarFallback key appears when nothing falls back', () => {
    const out = schedule(project([task('a', 2), task('b', 1)], [link('a', 'b')]));
    expect('calendarFallback' in at(out, 'a')).toBe(false);
  });
});

describe('schedule() — cross-calendar review fixes (2026-10-16)', () => {
  const early: Calendar = {
    id: 'early',
    name: 'Early 7-3',
    workWeek: [[], ...Array(5).fill([{ startMinutes: 420, endMinutes: 900 }]), []],
    exceptions: [],
  };

  test('a zero-float FS chain into an earlier-finishing calendar keeps zero slack', () => {
    // T1 works 7-3; its successor T3 (std) starts Mon 12 Jan 8am. Re-expressing
    // T3's late start in T1's calendar must not pull T0 (std) into negative slack.
    const out = schedule(
      project(
        [task('t0', 5), task('t1', 0, { calendarId: 'early' }), task('t3', 1)],
        [link('t0', 't1'), link('t1', 't3')],
        { calendars: [std, early] },
      ),
    );
    for (const id of ['t0', 't1', 't3']) {
      expect(at(out, id).totalSlack).toBeGreaterThanOrEqual(0);
      expect(at(out, id).freeSlack).toBeGreaterThanOrEqual(0);
    }
  });

  test('negative lag into a different calendar does not create negative slack', () => {
    const out = schedule(
      project(
        [task('a', 1), task('b', 1, { calendarId: 'early' })],
        [link('a', 'b', 'FS', -120 / D)],
        {
          calendars: [std, early],
        },
      ),
    );
    expect(at(out, 'a').totalSlack).toBeGreaterThanOrEqual(0);
    expect(at(out, 'a').freeSlack).toBeGreaterThanOrEqual(0);
  });

  test('randomised mixed-calendar networks without constraints never show negative slack', () => {
    const cals = [std, sixDay, fourDay, early];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 150; n++) {
      const tasks = Array.from({ length: 12 }, (_, i) =>
        task(`t${i}`, Math.floor(rnd() * 4), {
          calendarId: cals[Math.floor(rnd() * cals.length)]?.id,
        }),
      );
      const links: Link[] = [];
      for (let i = 1; i < 12; i++) {
        const src = Math.floor(rnd() * i);
        const types: Link['type'][] = ['FS', 'SS', 'FF', 'SF'];
        links.push({
          id: `l${i}`,
          source: `t${src}`,
          target: `t${i}`,
          type: types[Math.floor(rnd() * 4)] ?? 'FS',
          lag: 0,
        });
      }
      const out = schedule(project(tasks, links, { calendars: cals }));
      for (const t of out.tasks) {
        expect(t.computed?.totalSlack, `seed ${n} ${t.id}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('a task calendar with no working time falls back to the default instead of throwing', () => {
    const dead: Calendar = {
      id: 'dead',
      name: 'Dead',
      workWeek: [[], [], [], [], [], [], []],
      exceptions: [],
    };
    const orphan: Calendar = {
      id: 'orphan',
      name: 'Orphan derived',
      baseCalendarId: 'gone',
      inheritedDays: [0, 1, 2, 3, 4, 5, 6],
      workWeek: [[], [], [], [], [], [], []],
      exceptions: [],
    };
    const cycA: Calendar = { ...orphan, id: 'cycA', baseCalendarId: 'cycB' };
    const cycB: Calendar = { ...orphan, id: 'cycB', baseCalendarId: 'cycA' };
    for (const calendarId of ['dead', 'orphan', 'cycA']) {
      const out = schedule(
        project([task('a', 1, { calendarId })], [], { calendars: [std, dead, orphan, cycA, cycB] }),
      );
      expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 5, 17));
      expect(at(out, 'a').calendarFallback).toBe('empty-calendar');
    }
  });

  test('a derived calendar with a short workWeek still inherits every listed day', () => {
    const short: Calendar = {
      id: 'short',
      name: 'Short',
      baseCalendarId: 'std',
      workWeek: [],
      inheritedDays: [1, 2, 3, 4, 5],
      exceptions: [],
    };
    const out = schedule(
      project([task('a', 1, { calendarId: 'short' })], [], { calendars: [std, short] }),
    );
    expect(at(out, 'a').earlyFinish).toEqual(new Date(2026, 0, 5, 17));
    expect(at(out, 'a').calendarFallback).toBeUndefined();
  });
});
