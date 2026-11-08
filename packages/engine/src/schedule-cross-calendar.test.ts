import { describe, expect, test } from 'vitest';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';
import { addWorkingMinutes, workingMinutesBetween } from './working-time';

// Total float across calendars (ADR-011): a task's float is exactly how far it
// can slip without moving the project finish. Mixing calendars used to
// overstate it at working-time boundaries — Fri 17:00 ≡ Mon 08:00 on a
// Mon–Fri calendar, but not to a 24/7 (or elapsed) successor:
//  - a source's latest START handed across calendars must be a start the
//    forward pass can produce (the last working minute, not the period end);
//  - a lead counted back in another calendar than the successor's own that
//    lands on an interval start is that calendar's previous interval end.

const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const lunch: Calendar = {
  id: 'lunch',
  name: 'Split shift, 6 days',
  workWeek: [
    [],
    ...Array(6).fill([
      { startMinutes: 420, endMinutes: 720 },
      { startMinutes: 780, endMinutes: 1080 },
    ]),
  ],
  exceptions: [],
};
const h24: Calendar = {
  id: '24',
  name: '24h',
  workWeek: Array(7).fill([{ startMinutes: 0, endMinutes: 1440 }]),
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);

describe('a hand-over across calendars', () => {
  test('a std milestone driving a 24h task: its latest start is where it can sit, unsnapped', () => {
    // a (std, Mon–Tue) → m (std milestone) —SS +18h (24h)→ z (24h, 36h). A
    // longer std task sets the project end at Mon 12 17:00, so z's latest start
    // is Sun 11 05:00 and m's latest start 18h earlier, Sat 10 11:00. A
    // milestone is never snapped (MS Project, desktop runs 7 and 9), so m's
    // latest is Sat 10 11:00, not Mon 08:00, which would be 63 h later for z.
    // Its float is the same as from Fri 17:00: Wed–Fri, 3 std days.
    const p: Project = {
      start: d(5),
      defaultCalendarId: 'std',
      tasks: [
        {
          id: 'a',
          text: 'a',
          type: 'task',
          scheduleMode: 'auto',
          duration: 1080,
          start: d(5),
          end: d(5),
          progress: 0,
        },
        {
          id: 'm',
          text: 'm',
          type: 'milestone',
          scheduleMode: 'auto',
          duration: 0,
          start: d(5),
          end: d(5),
          progress: 0,
        },
        {
          id: 'z',
          text: 'z',
          type: 'task',
          scheduleMode: 'auto',
          duration: 2160,
          start: d(5),
          end: d(5),
          progress: 0,
          calendarId: '24',
        },
        {
          id: 'long',
          text: 'long',
          type: 'task',
          scheduleMode: 'auto',
          duration: 6 * 540,
          start: d(5),
          end: d(5),
          progress: 0,
        },
      ],
      links: [
        { id: 'l1', source: 'a', target: 'm', type: 'FS', lag: 0 },
        { id: 'l2', source: 'm', target: 'z', type: 'SS', lag: 1080 },
      ],
      resources: [],
      calendars: [std, lunch, h24],
      baselines: [],
      assignments: [],
    };
    const m = schedule(p).tasks.find((x) => x.id === 'm')?.computed;
    expect(m?.earlyStart).toEqual(new Date(2026, 0, 6, 17));
    expect(m?.lateStart).toEqual(new Date(2026, 0, 10, 11));
    expect(m?.totalSlack).toBe(3 * 540);
  });
});

describe('total float across calendars is exact (slip-by-float)', () => {
  test('std / split-shift / 24h / elapsed tasks, all link types, leads and elapsed lags', () => {
    let seed = 41;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const types: Link['type'][] = ['FS', 'SS', 'FF', 'SF'];
    const lags = [-540, -300, 0, 300, 540];
    let checks = 0;
    for (let n = 0; n < 60; n++) {
      const tasks: Task[] = Array.from({ length: 7 }, (_, i) => {
        const pick = rnd();
        const extra: Partial<Task> =
          pick < 0.25
            ? { calendarId: 'lunch' }
            : pick < 0.45
              ? { durationElapsed: true }
              : pick < 0.6
                ? { calendarId: '24' }
                : {};
        return {
          id: `t${i}`,
          text: `t${i}`,
          type: 'task',
          scheduleMode: 'auto',
          duration: Math.floor(rnd() * 4) * 540,
          start: d(5),
          end: d(5),
          progress: 0,
          ...extra,
        };
      });
      const links: Link[] = [];
      for (let i = 1; i < 7; i++) {
        links.push({
          id: `l${i}`,
          source: `t${Math.floor(rnd() * i)}`,
          target: `t${i}`,
          type: types[Math.floor(rnd() * 4)] ?? 'FS',
          lag: lags[Math.floor(rnd() * lags.length)] ?? 0,
          ...(rnd() < 0.25 ? { lagElapsed: true } : {}),
        });
      }
      const project = (ts: Task[]): Project => ({
        start: d(5),
        defaultCalendarId: 'std',
        tasks: ts,
        links,
        resources: [],
        calendars: [std, lunch, h24],
        baselines: [],
        assignments: [],
      });
      const own = (x: Task): Calendar =>
        x.durationElapsed || x.calendarId === '24' ? h24 : x.calendarId === 'lunch' ? lunch : std;
      const base = schedule(project(tasks));
      const end = Math.max(...base.tasks.map((x) => x.computed?.earlyFinish.getTime() ?? 0));
      const moved = (p: Project) =>
        p.tasks.some((x) => {
          const f = x.computed?.earlyFinish;
          return !!f && f.getTime() > end && workingMinutesBetween(new Date(end), f, own(x)) > 0;
        });
      for (const task of base.tasks) {
        const float = task.computed?.totalSlack ?? 0;
        expect(float, `case ${n} ${task.id}`).toBeGreaterThanOrEqual(0);
        for (const [extra, expected] of [
          [0, false],
          [60, true],
        ] as const) {
          const date = addWorkingMinutes(
            task.computed?.earlyStart ?? d(5),
            float + extra,
            own(task),
          );
          const slipped = schedule(
            project(
              tasks.map((x) =>
                x.id === task.id ? { ...x, constraint: { type: 'SNET' as const, date } } : x,
              ),
            ),
          );
          checks++;
          expect(moved(slipped), `case ${n} ${task.id} +${float}+${extra}`).toBe(expected);
        }
      }
    }
    expect(checks).toBe(60 * 7 * 2);
  });
});
