import { describe, expect, it } from 'vitest';
import { CreateLinkCommand } from './editing/commands';
import { EditError } from './editing/errors';
import { linkTasks } from './editing/factories';
import { schedule } from './schedule';
import { topologicalSort } from './topological-sort';
import type { Calendar, Link, Project, Task, TaskComputed, WorkInterval } from './types';
import { workingMinutesBetween } from './working-time';

// Edge-case sweep (network + calendars). Each case is judged against MS Project
// / P6 behaviour, not against the product whose behaviour list prompted it:
// PASS = ours is right; BY-DESIGN = ours deliberately differs (reason inline);
// DEFECT = `it.fails` pins the correct behaviour until the engine is fixed.

const DAY = 540;
const WORK: WorkInterval[] = [{ startMinutes: 480, endMinutes: 1020 }];
const std: Calendar = {
  id: 'std',
  name: 'Std M-F 8-5',
  workWeek: [[], WORK, WORK, WORK, WORK, WORK, []],
  exceptions: [],
};
const sixDay: Calendar = {
  id: 'six',
  name: 'Mon-Sat 8-5',
  workWeek: [[], WORK, WORK, WORK, WORK, WORK, WORK],
  exceptions: [],
};
/** Std calendar with non-working days on the given January 2026 dates. */
const withHolidays = (...days: number[]): Calendar => ({
  ...std,
  exceptions: days.map((day) => ({ date: new Date(2026, 0, day), isWorking: false })),
});

