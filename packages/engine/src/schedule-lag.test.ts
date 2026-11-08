import { describe, expect, test } from 'vitest';
import { parseMspdi } from './mspdi/parse';
import { serializeMspdi } from './mspdi/serialize';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';
import { addWorkingMinutes, workingMinutesBetween } from './working-time';

// Parity row 1. Spec: docs/superpowers/specs/2026-10-16-percent-elapsed-lag-design.md

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, days: number): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: d(5),
  end: d(5),
  progress: 0,
});
const project = (links: Link[], tasks = [t('a', 4), t('b', 1)]): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
});
const es = (p: Project, id: string) =>
  schedule(p).tasks.find((x) => x.id === id)?.computed?.earlyStart;

describe('percent lag', () => {
  test('FS+50% of a 4-day predecessor = 2 working days', () => {
    // a: Mon 5 → Thu 8 17:00; +2 days → Mon 12 17:00 → b starts Tue 13 8:00.
    const p = project([{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 0, lagPercent: 50 }]);
    expect(es(p, 'b')).toEqual(d(13));
  });

  test('SS+50% starts the successor half-way through the predecessor', () => {
    const p = project([{ id: 'l', source: 'a', target: 'b', type: 'SS', lag: 0, lagPercent: 50 }]);
    // SS+50% of 4 days = 2 days after a starts → Wed 7 8:00.
    expect(es(p, 'b')).toEqual(d(7));
  });

  test('lagPercent overrides lag', () => {
    const p = project([
      { id: 'l', source: 'a', target: 'b', type: 'FS', lag: 99 * DAY, lagPercent: 0 },
    ]);
    expect(es(p, 'b')).toEqual(d(9));
  });
});

describe('elapsed lag', () => {
  test('FS+2ed runs through the weekend (curing)', () => {
    // a: 4 days → Thu 8 17:00. +48h elapsed → Sat 10 17:00 → b starts Mon 12 8:00.
    // A working 2-day lag would give Tue 13.
    const p = project([
      { id: 'l', source: 'a', target: 'b', type: 'FS', lag: 48 * 60, lagElapsed: true },
    ]);
    expect(es(p, 'b')).toEqual(d(12));
    const working = project([{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 2 * DAY }]);
    expect(es(working, 'b')).toEqual(d(13));
  });

  test('backward pass and float honour elapsed lag', () => {
    // a can finish as late as Fri 9 17:00: + 48 h elapsed = Sun 11 17:00, still
    // before b's Mon 12 8:00 start. So a carries one working day of float.
    const p = project([
      { id: 'l', source: 'a', target: 'b', type: 'FS', lag: 48 * 60, lagElapsed: true },
    ]);
    const a = schedule(p).tasks.find((x) => x.id === 'a')?.computed;
    expect(a?.lateFinish).toEqual(d(9, 17));
    expect(a?.totalSlack).toBe(DAY);
    expect(a?.freeSlack).toBe(DAY);
  });
});

describe('MSPDI LagFormat', () => {
  const xml = (
    lag: number,
    fmt: number,
  ) => `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><StartDate>2026-01-05T08:00:00</StartDate>
    <Tasks><Task><UID>1</UID><ID>1</ID><Name>A</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-08T17:00:00</Finish><Duration>PT36H0M0S</Duration></Task>
    <Task><UID>2</UID><ID>2</ID><Name>B</Name><Start>2026-01-09T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish><Duration>PT9H0M0S</Duration>
    <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><LinkLag>${lag}</LinkLag><LagFormat>${fmt}</LagFormat></PredecessorLink></Task></Tasks></Project>`;

  test('percent formats parse to lagPercent (LinkLag is the percentage)', () => {
    const l = parseMspdi(xml(50, 19)).project.links[0];
    expect(l).toMatchObject({ lagPercent: 50 });
    expect(l?.lagElapsed).toBeUndefined();
    expect(parseMspdi(xml(50, 20)).project.links[0]).toMatchObject({
      lagPercent: 50,
      lagElapsed: true,
    });
  });

  test('elapsed formats parse to lagElapsed with minutes from tenths', () => {
    expect(parseMspdi(xml(28800, 8)).project.links[0]).toMatchObject({
      lag: 2880,
      lagElapsed: true,
    });
    expect(parseMspdi(xml(28800, 7)).project.links[0]?.lagElapsed).toBeUndefined();
  });

  test('estimated variants (MPXJ 16.4 reader): 51/52 = %/e%, 36–44 = elapsed', () => {
    expect(parseMspdi(xml(500, 51)).project.links[0]).toMatchObject({ lag: 0, lagPercent: 500 });
    expect(parseMspdi(xml(500, 52)).project.links[0]).toMatchObject({
      lagPercent: 500,
      lagElapsed: true,
    });
    for (const fmt of [36, 38, 40, 42, 44]) {
      expect(parseMspdi(xml(28800, fmt)).project.links[0]).toMatchObject({
        lag: 2880,
        lagElapsed: true,
      });
    }
  });

  test('round-trip: percent and elapsed survive serialize → parse', () => {
    const p = project([
      { id: 'p', source: 'a', target: 'b', type: 'FS', lag: 0, lagPercent: 25 },
      { id: 'e', source: 'a', target: 'b', type: 'SS', lag: 1440, lagElapsed: true },
    ]);
    const out = serializeMspdi(p);
    expect(out).toMatch(/<LinkLag>25<\/LinkLag>\s*<LagFormat>19<\/LagFormat>/);
    const back = parseMspdi(out).project.links;
    expect(back.find((l) => l.type === 'FS')).toMatchObject({ lagPercent: 25 });
    expect(back.find((l) => l.type === 'SS')).toMatchObject({ lag: 1440, lagElapsed: true });
  });
});