const MON = new Date(2026, 0, 5, 8); // Mon 5 Jan 2026 08:00
const d = (day: number, h = 8, m = 0) => new Date(2026, 0, day, h, m);
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
const link = (s: string, x: string, type: Link['type'] = 'FS', lag = 0): Link => ({
  id: `${s}-${x}`,
  source: s,
  target: x,
  type,
  lag,
});
const project = (tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}): Project => ({
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std, sixDay],
  baselines: [],
  assignments: [],
  ...extra,
});
const computedOf = (p: Project) => {
  const out = schedule(p);
  return (id: string): TaskComputed => {
    const c = out.tasks.find((x) => x.id === id)?.computed;
    if (!c) throw new Error(`no computed for ${id}`);
    return c;
  };
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

describe('edge sweep: network', () => {
  it('a zero-duration activity passes its predecessor finish straight through', () => {
    const c = computedOf(
      project([t('a', 1), t('z', 0), t('b', 1)], [link('a', 'z'), link('z', 'b')]),
    );
    // Mon 17:00 ≡ Tue 08:00: the milestone sits at the next working moment.
    expect(c('z').earlyStart).toEqual(d(6));
    expect(c('z').earlyFinish).toEqual(c('z').earlyStart);
    expect(c('b').earlyStart).toEqual(d(6));
    expect(Object.is(c('z').totalSlack, 0)).toBe(true); // not -0
    expect(c('z').isCritical).toBe(true);
  });

  it('a negative duration schedules exactly like a zero-duration milestone', () => {
    const net = (z: Task) =>
      computedOf(project([t('a', 1), z, t('b', 1)], [link('a', 'z'), link('z', 'b')]));
    const neg = net(t('z', 0, { duration: -DAY }));
    const zero = net(t('z', 0));
    for (const id of ['a', 'z', 'b']) expect(neg(id)).toEqual(zero(id));
  });

  it('FF lets a successor start before its predecessor starts', () => {
    // p (2d) → a (1d, Wed) —FF→ b (3d): b only has to finish with a.
    const c = computedOf(
      project([t('p', 2), t('a', 1), t('b', 3)], [link('p', 'a'), link('a', 'b', 'FF')]),
    );
    expect(c('a').earlyStart).toEqual(d(7));
    expect(c('b').earlyStart).toEqual(d(5));
    expect(c('b').earlyStart.getTime()).toBeLessThan(c('a').earlyStart.getTime());
    expect(c('b').earlyFinish).toEqual(c('a').earlyFinish);
  });

  it('a lead starts the successor before its predecessor finishes', () => {
    const c = computedOf(project([t('a', 2), t('b', 1)], [link('a', 'b', 'FS', -DAY)]));
    expect(c('a').earlyFinish).toEqual(d(6, 17));
    expect(c('b').earlyStart).toEqual(d(6)); // Tue 17:00 − 1d = Tue 08:00
  });

  it('only the last task of a slack branch owns free float', () => {
    // a → b1 → b2 → d (short branch) ; a → c (5d) → d (critical)
    const c = computedOf(
      project(
        [t('a', 1), t('b1', 1), t('b2', 1), t('c', 5), t('d', 1)],
        [link('a', 'b1'), link('b1', 'b2'), link('b2', 'd'), link('a', 'c'), link('c', 'd')],
      ),
    );
    expect(c('b1').totalSlack).toBe(3 * DAY);
    expect(c('b2').totalSlack).toBe(3 * DAY);
    expect(c('b1').freeSlack).toBe(0);
    expect(c('b2').freeSlack).toBe(3 * DAY);
  });

  // Was a DEFECT (free float 0 with no successor); MS Project / P6 measure it
  // to the project's early finish, never more than total slack.
  it('a task with no successors has free float up to the project finish', () => {
    const c = computedOf(project([t('a', 5), t('x', 1)]));
    expect(c('x').totalSlack).toBe(4 * DAY);
    expect(c('x').freeSlack).toBe(4 * DAY);
    expect(c('a').freeSlack).toBe(0);
  });

  it('free float with no successor never exceeds total slack', () => {
    // A finish-no-later-than on x leaves it 1 day of total slack, though the
    // project finishes 4 days after it.
    const c = computedOf(
      project([t('a', 5), t('x', 1, { constraint: { type: 'FNLT', date: d(6, 17) } })]),
    );
    expect(c('x').totalSlack).toBe(DAY);
    expect(c('x').freeSlack).toBe(DAY);
  });

  it('a terminal milestone reports free float 0, not -0', () => {
    // z sits at Tue 08:00 (≡ Mon 17:00): its late start is a reverse span
    // with no working time, which must not surface as -0 in either float.
    const c = computedOf(project([t('a', 1), t('z', 0, { type: 'milestone' })], [link('a', 'z')]));
    expect(Object.is(c('z').totalSlack, 0)).toBe(true);
    expect(Object.is(c('z').freeSlack, 0)).toBe(true);
  });

  it('slack in the assembly pass equals workingMinutesBetween', () => {
    // Open-ended leaves float ~90 days to the project finish (long spans take
    // the memoised counter); p and r lead into the long task, so p's 3-day
    // float keeps the walk. Both must give the walk's numbers.
    const hol = { ...withHolidays(14, 26), id: 'hol' };
    const tasks = [
      t('long', 90),
      t('p', 2),
      t('r', 5),
      ...Array.from({ length: 12 }, (_, i) => t(`x${i}`, (i % 4) + 1)),
    ];
    const links = [link('p', 'long'), link('r', 'long')];
    const out = schedule(
      project(tasks, links, { calendars: [std, hol], defaultCalendarId: 'hol' }),
    );
    const finish = out.tasks.find((x) => x.id === 'long')?.computed?.earlyFinish as Date;
    const c = (id: string) => out.tasks.find((x) => x.id === id)?.computed as TaskComputed;
    expect(c('p').totalSlack).toBe(3 * DAY);
    expect(c('x0').totalSlack).toBeGreaterThan(80 * DAY);
    for (const x of out.tasks) {
      const k = x.computed as TaskComputed;
      const kc = hol;
      expect(k.totalSlack).toBe(workingMinutesBetween(k.earlyStart, k.lateStart, kc));
      if (x.id === 'p' || x.id === 'r') continue; // free float to a successor
      expect(k.freeSlack).toBe(
        Math.min(k.totalSlack, workingMinutesBetween(k.earlyFinish, finish, kc)),
      );
    }
  });

  it('a task whose only successor is unscheduled floats to the project finish', () => {
    const c = computedOf(
      project([t('a', 5), t('x', 1), t('u', 1, { unscheduled: true })], [link('x', 'u')]),
    );
    expect(c('x').freeSlack).toBe(4 * DAY);
  });

  it('BY-DESIGN: negative float is reported, not clipped, and the task is critical', () => {
    // ADR-003: a 3-day task into a successor pinned to finish Wed is 2 days late.
    const c = computedOf(
      project(
        [t('a', 3), t('b', 2, { constraint: { type: 'MFO', date: d(7, 17) } })],
        [link('a', 'b')],
      ),
    );
    expect(c('a').totalSlack).toBe(-2 * DAY);
    expect(c('a').isCritical).toBe(true);
  });

  it('BY-DESIGN: disconnected islands all start at the project start; float runs to the project finish', () => {
    // MS Project / P6: total float is measured to the project finish, so a short
    // island is not critical just because it ends its own chain.
    const c = computedOf(
      project([t('a', 5), t('b', 2), t('x', 1), t('y', 1)], [link('a', 'b'), link('x', 'y')]),
    );
    expect(c('a').earlyStart).toEqual(MON);
    expect(c('x').earlyStart).toEqual(MON);
    expect(c('y').earlyFinish).toEqual(d(6, 17));
    expect(c('b').isCritical).toBe(true);
    expect(c('x').totalSlack).toBe(5 * DAY);
    expect(c('y').totalSlack).toBe(5 * DAY);
    expect(c('y').isCritical).toBe(false);
  });

  it('BY-DESIGN: a self-link is refused loudly rather than dropped', () => {
    // A self-link is a data error; schedule() reports it as a cycle and the
    // edit layer refuses to create one.
    expect(() => schedule(project([t('a', 1)], [link('a', 'a')]))).toThrow(/cycle/);
    expect(() => linkTasks('a', 'a').apply(project([t('a', 1)]))).toThrow(EditError);
  });

  it('links to unknown task ids are ignored by schedule() and refused by the edit layer', () => {
    const plain = computedOf(project([t('a', 1)]));
    const dangling = computedOf(
      project([t('a', 1)], [link('ghost', 'a', 'FS', 5 * DAY), link('a', 'ghost')]),
    );
    expect(dangling('a')).toEqual(plain('a'));
    expect(() => linkTasks('ghost', 'a').apply(project([t('a', 1)]))).toThrow(EditError);
  });

  // Was a DEFECT: the id → task Maps kept the LAST duplicate, so both rows got
  // the 3-day row's dates. schedule() now refuses duplicate ids up front.
  it("a duplicate task id does not silently give the first row the second row's dates", () => {
    expect(() => schedule(project([t('a', 1), t('a', 3), t('b', 1)], [link('a', 'b')]))).toThrow(
      'schedule(): duplicate task id "a"',
    );
  });

  // Was a DEFECT: topologicalSort placed the duplicated id once and reported a
  // false "Link graph contains a cycle".
  it('a duplicate task id with a predecessor is not misreported as a cycle', () => {
    const p = project([t('x', 1), t('a', 1), t('a', 3)], [link('x', 'a')]);
    expect(() => schedule(p)).toThrow('schedule(): duplicate task id "a"');
    expect(() => schedule(p)).not.toThrow(/cycle/);
    expect(() => topologicalSort(p.tasks, p.links)).toThrow(
      'topologicalSort(): duplicate task id "a"',
    );
  });

  it('every duplicated id is named', () => {
    const p = project([t('a', 1), t('b', 1), t('a', 1), t('b', 1), t('c', 1)]);
    expect(() => schedule(p)).toThrow('schedule(): duplicate task ids "a", "b"');
  });

  it('shuffled tasks and links give identical dates and float', () => {
    const tasks = [
      t('a', 2),
      t('b', 2),
      t('c', 1),
      t('d', 3),
      t('e', 1),
      t('f', 1),
      t('g', 0, { type: 'milestone' }),
    ];
    const links = [
      link('a', 'c'), // a and b finish together: a tie for driving c
      link('b', 'c'),
      link('c', 'd', 'SS', DAY),
      link('e', 'd', 'FF'),
      link('d', 'g'),
    ];
    const snapshot = (p: Project) => {
      const s = schedule(p);
      const dates = Object.fromEntries(
        [...s.tasks]
          .sort((x, y) => String(x.id).localeCompare(String(y.id)))
          .map((x) => [x.id, x.computed]),
      );
      return { dates };
    };
    const reference = snapshot(project(tasks, links));
    // Seeded Fisher–Yates so a failure is reproducible.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const shuffle = <T>(xs: T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    };
    for (let round = 0; round < 8; round++) {
      expect(snapshot(project(shuffle(tasks), shuffle(links)))).toEqual(reference);
    }
  });
});

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

describe('edge sweep: calendars', () => {
  it('ten working days from Monday finish on the Friday of the following week', () => {
    expect(computedOf(project([t('a', 10)]))('a').earlyFinish).toEqual(d(16, 17));
  });

  it('a holiday on the natural finish rolls the finish to the next working day', () => {
    const p = project([t('a', 5)], [], { calendars: [withHolidays(9)] });
    expect(computedOf(p)('a').earlyFinish).toEqual(d(12, 17));
  });

  it('consecutive holidays are both dropped', () => {
    const p = project([t('a', 5)], [], { calendars: [withHolidays(8, 9)] });
    expect(computedOf(p)('a').earlyFinish).toEqual(d(13, 17));
  });

  it('a holiday on a weekend changes nothing', () => {
    const p = project([t('a', 5), t('b', 5)], [link('a', 'b')], {
      calendars: [withHolidays(10, 11)],
    });
    const c = computedOf(p);
    expect(c('a').earlyFinish).toEqual(d(9, 17));
    expect(c('b').earlyFinish).toEqual(d(16, 17));
  });

  it('a finish counted from a Friday before 1970 lands on Monday', () => {
    const fri = new Date(1969, 11, 26, 8); // Fri 26 Dec 1969
    const c = computedOf(
      project([t('a', 1), t('b', 1), t('c', 2)], [link('a', 'b')], { start: fri }),
    );
    expect(fri.getDay()).toBe(5);
    expect(c('a').earlyFinish).toEqual(new Date(1969, 11, 26, 17));
    expect(c('b').earlyStart).toEqual(new Date(1969, 11, 29, 8));
    expect(c('c').earlyFinish).toEqual(new Date(1969, 11, 29, 17));
  });

  it('a milestone pinned on a weekend keeps its date and its successor keeps the lag offset', () => {
    const sat = d(10, 10);
    for (const m of [
      t('m', 0, { type: 'milestone', constraint: { type: 'MSO', date: sat } }),
      t('m', 0, { type: 'milestone', scheduleMode: 'manual', start: sat, end: sat }),
    ]) {
      const c = computedOf(project([m, t('b', 1)], [link('m', 'b', 'FS', DAY)]));
      expect(c('m').earlyStart).toEqual(sat);
      // One working day after Sat = all of Mon, so b starts Tue 08:00.
      expect(c('b').earlyStart).toEqual(d(13));
    }
  });

  it('a project start on a weekend does not make a shorter parallel root critical', () => {
    const c = computedOf(
      project([t('a', 2), t('b', 1), t('c', 1)], [link('a', 'c'), link('b', 'c')], {
        start: new Date(2026, 0, 3, 8), // Sat
      }),
    );
    expect(c('a').earlyStart).toEqual(MON);
    expect(c('b').totalSlack).toBe(DAY);
    expect(c('b').isCritical).toBe(false);
  });

  it('a project start on a holiday does not make a shorter parallel root critical', () => {
    const c = computedOf(
      project([t('a', 2), t('b', 1), t('c', 1)], [link('a', 'c'), link('b', 'c')], {
        calendars: [withHolidays(5)],
      }),
    );
    expect(c('a').earlyStart).toEqual(d(6));
    expect(c('b').totalSlack).toBe(DAY);
    expect(c('b').isCritical).toBe(false);
  });

  it("a late root's start is a floor: its successor never lands before it", () => {
    const late = d(12);
    for (const root of [
      t('r', 1, { scheduleMode: 'manual', start: late, end: d(12, 17) }),
      t('r', 1, { constraint: { type: 'SNET', date: late } }),
    ]) {
      const c = computedOf(project([root, t('s', 1)], [link('r', 's')]));
      expect(c('r').earlyStart).toEqual(late);
      expect(c('s').earlyStart).toEqual(d(13));
    }
  });

  it("BY-DESIGN: an auto root's stored start is output, not a floor (SNET is the floor)", () => {
    // MS Project turns a typed start into SNET; our model keeps that explicit
    // (programme import adds the SNET). A bare `start` is recomputed.
    const c = computedOf(project([t('r', 1, { start: d(12), end: d(12, 17) })]));
    expect(c('r').earlyStart).toEqual(MON);
  });

  it('a short workWeek treats the missing weekdays as non-working', () => {
    const short: Calendar = {
      id: 'short',
      name: 'Mon-Tue',
      workWeek: [[], WORK, WORK],
      exceptions: [],
    };
    const p = project([t('a', 3)], [], { defaultCalendarId: 'short', calendars: [short] });
    expect(computedOf(p)('a').earlyFinish).toEqual(d(12, 17));
  });

  it('BY-DESIGN: an all-non-working default calendar fails fast (nothing to fall back to)', () => {
    const empty: Calendar = {
      id: 'none',
      name: 'none',
      workWeek: Array(7).fill([]),
      exceptions: [],
    };
    const p = project([t('a', 2)], [], { defaultCalendarId: 'none', calendars: [empty] });
    expect(() => schedule(p)).toThrow(/no working time/);
  });

  it('an interval running past midnight terminates (honoured literally as an overnight shift)', () => {
    const overnight: Calendar = {
      id: 'night',
      name: 'Mon runs to Tue 09:20',
      workWeek: [[], [{ startMinutes: 480, endMinutes: 2000 }], WORK, WORK, WORK, WORK, []],
      exceptions: [],
    };
    const p = project([t('a', 2)], [], { defaultCalendarId: 'night', calendars: [overnight] });
    expect(computedOf(p)('a').earlyFinish).toEqual(d(6, 2));
  });

  // Was a DEFECT: an inverted interval (end < start) yielded negative
  // "available" minutes in addWorkingMinutes, which ADDED to the remaining
  // work. Inverted / zero-length intervals now count as no time.
  it('an inverted (end < start) interval is ignored instead of inflating durations', () => {
    const inverted: Calendar = {
      id: 'inv',
      name: 'Mon inverted',
      workWeek: [[], [{ startMinutes: 1020, endMinutes: 480 }], WORK, WORK, WORK, WORK, []],
      exceptions: [],
    };
    const p = project([t('a', 2)], [], {
      start: d(9), // Fri
      defaultCalendarId: 'inv',
      calendars: [inverted],
    });
    expect(computedOf(p)('a').earlyFinish).toEqual(d(13, 17)); // Fri + Tue
  });

  // Was a DEFECT: with ONLY inverted intervals in the default calendar,
  // schedule() looped forever (the remaining work grew by 9h a week). A read
  // counter on `exceptions` breaks a runaway loop so this test can't hang.
  it('a default calendar with only inverted intervals fails fast instead of hanging', () => {
    let reads = 0;
    const inverted = {
      id: 'inv',
      name: 'inverted only',
      workWeek: [[], [{ startMinutes: 1020, endMinutes: 480 }], [], [], [], [], []],
    } as unknown as Calendar;
    Object.defineProperty(inverted, 'exceptions', {
      get() {
        reads++;
        if (reads > 50_000) throw new Error('runaway: calendar read 50k times');
        return [];
      },
    });
    const p = project([t('a', 2)], [], { defaultCalendarId: 'inv', calendars: [inverted] });
    let error: unknown;
    try {
      schedule(p);
    } catch (e) {
      error = e;
    }
    expect(String(error ?? '')).not.toMatch(/runaway/);
    expect(String(error ?? '')).toMatch(/no working time/);
  });
});

// ---------------------------------------------------------------------------
// Repeated edge writes (the link-edit side of "import / input")
// ---------------------------------------------------------------------------

describe('edge sweep: repeated edge writes', () => {
  it('BY-DESIGN: linkTasks twice for the same pair throws instead of silently coalescing', () => {
    const p = linkTasks('a', 'b').apply(project([t('a', 1), t('b', 1)]));
    expect(() => linkTasks('a', 'b').apply(p)).toThrow(/duplicate link id/);
  });

  // Was a DEFECT: CreateLinkCommand only checked the link id, so the same a→b
  // FS link under a fresh id was stored twice (MS Project keeps one link per
  // pair, and diffPredecessors assumes one).
  it('a second identical link for the same pair under a new id is refused', () => {
    const p = linkTasks('a', 'b').apply(project([t('a', 1), t('b', 1)]));
    expect(() =>
      new CreateLinkCommand({ id: 'again', source: 'a', target: 'b', type: 'FS', lag: 0 }).apply(p),
    ).toThrow(EditError);
  });

  it('a second link of another type for the same pair is refused too; the reverse pair is not a duplicate', () => {
    const p = linkTasks('a', 'b').apply(project([t('a', 1), t('b', 1)]));
    expect(() =>
      new CreateLinkCommand({ id: 'ss', source: 'a', target: 'b', type: 'SS', lag: DAY }).apply(p),
    ).toThrow(EditError);
    // b → a is a different pair (it would form a cycle, which is schedule()'s concern).
    expect(() =>
      new CreateLinkCommand({ id: 'rev', source: 'b', target: 'a', type: 'FS', lag: 0 }).apply(p),
    ).not.toThrow(EditError);
  });
});