describe('percent / elapsed lag downstream', () => {
  test('checkSchedule counts a negative percent lag as a lead and a positive one as a lag', async () => {
    const { checkSchedule } = await import('./quality');
    const p = project(
      [
        { id: 'lead', source: 'a', target: 'b', type: 'SS', lag: 0, lagPercent: -10 },
        { id: 'lag', source: 'b', target: 'c', type: 'FS', lag: 0, lagPercent: 10 },
      ],
      [t('a', 4), t('b', 2), t('c', 1)],
    );
    const r = checkSchedule(p);
    expect(r.checks.find((c) => c.id === 'leads')?.linkIds).toEqual(['lead']);
    expect(r.checks.find((c) => c.id === 'lags')?.linkIds).toEqual(['lag']);
  });

  test('compareSchedules reports lagPercent and lagElapsed changes', async () => {
    const { compareSchedules } = await import('./compare');
    const b0 = project([{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 1440 }]);
    const b1 = project([
      { id: 'l', source: 'a', target: 'b', type: 'FS', lag: 1440, lagElapsed: true },
    ]);
    expect(compareSchedules(b0, b1).links[0]?.changes?.lagElapsed).toEqual({
      from: false,
      to: true,
    });
  });
});

describe('lag review fixes', () => {
  const h24: Calendar = {
    id: '24',
    name: '24h',
    workWeek: Array(7).fill([{ startMinutes: 0, endMinutes: 1440 }]),
    exceptions: [],
  };
  const withCals = (p: Project, cals: Calendar[]) => ({ ...p, calendars: [std, ...cals] });

  test('FF + elapsed lag landing in non-working time: finish at the end of the previous working period, float consistent', () => {
    // A ends Thu 8 17:00; FF +48h elapsed → Sat 10 17:00. No working time lies
    // between Fri 17:00 and Sat 17:00, so B finishes Fri 9 17:00 — the same
    // reading as an FNET dated Saturday. A can slip to Fri 17:00 (→ Sun 17:00)
    // without moving B: one day of float, not negative.
    const p = project([
      { id: 'l', source: 'a', target: 'b', type: 'FF', lag: 2880, lagElapsed: true },
    ]);
    const s = schedule(p);
    const b = s.tasks.find((x) => x.id === 'b')?.computed;
    expect(b?.earlyStart).toEqual(d(9));
    expect(s.tasks.find((x) => x.id === 'a')?.computed?.totalSlack).toBe(DAY);
    const slipped = schedule({
      ...p,
      tasks: p.tasks.map((x) =>
        x.id === 'a' ? { ...x, constraint: { type: 'SNET' as const, date: d(6) } } : x,
      ),
    });
    expect(slipped.tasks.find((x) => x.id === 'b')?.computed?.earlyStart).toEqual(d(9));
  });

  test('elapsed lag out of a milestone at a period end counts from 17:00', () => {
    // m (milestone) → b FS +12h elapsed. m sits at a's finish, Mon 17:00 (MS
    // Project), so the wall-clock lag runs from there.
    const p = project(
      [
        { id: 'l1', source: 'a', target: 'm', type: 'FS', lag: 0 },
        { id: 'l2', source: 'm', target: 'b', type: 'FS', lag: 720, lagElapsed: true },
      ],
      [t('a', 1), t('m', 0), t('b', 1)],
    );
    const s = schedule(p).tasks;
    const m = s.find((x) => x.id === 'm')?.computed;
    // a Mon 5; m Mon 17:00; +12h → Tue 05:00 → b Tue 6 08:00 (critical).
    // Latest: b LS Tue 08:00 − 12h = Mon 20:00, where m can sit (a milestone
    // is never snapped); no working time lies between, so m is critical.
    expect(m?.earlyStart).toEqual(new Date(2026, 0, 5, 17));
    expect(s.find((x) => x.id === 'b')?.computed?.earlyStart).toEqual(d(6));
    expect(m?.lateStart).toEqual(new Date(2026, 0, 5, 20));
    expect(m?.isCritical).toBe(true);
  });

  test('elapsed lag from a 24 h task into a std task: no spurious float', () => {
    // A (24h) Fri 9 8:00 + 24h = Sat 10 8:00; FS +24h elapsed → B Mon 12 8:00.
    // A could finish as late as Sun 11 8:00 (+24h = Mon 8:00): float 24 h on A's calendar.
    const tasks = [
      {
        ...t('a', 0),
        duration: 1440,
        calendarId: '24',
        constraint: { type: 'SNET' as const, date: d(9) },
      },
      t('b', 1),
    ];
    const p = withCals(
      project(
        [{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 1440, lagElapsed: true }],
        tasks,
      ),
      [h24],
    );
    const a = schedule(p).tasks.find((x) => x.id === 'a')?.computed;
    expect(a?.lateFinish).toEqual(new Date(2026, 0, 11, 8));
  });

  test('percent lag under a status date uses the full predecessor duration everywhere', () => {
    const p = {
      ...project(
        [{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 0, lagPercent: 50 }],
        [{ ...t('a', 4), actualStart: d(5), progress: 50 }, t('b', 1)],
      ),
      statusDate: d(7),
    };
    const s = schedule(p);
    expect(s.tasks.find((x) => x.id === 'b')?.computed?.isCritical).toBe(true);
    expect(s.tasks.find((x) => x.id === 'a')?.computed?.totalSlack).toBe(0);
  });

  test('fuzz: elapsed / percent lags never yield negative float; on one calendar, float is exact', () => {
    const cals = [std, h24];
    let seed = 5;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const types: Link['type'][] = ['FS', 'SS', 'FF', 'SF'];
    for (let n = 0; n < 400; n++) {
      const tasks = Array.from({ length: 6 }, (_, i) => ({
        ...t(`t${i}`, 0),
        duration: Math.floor(rnd() * 4) * 540,
        calendarId: cals[Math.floor(rnd() * 2)]?.id,
      }));
      const links: Link[] = [];
      for (let i = 1; i < 6; i++) {
        const src = Math.floor(rnd() * i);
        const elapsed = rnd() < 0.5;
        const pct = rnd() < 0.3;
        links.push({
          id: `l${i}`,
          source: `t${src}`,
          target: `t${i}`,
          type: types[Math.floor(rnd() * 4)] ?? 'FS',
          lag: Math.floor(rnd() * 3) * 720,
          ...(elapsed ? { lagElapsed: true } : {}),
          ...(pct ? { lagPercent: Math.floor(rnd() * 100) } : {}),
        });
      }
      const s = schedule({ ...project(links, tasks), calendars: cals });
      for (const task of s.tasks) {
        expect(task.computed?.totalSlack ?? 0, `case ${n} ${task.id}`).toBeGreaterThanOrEqual(
          -1e-6,
        );
      }
      // One calendar: slipping any task by exactly its float leaves every
      // finish where it was; an hour more moves one (a minute can land on a
      // period end and be absorbed). (Mixed calendars have
      // a pre-existing boundary imprecision with plain lags too — out of scope.)
      const one = tasks.map((x) => ({ ...x, calendarId: undefined }));
      const base = schedule({ ...project(links, one), calendars: cals });
      const lastFinish = (p: Project) =>
        Math.max(...p.tasks.map((x) => x.computed?.earlyFinish?.getTime() ?? 0));
      const f0 = lastFinish(base);
      const moved = (p: Project) =>
        p.tasks.some(
          (x) =>
            x.computed?.earlyFinish &&
            workingMinutesBetween(new Date(f0), x.computed.earlyFinish, std) > 0,
        );
      for (const task of base.tasks) {
        const float = task.computed?.totalSlack ?? 0;
        for (const [extra, expected] of [
          [0, false],
          [60, true],
        ] as const) {
          const date = addWorkingMinutes(task.computed?.earlyStart ?? d(5), float + extra, std);
          const slipped = schedule({
            ...project(
              links,
              one.map((x) =>
                x.id === task.id ? { ...x, constraint: { type: 'SNET' as const, date } } : x,
              ),
            ),
            calendars: cals,
          });
          expect(moved(slipped), `case ${n} ${task.id} +${float}+${extra}`).toBe(expected);
        }
      }
    }
  }, 15_000); // ~2 s alone; the 5 s default trips under a parallel full run
});
